/**
 * 故事导演 · Story Director
 *
 * 一个挂在**任意 MVU 角色卡**上的剧情推进插件：把「接下来该演什么」交给
 * **故事神谕（story-oracle）**去设计，插件负责调度与落拍。
 *
 * 三条线，各有节奏：
 *   · 主线 —— 一条按章推进的长线。神谕定章（4~6 拍），正文一拍一拍演；
 *             拍真的落进正文后正文模型写变量回报，插件自动换拍、换章，
 *             章目标达成后请神谕按**当前情况**设计下一章（弧线可以跨很多章）。
 *   · 支线 —— 并行的短支线：进入点 + 落点，一两拍就收，插件按「每 N 轮」续上新的。
 *   · 插曲 —— 幕间小段（日常 / 误会 / 闲话 / 旧事）：不推主线，只做呼吸感与埋线，
 *             接在某一拍之后才出现，演完即走。
 *
 * 全部状态写在 `stat_data.故事导演` 命名空间下，不碰角色卡自己的变量；
 * 规则文本在插件自带的世界书「故事导演」里（缺失时自动安装）。
 */

import { extension_settings } from '../../../extensions.js';
import {
    eventSource, event_types, saveSettingsDebounced, saveSettings,
    setExtensionPrompt, extension_prompt_types, extension_prompt_roles,
    chat, updateMessageBlock, saveChatDebounced,
} from '../../../../script.js';
import {
    world_names, selected_world_info, world_info, onWorldInfoChange, updateWorldInfoList, loadWorldInfo, saveWorldInfo,
} from '../../../world-info.js';
import {
    NS, PATH, THREAD_FIELDS, INTERLUDE_FIELDS, MAIN_TITLE, MAIN_ARC, MAIN_SCOPE, MAIN_GOAL, MAIN_BEATS, MAIN_STARTED, MAIN_ENDED, MAIN_CLOSED,
    INTERLUDE, IL, emptyInterlude, interludeChapterOf, interludeActive, interludeBeatsOf, interludeBeat,
    EPIC, EP, EPIC_STAGES, emptyEpic, epicOf, epicStarted, epicMovements, epicHooks, epicChapter, renderEpicSection, epicFromBlock, epicAskText, userAskText,
    TONES, toneOf, toneOptions, toneDirective,
    KEY_BEAT, KEY_BEAT_DONE, KEY_CHAPTER_DONE, KEY_READY, KEY_REVIEW, KEY_REVIEW_NOTE,
    REVIEW_PASS, REVIEW_STATES, REVIEW_MAX_RETRY,
    STATUS_PENDING, STATUS_ACTIVE, STATUS_DONE, STATUS_SKIPPED, STATUS_STALLED,
    isPlainObject, unwrap, unwrapDeep, display, toNumber, truthy,
    capText, splitBeats, beatsOf, parseBlocks,
    emptyMain, mainOf, listOf, currentBeat, reviewStateOf, reviewNoteOf,
    isLiveThread, threadLanded, interludePending, interludeAfter,
    nextId, takenTitles, completedMainTitles,
    renderMainSection, renderThreadsSection, renderInterludeSection, renderContractSection, renderInjectionHeader,
    renderInterludeChapterSection,
    chapterFromBlock, threadFromBlock, interludeFromBlock, interludeChapterFromBlock,
    applyNsCommands, extractNsCommands, worldbookDigest, setInterludeWritesAllowed, beatOrderSkipsRead,
    mergeBeats, remainingBeatBudget, worldbookUpdateDecision,
} from './model.js';

const ID = 'story-director';
const PLUGIN_WORLD = '故事导演';
const SCHEMA_VERSION = 1;

/** 我们自己的四个注入槽。故事神谕的引导用 'story_oracle_plan'，别的扩展也用各自的名字，互不占用。 */
const SLOT = {
    main: 'story-director-main',
    threads: 'story-director-threads',
    interludes: 'story-director-interludes',
    contract: 'story-director-contract',
};
/**
 * 与原版「故事神谕」的**能力探测**结果（只探测它真的提供了什么，不看版本号）。
 * 为什么需要：SO_API_VERSION 只在**破坏性**改动时才 +1，所以「版本号够」不代表「这些方法都在」——
 * 神谕各版本是逐个长出来的（context / guidance / registerMode）。缺哪个就说缺哪个，
 * 否则用户只会看到「剧情不生成 / 设定没读到」这种无头案。
 */
const oracleCaps = {
    present: false,      // 有没有挂出 window.StoryOracleAPI
    run: false,          // 裸模型调用（必需）
    context: false,      // 上下文构建器
    worldInfo: null,     // 取世界书设定（null = 还没试过）
    transcript: false,   // 取近期对话（必需）
    guidance: false,     // 读神谕自己的引导（可选，只有它才需要）
    registerMode: false, // 在神谕窗口里注册「故事导演」模式（可选）
    addMessageAction: false, // 给神谕回复挂按钮（可选）
    // ⚠ 这里**刻意不探测 appendReply**：本插件绝不往神谕窗口（对话）里写任何东西 —— 见 askOracle 里的事故注释。
    //   把它列成「能力」会被误读成「缺了什么」，而它其实是主动不用的东西。
};

function probeOracleCaps() {
    const api = window.StoryOracleAPI;
    oracleCaps.present = !!api;
    oracleCaps.run = typeof api?.run === 'function';
    oracleCaps.context = !!api?.context;
    oracleCaps.transcript = typeof api?.context?.buildTranscript === 'function';
    oracleCaps.guidance = typeof api?.guidance?.getActive === 'function';
    oracleCaps.registerMode = typeof api?.registerMode === 'function';
    oracleCaps.addMessageAction = typeof api?.addMessageAction === 'function';
    // 不探测 appendReply：我们不用它（绝不往神谕窗口写东西）。
    if (typeof api?.context?.buildWorldInfo !== 'function') oracleCaps.worldInfo = false;
    return oracleCaps;
}

/** 兼容性结论：缺了什么、会怎样、怎么办。 */
function oracleCompatReport() {
    probeOracleCaps();
    const missing = [];
    if (!oracleCaps.present) missing.push('整个接口都没挂出来（window.StoryOracleAPI）——故事神谕没装、没启用，或版本太老（Hook API 是 1.21 起才有的）');
    else if (!oracleCaps.run) missing.push('run()：拿不到模型连接，插件无法生成任何剧情');
    if (oracleCaps.present && !oracleCaps.transcript) missing.push('context.buildTranscript()：读不到最近对话，生成会瞎编');
    if (oracleCaps.present && oracleCaps.worldInfo === false) missing.push('context.buildWorldInfo()：读不到角色卡/世界书设定（版本太老），生成时少一层依据');
    if (oracleCaps.present && !oracleCaps.guidance) missing.push('guidance.getActive()：读不到神谕自己的剧情引导（1.78 起才有）——只用它来避免两边顶牛，缺了不影响主流程');
    if (oracleCaps.present && !oracleCaps.registerMode) missing.push('registerMode()：无法在神谕窗口里加「故事导演」模式（1.21 起才有）');
    if (oracleCaps.present && !oracleCaps.addMessageAction) missing.push('addMessageAction()：神谕回复下方不会有「采用为本故事的下一章」按钮');
    const fatal = !oracleCaps.present || !oracleCaps.run;
    return { caps: { ...oracleCaps }, missing, ok: !missing.length, fatal };
}

const ORACLE_MODE_ID = 'story-director';
const ORACLE_ACTION_ID = 'story-director-adopt';

/** MVU 每轮更新完变量后，先等它自己把这一楼写回，再让我们去读改写。 */
const AFTER_MVU_DELAY = 1500;
/** MVU 的 MESSAGE_RECEIVED 入口有 3s throttle，兜底路径必须晚于它。 */
const AFTER_MESSAGE_DELAY = 4000;
/** 一章/一条支线的拍数上限（防止模型把整本书塞进一章）。 */
const BEAT_MAX = 6;
const BEAT_MIN = 3;
/**
 * ★ 同一拍连着注入几轮之后，就往注入里加一句「别再重复同一场景 / 同一句台词」。
 *
 * 为什么需要：推进到下一拍的唯一依据是**正文模型回报 `本拍已落 = true`**。
 * 它忘了写（很常见：注意力在正文上），`当前拍` 就停在原地，于是下一轮的注入块
 * 和上一轮几乎**一字不差** —— 提示词如此相似，模型写出高度相似的话是可预期的。
 * 这条是给那种情形兜底的；真正治本的是正文模型按契约回报。
 */
const FOCUS_STALE_REPLIES = 2;

/**
 * ★ 合理性审查的升级梯（见 handleBeatReview）。
 *
 *  ①「重排剩下的拍」：拍级、便宜，已演过的拍一字不动。最多试 REDESIGN_MAX_L1 次。
 *  ② 仍然报错 → **废掉这一章重建**（章级）：不再保留已演的拍 —— 因为病在「这一章的设计」上。
 *     （会保留段落级的历史，确保不重复已讲过的内容）
 *  ③ 再报错 → 请神谕**重设篇章这一段**（说明是长线方向立不住），然后重建这一章。
 *
 * 这道梯子取代了原来的「试满 N 次就永远停手」—— 那个做法会把故事卡在一个立不住的章上。
 */
const REDESIGN_MAX_L1 = 2;   // ①级最多试几次
const REDESIGN_MAX_L2 = 2;   // ②级最多试几次，之后升到③

/** 注入的状态块标签：被模型抄进正文时按它做确定性剥离。 */
const STATUS_TAG = 'story_director_status';

const INTENSITIES = {
    seed: {
        label: '只铺垫',
        caption: '只埋伏笔与暗示，本拍的事件暂不正面发生',
        directive: '只埋伏笔与暗示（异样的细节、巧合、欲言又止），本拍的事件暂不正面发生。',
    },
    normal: {
        label: '自然推进',
        caption: '每个场景让事态朝本拍目标靠近一小步',
        directive: '每个场景让事态朝本拍的目标靠近一小步，铺垫成熟时自然引发。',
    },
    push: {
        label: '尽快引爆',
        caption: '接下来一两个场景内让本拍事件正面发生',
        directive: '在接下来一至两个场景内让本拍的事件正面发生；仍须立足于已有铺垫。',
    },
};

const BOOK_MODES = {
    full: { label: '全部（规则 + 变量 + 写作纪律）' },
    lite: { label: '精简（只留规则 + 变量契约）' },
    vars: { label: '只有变量契约' },
};

const ORACLE_WORLDINFO_MODES = {
    char: { label: '角色卡 / 对话绑定的世界书（默认）', forceMode: 'char' },
    st: { label: '所有已挂载的世界书', forceMode: 'st' },
    off: { label: '不带世界书设定', forceMode: 'off' },
};

// 阶段一：设置

const DEFAULT = {
    enabled: true,
    schema: SCHEMA_VERSION,
    tab: 'now',
    bubbleX: null,
    bubbleY: null,
    winX: null,
    winY: null,
    bubbleIcon: '',
    bubbleSize: 52,

    /** 自动化总闸。关掉＝只手动生成与采用，插件不自己推进也不自己开新线。 */
    autoDirector: true,
    /** 换拍：当前拍落了就自动进入下一拍。 */
    autoBeat: true,
    /** 换章：章目标达成且场景收尾后自动请神谕开下一章。 */
    autoChapter: true,
    /** 自动续支线：每 threadEvery 轮给一条新的短支线。 */
    autoThread: true,
    /** 自动插曲：那些不占「幕」的随机小段（与「间章」是两回事）。 */
    autoInterlude: true,
    /**
     * 主线的间隙交给「间章」：一章收尾 + 余波之后，自动开一段间章，而不是让场子空着。
     * 间章是日常的、**不必跑完**的幕 —— 演够了就随时回主线。
     */
    autoInterludeChapter: true,
    /** 开间章前还要等几轮（一般是「余波」已经写完）。 */
    interludeGap: 3,
    /** 一段间章最多几拍（日常用不着多）。 */
    interludeBeats: 3,
    /** 每次自动生成都可用的人工审校开关。 */
    /** 拍重新设计的开关（正文模型报「调整 / 驳回」时）。 */
    autoRedesign: true,

    threadEvery: 10,
    interludeEvery: 10,
    /**
     * 三道「别让玩家应接不暇」的闸门（都按 AI 回复数记账，不看墙钟）：
     *   · autoCooldown —— 任意两次自动生成之间至少要隔几轮（跨线生效，防止支线+插曲同一轮一起冒出来）；
     *   · chapterGap   —— 上一章收尾之后，至少过几轮才允许开下一章（留出「余波」的时间）；
     *   · threadWarmup —— 新章开头这几轮先只推主线，别急着往里面插支线。
     */
    autoCooldown: 3,
    chapterGap: 4,
    threadWarmup: 3,
    /** 一拍至少演多少轮才允许换拍（防连跳）。 */
    minReplies: 1,    /**
     * 合理性审查的升级梯（见 handleBeatReview）：
     *   · 第①级「重排剩下的拍」最多试这么多次；
     *   · 仍然报错 → 第②级**废掉这一章**重建（可能连续两次）；
     *   · 再报错 → 第③级请神谕**重设篇章这一段**（说明这个方向真的立不住），然后重建这一章。
     * ⚠ 刻意**不是**「试满就永远停手」：那样反而会卡在一个立不住的章上不动。
     *   节流靠两道：级内次数上限 + 两次重设计之间至少隔 `redesignGap` 轮。
     */
    redesignMax: REDESIGN_MAX_L1,
    /** 两次「重设计」之间至少隔几轮（防连着重生成，烧 token 也把剧情搅乱）。 */
    redesignGap: 3,

    /** 注入开关。 */
    injectMain: true,
    injectThreads: true,
    injectInterludes: true,
    injectContract: true,
    /**
     * 强制「不安排 {{user}} 的行为」。**默认必须开着**：
     * 剧情该由「世界里发生了什么 + 别人的行动 + 伏笔」推动，而不是替玩家安排他要去做什么。
     * 关掉之后注入里关于这条的硬约束全部消失（只留「不许无中生有」那些），代价自负。
     */
    banUserAction: true,
    injectDepth: 4,
    maxThreads: 2,
    maxInterludes: 1,

    /** 生成用的上下文。 */
    intensity: 'normal',
    beatTarget: 4,
    /**
     * 史诗（篇章）：先定一条**围绕 {{user}}** 的长线，章只是它的一拍 —— 主线不平淡的关键。
     * autoEpic=true 时会在开第一章之前自动定篇章；之后每开新章前自动按「他实际做了什么」重新校准。
     */
    autoEpic: true,
    /** 每开新章前重新校准篇章（多花一次调用，但能跟住玩家的偏离）。 */
    evolveEpic: true,
    /** 基调：由用户在下拉里选（冒险 / 日常 / 悬疑……），决定这条长线是什么型的故事。 */
    tone: 'auto',
    storyTranscript: true,
    oracleWorldInfo: 'char',
    /** 给神谕的近期对话上限（字符）。 */
    transcriptLimit: 12000,

    /** 世界书。 */
    bookMode: 'full',
    autoInstallBook: true,
    /**
     * ★ 自带世界书的**内容**更新时自动重装。
     *
     * 为什么需要：插件原来只在「世界书缺失」时才安装 —— 我们自己改了世界书（加纪律、改变量契约），
     * 已经装过的人**永远拿不到新内容**，只能靠人手动点「安装／重装」。
     * 开这个之后会拿带版本标记的那份比对，发现旧了就自动更新（**旧内容先备份**，不动用户原有的书）。
     */
    autoUpdateBook: true,
    autoMountBook: true,

    /** 运行游标（每个聊天一份切片，随聊天切换）。 */
    run: {
        chatId: '',
        /**
         * 当前是哪种「幕」：'main' = 主线章，'interlude' = 间章。
         * ⚠ 真正的判据是 MVU 里的 `间章.进行中`（见 currentMode()，切换聊天天然正确）；
         * 这里这份只是给人看的 / 老存档兼容，不参与判断。
         */
        mode: 'main',
        /**
         * 插件**上一次聚焦**的拍号。
         * 模型会把 `当前拍` 提前写成 N+1（世界书与注入都是这么要求的），所以换拍时不能拿库里那个值
         * 当基准 —— 否则 `beat` 已经是 N+1，再加一就变成 N+2，整章会隔一拍跳一拍。
         */
        focusBeat: 0,
        /** 间章里插件上一次聚焦的拍号（与主线各自独立）。 */
        focusInterlude: 0,
        /**
         * ★ 当前这一拍是**从第几轮开始**连续注入的（AI 回复数）。
         * 换拍时重置。用来判断「同一拍是不是已经连着演了好几轮而没落地」——
         * 那种情况下注入块会和上一轮几乎一样，模型很容易复读（见 buildInjection 里的叮嘱）。
         */
        focusBeatSince: 0,
        /** ★ 上面那种「同一拍卡住」时给注入用的一句话；换拍 / 正常时为空串。 */
        focusStale: '',
        /**
         * ★ 用户钉住的要求（「记住它，每轮都带上」）。
         *
         * 为什么要钉：用户手动生成时填的要求，**原来在插件自己触发的任何重生成里都会消失** ——
         * 审查重排（keep=played 那条）、②/③级废章重建、自动换章，全都没带 userText。
         * 于是「审查把它打回重写」= 用户白写一遍。钉住之后，这些路径自动带上同一份要求。
         *
         * 生命周期：
         *   · epicPin  —— 跟**这一部篇章**走；换一部（重新定篇章）或手动清掉才失效；
         *   · chapterPin —— 跟**这一章**走；章名一变就自动清（下一章不该继承上一章的要求）。
         */
        epicPin: '',
        chapterPin: '',
        chapterPinFor: '',
        /** 上一次换拍时的 AI 回复数。 */
        beatAt: 0,
        /** 本章开始时的 AI 回复数（只在真的开出一章时写）。 */
        chapterOpenedAt: 0,
        /**
         * 上一次「这一幕收尾」的时刻（主线章或间章收掉时写）。
         * ⚠ 与 chapterOpenedAt 是**两个时钟**：余波窗 / 开间章都从这一刻起算。
         * 以前两者共用一个字段，导致「篇章校准」会把余波窗口重新计时 —— 那正是「拍演完了却不换章」的元凶。
         */
        aftermathAt: 0,
        /** 上一次生成支线时的回复数。 */
        threadAt: 0,
        /** 上一次生成插曲时的回复数。 */
        interludeAt: 0,
        /** 上一次生成 / 校准史诗（篇章）时的回复数。 */
        epicAt: 0,
        /** 上一次篇章的进程快照（面板显示用）。 */
        epicStage: '',
        /** 本聊天里「定篇章 / 校准」已经试过几次：超过上限就放行开章，不让它把整个插件卡住。 */
        epicTries: 0,
        /** 连续被驳回的次数。 */
        redesigns: 0,
        /**
         * ★ 合理性审查升级梯的记账（见 handleBeatReview）：
         *   redesignFor —— 上面那个计数是**哪一章**的（换章清零，所以每章额度独立）；
         *   redesignsL2  —— 已经走到②级（废章重建）几次；
         *   redesignAt   —— 上一次重设计的轮数（节流用；回退聊天后由 repairRunCursors 兜住）。
         */
        redesignFor: '',
        redesignsL2: 0,
        redesignAt: 0,
        /** 上一段间章的标题（防重复用；间章本身不留在注入里）。 */
        lastInterlude: '',
        /**
         * 已经为「哪一幕」记过账的标记：值 = 已收尾的主线章标题，或 `间章:<标题>`。
         * 用它而不是布尔 latch：一旦新章开出来值就对不上了，自动放行；
         * 而且**在冷却检查通过之前绝不写它**（否则卡在冷却里就永远不再尝试）。
         */
        closedChapter: '',
        /** 上一次**任何**自动生成发生在第几条 AI 回复（跨线节流用；0 = 还没生成过）。 */
        lastGenerateAt: 0,
    },
    chapters: {},
};

function defaults() {
    return JSON.parse(JSON.stringify(DEFAULT));
}

// 阶段二：持久化 / 聊天切片

function store() {
    if (!isPlainObject(extension_settings[ID])) extension_settings[ID] = defaults();
    const box = extension_settings[ID];
    for (const [key, value] of Object.entries(DEFAULT)) {
        if (!(key in box)) box[key] = JSON.parse(JSON.stringify(value));
    }
    if (!isPlainObject(box.run)) box.run = JSON.parse(JSON.stringify(DEFAULT.run));
    if (!isPlainObject(box.chapters)) box.chapters = {};
    box.schema = SCHEMA_VERSION;
    return box;
}

function settings() {
    const box = store();
    ensureChatSlice(box);
    return box;
}

const save = () => saveSettingsDebounced();

function chatKey() {
    try {
        const ctx = window.SillyTavern?.getContext?.();
        if (!ctx) return '';
        const id = (typeof ctx.getCurrentChatId === 'function' && ctx.getCurrentChatId()) || ctx.chatId || '';
        return `${ctx.groupId || ''}::${id}`;
    } catch { return ''; }
}

function aiMessageCount() {
    try {
        const ctx = window.SillyTavern?.getContext?.();
        return (ctx?.chat || []).filter((m) => m && !m.is_user && !m.is_system).length;
    } catch { return 0; }
}

/**
 * 每份「随聊天走」的插件状态：运行游标 + 章节史（跨刷新不丢、绝不串台）。
 * 模型侧的剧情状态住在 MVU 里，这里只放插件自己的记账。
 */
const CHAT_SLICE_KEYS = ['run', 'chapters'];

function sliceFromSettings(s) {
    const out = {};
    for (const key of CHAT_SLICE_KEYS) out[key] = s[key];
    return JSON.parse(JSON.stringify(out));
}

function applySliceToSettings(s, slice) {
    const fresh = JSON.parse(JSON.stringify(DEFAULT));
    for (const key of CHAT_SLICE_KEYS) {
        s[key] = isPlainObject(slice?.[key]) ? slice[key] : fresh[key];
    }
    if (!isPlainObject(s.run)) s.run = JSON.parse(JSON.stringify(DEFAULT.run));
    if (!isPlainObject(s.chapters)) s.chapters = {};
}

function ensureChatSlice(s) {
    const key = chatKey();
    if (!key) return false;
    if (s.chatSliceKey === key) return false;
    if (!isPlainObject(s.chats)) s.chats = {};
    if (s.chatSliceKey) s.chats[s.chatSliceKey] = sliceFromSettings(s);
    if (!isPlainObject(s.chats[key])) s.chats[key] = JSON.parse(JSON.stringify({ run: DEFAULT.run, chapters: {} }));
    applySliceToSettings(s, s.chats[key]);
    s.chatSliceKey = key;
    // 只留最近 24 份，免得设置文件无限膨胀
    const keys = Object.keys(s.chats);
    if (keys.length > 24) {
        for (const old of keys.slice(0, keys.length - 24)) delete s.chats[old];
    }
    return true;
}

function persistChatSlice() {
    const s = settings();
    if (!s.chatSliceKey) return false;
    s.chats[s.chatSliceKey] = sliceFromSettings(s);
    save();
    return true;
}

// 阶段三：MVU 数据访问

let mvuApi = null;
const mvu = () => mvuApi || window.Mvu || null;

/** 优先用酒馆助手提供的 waitGlobalInitialized 等 Mvu 就绪，避免插件加载早于 MVU。 */
async function resolveMvu() {
    if (window.Mvu) { mvuApi = window.Mvu; return mvuApi; }
    const helper = window.TavernHelper;
    const wait = helper?.waitGlobalInitialized || helper?._bind?._waitGlobalInitialized;
    if (typeof wait === 'function') {
        try {
            mvuApi = await Promise.race([
                Promise.resolve(wait.call(helper, 'Mvu')),
                new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000)),
            ]);
        } catch { /* MVU 未在超时内就绪，下面再兜一次 */ }
    }
    mvuApi = mvuApi || window.Mvu || null;
    return mvuApi;
}

function mvuData() {
    try { return mvu()?.getMvuData?.({ type: 'message', message_id: 'latest' }) || null; } catch { return null; }
}

/** 取 stat_data（live 优先：MVU 事件回调里那份还没落盘的活变量）。 */
function rootOf(live = null) {
    if (live && isPlainObject(live.stat_data)) return live.stat_data;
    return mvuData()?.stat_data || null;
}

function namespaceOf(root = null) {
    const data = root || rootOf();
    const ns = data && isPlainObject(data[NS]) ? data[NS] : null;
    return ns;
}

/** 主线对象（永远返回一份带默认值的副本）。 */
function mainState(live = null) {
    return mainOf(rootOf(live));
}

function threadsState(live = null) {
    return listOf(rootOf(live), '支线');
}

function interludesState(live = null) {
    return listOf(rootOf(live), '插曲');
}

function liveThreads(live = null) {
    return threadsState(live).filter(isLiveThread);
}

// ---- 间章（与主线互斥的另一幕）----

/** 当前是哪种幕：'main' 主线章 / 'interlude' 间章。以 MVU 里的状态为准，run 只是镜像。 */
function currentMode(live = null) {
    return interludeActive(rootOf(live)) ? 'interlude' : 'main';
}

function runOf() {
    return settings().run;
}

/** 切换幕。切走时把上一幕的脏状态清掉，免得下一段间章 / 下一章继承旧值。 */
async function switchMode(next, { live = null, quiet = false } = {}) {
    const s = settings();
    const want = next === 'interlude' ? 'interlude' : 'main';
    s.run.mode = want;
    save();

    if (want === 'main') {
        // 回主线：把上一段间章收掉、清干净；主线那边允许开新章
        const cleared = emptyInterlude();
        cleared[IL.active] = false;
        await patchInterlude(cleared, { live });
        await patchMain({ [MAIN_CLOSED]: false }, { live });
    } else {
        // 进间章：主线这一章已经在章节史里了，这里只把「已收尾」立起来（注入据此知道主线收着）
        await patchMain({ [MAIN_CLOSED]: true, [KEY_READY]: false }, { live });
    }
    syncMainInjection();
    if (!panel?.hidden) render();
    if (!quiet) toast(want === 'interlude' ? '主线的间隙交给「间章」：这一段演日常。' : '回到主线。', 'success');
    return true;
}

/** 写 `故事导演.间章.*`（整份合并，live 优先）。 */
async function patchInterlude(fields, { live = null } = {}) {
    const apply = (root) => {
        if (!isPlainObject(root[NS])) root[NS] = {};
        if (!isPlainObject(root[NS][INTERLUDE])) root[NS][INTERLUDE] = emptyInterlude();
        Object.assign(root[NS][INTERLUDE], fields);
        if (Array.isArray(fields[IL.beats])) root[NS][INTERLUDE][IL.beats] = fields[IL.beats].slice();
    };
    if (live && isPlainObject(live.stat_data)) { apply(live.stat_data); return true; }
    const api = mvu();
    const d = mvuData();
    if (!api?.replaceMvuData || !isPlainObject(d?.stat_data)) return false;
    apply(d.stat_data);
    try {
        await api.replaceMvuData(d, { type: 'message', message_id: 'latest' });
        return true;
    } catch (error) {
        console.debug('[故事导演] 写入间章失败', error);
        return false;
    }
}

/** 同步「间章时段之外不许写间章变量」这个开关（模型只能在自己那段幕里动它）。 */
function syncInterludeWrites() {
    setInterludeWritesAllowed(currentMode() === 'interlude');
}

// ---- 史诗 / 篇章（围绕 {{user}} 的那条长线）----

/** 写 `故事导演.史诗.*`（整份合并，live 优先）。 */
async function patchEpic(fields, { live = null } = {}) {
    const apply = (root) => {
        if (!isPlainObject(root[NS])) root[NS] = {};
        if (!isPlainObject(root[NS][EPIC])) root[NS][EPIC] = emptyEpic();
        Object.assign(root[NS][EPIC], fields);
        for (const key of [EP.movements, EP.hooks]) {
            if (Array.isArray(fields[key])) root[NS][EPIC][key] = fields[key].slice();
        }
    };
    if (live && isPlainObject(live.stat_data)) { apply(live.stat_data); return true; }
    const api = mvu();
    const d = mvuData();
    if (!api?.replaceMvuData || !isPlainObject(d?.stat_data)) return false;
    apply(d.stat_data);
    try {
        await api.replaceMvuData(d, { type: 'message', message_id: 'latest' });
        return true;
    } catch (error) {
        console.debug('[故事导演] 写入史诗失败', error);
        return false;
    }
}

/** 当前篇章是否需要（重新）生成：没建过，或者还没校准到最新章节。 */
function needsEpic(live = null) {
    const epic = epicOf(rootOf(live));
    if (!epicStarted(epic)) return true;
    if (!settings().evolveEpic) return false;
    // 校准进度落后于「已经走过的章 + 当前这一章」，就要重新校准
    const done = completedMainTitles(rootOf(live)).length;
    return epicChapter(epic) < done;
}

/** 采用一份篇章。 */
async function applyEpic(epic, { live = null, quiet = false, entry = null } = {}) {
    const fields = { ...epic };
    if (entry !== null) fields[EP.chapter] = Math.max(0, Math.round(Number(entry) || 0));
    await patchEpic(fields, { live });
    const s = settings();
    s.run.epicAt = aiMessageCount();
    s.run.epicStage = String(unwrap(fields[EP.stage]) ?? '').trim();
    // 冷却基准**只在生成成功之后**才写：失败不该消耗节流名额（否则后面开章会被挡住）
    markGenerated(s.run, s.run.epicAt);
    s.run.epicTries = 0;                 // 成功即清零：下次还需要校准就重新给机会
    clearPending(`epic:${chatKey()}`);
    save();
    syncMainInjection();
    if (!panel?.hidden) render();
    if (!quiet) {
        toast(entry !== null && entry > 0
            ? `篇章已按他实际做的事重新校准（进程：${String(unwrap(fields[EP.stage]) ?? '—')}）。`
            : `篇章已定：《${String(unwrap(fields[EP.title]) ?? '未命名')}》（进程：${String(unwrap(fields[EP.stage]) ?? '—')}）。`, 'success');
    }
    return true;
}

/** 命名空间字段体检（面板用）。 */
function namespaceReport(ns) {
    if (!ns) return '未初始化';
    const missing = [];
    if (!isPlainObject(ns.主线)) missing.push('主线');
    if (isPlainObject(ns.主线)) {
        if (!beatsOf(ns.主线).length) missing.push('主线.拍');
        if (typeof unwrap(ns.主线[KEY_BEAT]) !== 'number') missing.push('主线.当前拍');
        if (typeof unwrap(ns.主线[KEY_CHAPTER_DONE]) !== 'boolean') missing.push('主线.章目标达成');
        if (typeof unwrap(ns.主线[KEY_READY]) !== 'boolean') missing.push('主线.可进下一章');
    }
    if (!isPlainObject(ns.支线)) missing.push('支线');
    if (!isPlainObject(ns.插曲)) missing.push('插曲');
    return missing.length ? `缺 ${missing.join('、')}` : '就绪';
}

// 阶段四：MVU 写入 + 命令拦截

/**
 * 抢在角色卡自己的 mvu_zod schema 之前，把 `故事导演.*` 的命令自己套用掉。
 *
 * MVU 的顺序是：普通 `COMMAND_PARSED` → `COMMAND_PARSED_for_zod`（卡注册的 mvu_zod 在这里用卡
 * 自己的 zod schema 整份校验；schema 里没有 `故事导演` 这个根键，未知根键会被 strip，于是「只改到
 * 故事导演的命令」在它眼里等于「什么都没变」，被静默丢弃）→ `COMMAND_PARSED_ended_for_zod`
 * （整个命令表清空）。所以我们在第一步就把命令吃掉并摘除，剩下的照旧交给卡处理。
 */
function bindVariableInterception() {
    const handler = (variables, commands) => {
        try {
            if (!variables || !Array.isArray(commands) || !commands.length) return;
            if (!isPlainObject(variables.stat_data)) return;
            const { owned, applied } = applyNsCommands(variables.stat_data, commands);
            if (!owned) return;
            console.info(`[故事导演] 自管变量命令 ${owned} 条（实际改变 ${applied} 条），已从 MVU 命令表摘除`);
            if (applied && panel && !panel.hidden) window.setTimeout(() => render(), 0);
        } catch (error) {
            console.debug('[故事导演] 变量命令拦截失败', error);
        }
    };
    let bound = false;
    try { eventSource?.on?.('mag_command_parsed', handler); bound = true; } catch { /* ignore */ }
    const helper = window.TavernHelper;
    for (const fn of [helper?.eventOn, helper?._bind?._eventOn]) {
        if (typeof fn !== 'function') continue;
        try { fn.call(helper, 'mag_command_parsed', handler); bound = true; } catch { /* ignore */ }
    }
    // 兜底：万一宿主的普通事件没送达（老版本 MVU 只发 _for_zod），也接一次；幂等。
    try { eventSource?.on?.('mag_command_parsed_for_zod', handler); } catch { /* ignore */ }
    interceptionReady = bound;
    return bound;
}

/**
 * 兜底：MVU 说「这一楼处理完了」时，如果拦截器没吃到命令，直接从这一楼正文里现抠我们的命令，
 * 套用到**活变量**上（那一刻改的与 MVU 同源、不会被覆盖）。跳过 `_.add`，重放增量会翻倍。
 */
function reconcileFromLatestMessage(live) {
    try {
        const root = live && isPlainObject(live.stat_data) ? live.stat_data : rootOf();
        if (!isPlainObject(root) || !Array.isArray(chat)) return false;
        for (let i = chat.length - 1; i >= 0; i--) {
            const message = chat[i];
            if (!message || message.is_user || message.is_system || typeof message.mes !== 'string') continue;
            const commands = extractNsCommands(message.mes).filter((command) => command.type !== 'add');
            if (!commands.length) return false;
            const before = JSON.stringify(root[NS] ?? null);
            applyNsCommands(root, commands);
            const changed = JSON.stringify(root[NS] ?? null) !== before;
            if (changed) console.info(`[故事导演] 兜底：从第 ${i} 楼正文补写了变量（命令事件没送到）`);
            return changed;
        }
    } catch (error) {
        console.debug('[故事导演] 兜底补写失败', error);
    }
    return false;
}

/**
 * 命名空间自愈：我们的世界书自带 InitVar，但老聊天只会初始化一次，所以插件自己也保证结构存在。
 * `live` 传 MVU 事件回调里那份还没落盘的活变量 —— 直接改它就与 MVU 自己那次回写同源。
 */
async function ensureNamespace({ notify = false, live = null } = {}) {
    const api = mvu();
    const d = live && isPlainObject(live.stat_data) ? live : mvuData();
    if (!isPlainObject(d?.stat_data)) {
        if (notify) toast('当前聊天还没有 MVU 变量，先和角色聊一句再试。', 'warning');
        return false;
    }
    if (!live && !api?.replaceMvuData) {
        if (notify) toast('MVU 未加载，无法初始化命名空间。', 'warning');
        return false;
    }
    if (!isPlainObject(d.stat_data[NS])) d.stat_data[NS] = {};
    const ns = d.stat_data[NS];
    let changed = false;

    if (!isPlainObject(ns.主线)) { ns.主线 = emptyMain(); changed = true; }
    else {
        const main = ns.主线;
        for (const [key, value] of Object.entries(emptyMain())) {
            if (!(key in main)) { main[key] = value; changed = true; }
        }
        if (!Array.isArray(main[MAIN_BEATS])) {
            const beats = splitBeats(main[MAIN_BEATS]).slice(0, BEAT_MAX);
            main[MAIN_BEATS] = beats;
            changed = true;
        } else if (main[MAIN_BEATS].length > BEAT_MAX) {
            // 拍数上限与注入/状态机同源：超过就裁掉，免得三处各说各的
            main[MAIN_BEATS] = main[MAIN_BEATS].slice(0, BEAT_MAX);
            changed = true;
        }
        if (!Number.isInteger(toNumber(main[KEY_BEAT], NaN)) || toNumber(main[KEY_BEAT], 1) < 1) {
            main[KEY_BEAT] = 1;
            changed = true;
        }
        for (const key of [KEY_BEAT_DONE, KEY_CHAPTER_DONE, KEY_READY]) {
            if (typeof unwrap(main[key]) !== 'boolean') { main[key] = truthy(main[key]); changed = true; }
        }
        if (!REVIEW_STATES.includes(String(display(main[KEY_REVIEW])).trim())) {
            main[KEY_REVIEW] = REVIEW_PASS;
            changed = true;
        }
    }
    for (const kind of ['支线', '插曲']) {
        if (!isPlainObject(ns[kind])) { ns[kind] = {}; changed = true; continue; }
        const box = ns[kind];
        // MVU 用 $meta.extensible 决定「这个对象能不能加新键」；补一份，否则 AI 的 _.set 新支线会被丢弃。
        const meta = isPlainObject(box.$meta) ? box.$meta : {};
        if (meta.extensible !== true) { box.$meta = { ...meta, extensible: true }; changed = true; }
    }
    if (!isPlainObject(ns.章节史)) { ns.章节史 = {}; changed = true; }
    else {
        const meta = isPlainObject(ns.章节史.$meta) ? ns.章节史.$meta : {};
        if (meta.extensible !== true) { ns.章节史.$meta = { ...meta, extensible: true }; changed = true; }
    }
    // 史诗（篇章）：围绕 {{user}} 的那条长线。老存档里没有就补齐。
    if (!isPlainObject(ns[EPIC])) { ns[EPIC] = emptyEpic(); changed = true; }
    else {
        const box = ns[EPIC];
        for (const [key, value] of Object.entries(emptyEpic())) {
            if (!(key in box)) { box[key] = value; changed = true; }
        }
        for (const key of [EP.movements, EP.hooks]) {
            if (!Array.isArray(box[key])) { box[key] = splitBeats(box[key]).slice(0, 12); changed = true; }
        }
        if (!Number.isInteger(toNumber(box[EP.chapter], NaN))) { box[EP.chapter] = 0; changed = true; }
    }
    // 间章：与主线互斥的另一幕（日常）。老存档里没有这个键就补齐。
    if (!isPlainObject(ns[INTERLUDE])) { ns[INTERLUDE] = emptyInterlude(); changed = true; }
    else {
        const box = ns[INTERLUDE];
        for (const [key, value] of Object.entries(emptyInterlude())) {
            if (!(key in box)) { box[key] = value; changed = true; }
        }
        if (!Array.isArray(box[IL.beats])) {
            box[IL.beats] = splitBeats(box[IL.beats]).slice(0, BEAT_MAX + 2);
            changed = true;
        }
        if (!Number.isInteger(toNumber(box[IL.beat], NaN)) || toNumber(box[IL.beat], 1) < 1) {
            box[IL.beat] = 1;
            changed = true;
        }
        for (const key of [IL.active, IL.beatDone, IL.done, IL.ready]) {
            if (typeof unwrap(box[key]) !== 'boolean') { box[key] = truthy(box[key]); changed = true; }
        }
    }

    if (!changed) return true;
    if (live) { render(); return true; }   // 活变量由 MVU 自己回写
    try {
        await api.replaceMvuData(d, { type: 'message', message_id: 'latest' });
    } catch (error) {
        console.debug('[故事导演] 写入命名空间失败', error);
        if (notify) toast('写入 MVU 失败，详见控制台。', 'error');
        return false;
    }
    if (notify) toast('故事导演 命名空间已就绪。', 'success');
    render();
    return true;
}

/**
 * 写 `故事导演.主线.*`。live 优先（与 MVU 同源），否则读改写。
 * 返回 true/false。
 */
async function patchMain(fields, { live = null } = {}) {
    const apply = (root) => {
        if (!isPlainObject(root[NS])) root[NS] = {};
        if (!isPlainObject(root[NS].主线)) root[NS].主线 = emptyMain();
        Object.assign(root[NS].主线, fields);
        if (Array.isArray(fields[MAIN_BEATS])) {
            root[NS].主线[MAIN_BEATS] = fields[MAIN_BEATS].slice();
        }
    };
    if (live && isPlainObject(live.stat_data)) { apply(live.stat_data); return true; }
    const api = mvu();
    const d = mvuData();
    if (!api?.replaceMvuData || !isPlainObject(d?.stat_data)) return false;
    apply(d.stat_data);
    try {
        await api.replaceMvuData(d, { type: 'message', message_id: 'latest' });
        return true;
    } catch (error) {
        console.debug('[故事导演] 写入主线失败', error);
        return false;
    }
}

/** 写 `故事导演.<kind>.<id>`（整份对象合并）。 */
async function patchEntry(kind, id, fields, { live = null } = {}) {
    const apply = (root) => {
        if (!isPlainObject(root[NS])) root[NS] = {};
        if (!isPlainObject(root[NS][kind])) root[NS][kind] = {};
        const box = root[NS][kind];
        box[id] = isPlainObject(box[id]) ? { ...box[id], ...fields } : { ...fields };
    };
    if (live && isPlainObject(live.stat_data)) { apply(live.stat_data); return true; }
    const api = mvu();
    const d = mvuData();
    if (!api?.replaceMvuData || !isPlainObject(d?.stat_data)) return false;
    apply(d.stat_data);
    try {
        await api.replaceMvuData(d, { type: 'message', message_id: 'latest' });
        return true;
    } catch (error) {
        console.debug(`[故事导演] 写入 ${kind}.${id} 失败`, error);
        return false;
    }
}

/** 直接删一条支线/插曲（AI 不写命令时插件自己收尾用）。 */
async function dropEntry(kind, id, { live = null } = {}) {
    const apply = (root) => {
        const box = isPlainObject(root[NS]) && isPlainObject(root[NS][kind]) ? root[NS][kind] : null;
        if (box) delete box[id];
    };
    if (live && isPlainObject(live.stat_data)) { apply(live.stat_data); return true; }
    const api = mvu();
    const d = mvuData();
    if (!api?.replaceMvuData || !isPlainObject(d?.stat_data)) return false;
    apply(d.stat_data);
    try { await api.replaceMvuData(d, { type: 'message', message_id: 'latest' }); return true; }
    catch (error) { console.debug(`[故事导演] 删除 ${kind}.${id} 失败`, error); return false; }
}

/** 把「已走完的章」记进章节史（注入时用来提醒模型不要重演）。 */
async function rememberChapter(main, { live = null } = {}) {
    const title = String(unwrap(main?.[MAIN_TITLE]) ?? '').trim();
    if (!title) return false;
    const s = settings();
    const arc = String(unwrap(main?.[MAIN_ARC]) ?? '').trim();
    const goal = String(unwrap(main?.[MAIN_GOAL]) ?? '').trim();
    const record = { [MAIN_TITLE]: title, [MAIN_ARC]: arc, [MAIN_GOAL]: goal };

    // 章节史直接以 MVU 里的那份为准（插件设置只做镜像，免得两份各剪各的、对不上）
    const root = rootOf(live);
    const fromMvu = isPlainObject(root?.[NS]?.章节史) ? { ...root[NS].章节史 } : {};
    const fromSettings = isPlainObject(s.chapters) ? s.chapters : {};
    const box = { ...(Object.keys(fromMvu).length ? fromMvu : fromSettings) };
    delete box.$meta;
    for (const key of Object.keys(box)) if (!/^\d+$/.test(key)) delete box[key];

    // 去重：章节路径的调用带着 force，换章分支又可能被下一次心跳再走一遍 —— 同标题同目标的
    // 记录只要已经在史里就不重复追加（否则防重复注入会被同一个章名刷屏，8 条上限还会把真章挤掉）。
    const duplicate = Object.values(box).some((item) => {
        if (!isPlainObject(item)) return false;
        return String(unwrap(item[MAIN_TITLE]) ?? '').trim() === title
            && String(unwrap(item[MAIN_GOAL]) ?? '').trim() === goal;
    });
    if (duplicate) return true;

    let next = 1;
    while (box[String(next)]) next++;
    box[String(next)] = record;

    // 只留最近 8 章
    const keys = Object.keys(box).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
    while (keys.length > 8) delete box[String(keys.shift())];

    s.chapters = box;
    save();

    const apply = (target) => {
        if (!isPlainObject(target[NS])) target[NS] = {};
        if (!isPlainObject(target[NS].章节史)) target[NS].章节史 = {};
        const history = target[NS].章节史;
        // 只清数字以外的键，$meta 要留着（不然每记一章都得等下一次心跳才补回 extensible）
        for (const key of Object.keys(history)) {
            if (!/^\d+$/.test(key) && key !== '$meta') delete history[key];
        }
        history[String(next)] = { ...record };
        const ids = Object.keys(history).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
        while (ids.length > 8) delete history[String(ids.shift())];
    };
    if (live && isPlainObject(live.stat_data)) { apply(live.stat_data); return true; }
    const api = mvu();
    const d = mvuData();
    if (!api?.replaceMvuData || !isPlainObject(d?.stat_data)) return false;
    apply(d.stat_data);
    try { await api.replaceMvuData(d, { type: 'message', message_id: 'latest' }); return true; }
    catch (error) { console.debug('[故事导演] 记录章节史失败', error); return false; }
}

// 阶段五：世界书

const bundledWorldbookUrl = () => new URL('worldbook/story-director.json', import.meta.url).href;
const bundledIconUrl = () => new URL('icon.svg', import.meta.url).href;

function isGlobalBookEnabled(name) {
    return Array.isArray(selected_world_info) && selected_world_info.includes(name);
}

function syncGlobalDom(name, selected) {
    const select = document.getElementById('world_info');
    if (!select) return;
    for (const option of select.options) {
        if (option.textContent === name) option.selected = selected;
    }
}

function persistGlobalBooks() {
    try { Object.assign(world_info, { globalSelect: selected_world_info.slice() }); } catch { /* ignore */ }
    try { saveSettings(); } catch (error) { console.debug('[故事导演] 保存全局世界书失败', error); }
    try { eventSource?.emit?.(event_types.WORLDINFO_SETTINGS_UPDATED); } catch { /* optional */ }
}

function setGlobalBook(name, enabled) {
    const want = !!enabled;
    try {
        // silent 必须是字符串 "true"：ST 内部会对它调 .trim()
        onWorldInfoChange({ state: want ? 'on' : 'off', silent: 'true' }, name);
    } catch (error) {
        console.debug('[故事导演] onWorldInfoChange 不可用，改用直接写入', error);
    }
    if (isGlobalBookEnabled(name) !== want) {
        if (Array.isArray(selected_world_info)) {
            const index = selected_world_info.indexOf(name);
            if (want && index === -1) selected_world_info.push(name);
            if (!want && index !== -1) selected_world_info.splice(index, 1);
        }
        syncGlobalDom(name, want);
    }
    persistGlobalBooks();
}

async function ensureWorldListLoaded() {
    if (Array.isArray(world_names) && world_names.length) return true;
    try { await updateWorldInfoList(); } catch (error) { console.debug('[故事导演] 刷新世界书列表失败', error); }
    return Array.isArray(world_names) && world_names.length > 0;
}

/** 自带世界书里那个版本标记（第一次读到就记住，给诊断行用）。 */
let BUNDLED_WORLD_VERSION = '';

/**
 * 酒馆里那本「故事导演」的版本标记（没有标记 = 老版本，需要更新）。
 * 直接 loadWorldInfo 读它自己，不依赖它有没有被挂载。
 */async function installedWorldbookVersion() {
    try {
        const helperGet = window.TavernHelper?.getWorldbook;
        if (typeof helperGet === 'function') {
            const entries = await helperGet(PLUGIN_WORLD);
            const meta = entries?.['0']?.srVersion ?? entries?.[0]?.srVersion;
            if (meta) return String(meta);
        }
    } catch { /* 往下试别的读法 */ }
    try {
        const load = window.SillyTavern?.getContext?.()?.loadWorldInfo;
        if (typeof load === 'function') {
            const book = await load(PLUGIN_WORLD);
            if (book?.srVersion) return String(book.srVersion);
        }
    } catch { /* 读不到就当老版本 */ }
    return '';
}

/** 把自带世界书拉下来并做基础校验（返回 null 表示失败）。 */
async function fetchBundledWorldbook() {
    try {
        const response = await fetch(bundledWorldbookUrl());
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (!isPlainObject(data?.entries) || !Object.keys(data.entries).length) throw new Error('没有 entries');
        if (data.srVersion) BUNDLED_WORLD_VERSION = String(data.srVersion);
        for (const entry of Object.values(data.entries)) {
            if (entry && typeof entry === 'object') entry.enabled = entry.disable !== true;
        }
        return data;
    } catch (error) {
        console.debug('[故事导演] 读取自带世界书失败', error);
        return null;
    }
}

/** 更新前先把旧内容备份成「原名 + 后缀」，绝不覆盖掉用户手里的那份。 */
async function backupWorldbook(suffix) {
    try {
        const load = window.SillyTavern?.getContext?.()?.loadWorldInfo;
        if (typeof load !== 'function') return '';
        const current = await load(PLUGIN_WORLD);
        if (!isPlainObject(current?.entries)) return '';
        const name = `${PLUGIN_WORLD}${suffix}`;
        await saveWorldInfo(name, current, true);
        try { await updateWorldInfoList(); } catch { /* 刷新失败不影响备份本身 */ }
        return name;
    } catch (error) {
        console.debug('[故事导演] 备份世界书失败', error);
        return '';
    }
}

/**
 * 把插件自带的 worldbook/story-director.json 装进酒馆。
 *
 * @param {object} opts
 * @param {boolean} opts.notify      要不要弹提示
 * @param {boolean|null} opts.mount  装完要不要挂到全局（null = 跟随设置）
 * @param {boolean} opts.ifMissing   缺失时才装（手动按钮走 false，表示「就是要重装」）
 * @param {boolean} opts.ifOlderVersion 只在自己那本**版本更旧**时才更新（自动路径走这个）
 *
 * 背景：以前这里只有「缺失才装」，于是我们改了世界书内容（加纪律、改变量契约），
 * 已经装过的人永远拿不到 —— 现在按版本标记比对，旧了就自动更新（**先备份**）。
 */
async function installBundledWorldbook({ notify = true, mount = null, ifMissing = true, ifOlderVersion = false } = {}) {
    if (!(await ensureWorldListLoaded())) {
        if (notify) toast('酒馆的世界书列表还没加载出来——稍等一下再试，或点「刷新列表」。', 'warning');
        return 'unknown';
    }
    const exists = world_names.includes(PLUGIN_WORLD);

    if (exists && ifMissing && !ifOlderVersion) {
        if (notify) toast(`酒馆里已经有世界书「${PLUGIN_WORLD}」了，不用重新安装。`, 'info');
        return 'exists';
    }

    // 已经存在、且是「只更新旧的」模式 → 先比版本；一样新就不动
    if (exists && ifOlderVersion) {
        const data0 = await fetchBundledWorldbook();
        if (!data0) {
            if (notify) toast('读不到插件自带的世界书文件（worldbook/ 子目录别漏掉）。', 'error');
            return 'failed';
        }
        const bundled = String(data0.srVersion || '');
        const installed = await installedWorldbookVersion();
        const decision = worldbookUpdateDecision(bundled, installed);
        if (decision === 'up-to-date') return 'up-to-date';
        if (decision === 'no-version') {
            console.debug('[故事导演] 自带世界书没有版本标记，跳过自动更新。');
            return 'no-version';
        }
        const backup = await backupWorldbook(`（更新前备份 ${installed || '无版本'}）`);
        try {
            await saveWorldInfo(PLUGIN_WORLD, data0, true);
        } catch (error) {
            console.debug('[故事导演] 更新自带世界书失败', error);
            if (notify) toast('更新世界书失败，详见控制台。', 'error');
            return 'failed';
        }
        try { await updateWorldInfoList(); } catch (error) { console.debug('[故事导演] 刷新世界书列表失败', error); }
        if (panel && !panel.hidden) render();
        console.info(`[故事导演] 自带世界书已更新：${installed || '(无版本)'} → ${bundled}` + (backup ? `；旧内容备份为「${backup}」` : ''));
        if (notify) {
            toast(
                `自带世界书「${PLUGIN_WORLD}」已更新到 ${bundled}` +
                (backup ? `（旧内容备份成「${backup}」，可以随时对照或删掉）` : '') + '。',
                'success',
            );
        }
        return 'updated';
    }

    const data = await fetchBundledWorldbook();
    if (!data) {
        if (notify) toast('读不到插件自带的世界书文件（worldbook/story-director.json）——手动拷扩展目录时别漏掉 worldbook 子目录。', 'error');
        return 'failed';
    }
    // 真·重装：也给旧内容留一份备份
    if (exists) await backupWorldbook('（重装前备份）');
    try {
        await saveWorldInfo(PLUGIN_WORLD, data, true);
    } catch (error) {
        console.debug('[故事导演] 写入自带世界书失败', error);
        if (notify) toast('写入世界书失败，详见控制台。', 'error');
        return 'failed';
    }
    try { await updateWorldInfoList(); } catch (error) { console.debug('[故事导演] 刷新世界书列表失败', error); }
    const shouldMount = mount === null ? !!settings().autoMountBook : !!mount;
    if (shouldMount) setGlobalBook(PLUGIN_WORLD, true);
    if (panel && !panel.hidden) render();
    if (notify) {
        toast(
            `已从插件包装好世界书「${PLUGIN_WORLD}」（${Object.keys(data.entries).length} 条）` +
            (shouldMount ? '，并挂载到全局世界书。' : '。到「设定」页可以手动挂载。'),
            'success',
        );
    }
    return 'installed';
}

/** 读我们自己那本世界书（不依赖它有没有被挂载）。 */
async function readOurWorldbookEntries() {
    const name = PLUGIN_WORLD;
    const normalize = (raw) => {
        const list = Array.isArray(raw) ? raw : Object.values(raw ?? {});
        return list.filter((entry) => entry && typeof entry.content === 'string');
    };
    try {
        const helperGet = window.TavernHelper?.getWorldbook;
        if (typeof helperGet === 'function') {
            const list = normalize(await helperGet(name));
            if (list.length) return list;
        }
    } catch (error) { console.debug('[故事导演] 酒馆助手读世界书失败', error); }
    try {
        const load = window.SillyTavern?.getContext?.()?.loadWorldInfo;
        if (typeof load === 'function') {
            const book = await load(name);
            const list = normalize(book?.entries);
            if (list.length) return list;
        }
    } catch (error) { console.debug('[故事导演] ST 读世界书失败', error); }
    return normalize(world_info?.[name]?.entries);
}

// 阶段六：注入

/** 把 {{user}} / {{char}} 之类的 ST 宏在注入前展开。 */
function substitute(text) {
    const raw = String(text ?? '');
    if (!raw) return '';
    try {
        const ctx = window.SillyTavern?.getContext?.();
        if (typeof ctx?.substituteParams === 'function') return ctx.substituteParams(raw);
    } catch { /* ignore */ }
    return raw;
}

/**
 * 组装本轮注入主聊天的引导。
 *
 * 主线永远注入（没有拍列表时给占位，不让正文模型自己硬编剧情）；
 * 支线/插曲按开关与数量注入，位置都在主线之后 —— 冲突时以主线为准。
 */
function buildInjection(live = null) {
    const s = settings();
    const root = rootOf(live);
    const main = mainOf(root);
    const ban = s.banUserAction !== false;
    const intensity = INTENSITIES[s.intensity] || INTENSITIES.normal;
    const chapterToday = String(unwrap(main[MAIN_TITLE]) ?? '').trim();
    const beats = beatsOf(main);
    const hasMain = beats.length > 0 || chapterToday;

    const header = renderInjectionHeader({ banUserAction: ban, mode: currentMode(live) });
    // ⚠ **篇章不进正文**。
    //   篇章是给「故事神谕」看的：它按篇章设计出**这一章**，正文只该拿到这一章本身。
    //   以前把整节篇章塞进正文注入，结果是叙事者一眼看完整条长线的走向与结局 ——
    //   于是急着把剧情往前赶：粗糙、过快、伏笔还没铺就被兑现。这是编排泄漏。
    //   正文只需要三件事：这一类幕现在聚焦什么、本轮写什么、不要安排 {{user}} 的行为。

    let mainLines = [];
    if (s.injectMain) {
        // 主线与间章**互斥**：同一时间只有一种在注入。间章时段主线整块收起（只留一句说明），
        // 这样叙事者不会一边演日常一边惦记着主线的那一拍。
        if (currentMode(live) === 'interlude') {
            const chapter = interludeChapterOf(root);
            mainLines = renderInterludeChapterSection(chapter, { maxBeats: BEAT_MAX, banUserAction: ban }).lines;
        } else if (hasMain) {
            mainLines = renderMainSection(main, { maxBeats: BEAT_MAX, root, banUserAction: ban, focusStale: s.run.focusStale }).lines;
        } else {
            // ⚠ 还没开篇 → **一个字节都不注入**。
            //   导演还没有这一章，就不该对正文说任何话：不要「等你准备好」的占位、
            //   不要「不要自己开局」的叮嘱（那本身就是编排话术泄漏给叙事者），更不要把
            //   「原因：…」这种排查信息塞进正文（那是面板和控制台的活儿）。
            //   叙事者这时只需要做它本来该做的事：照当前场景自然叙事。
            mainLines = [];
        }
        if (mainLines.length) {
            mainLines.push(`整体节奏按「${intensity.label}」把握：${intensity.directive}`);
        }
    }

    const threadLines = s.injectThreads
        ? renderThreadsSection(liveThreads(live), { keep: Math.max(0, Math.round(toNumber(s.maxThreads, 2))), banUserAction: ban }).lines
        : [];
    const interludeLines = s.injectInterludes
        ? renderInterludeSection(interludesState(live), currentBeat(main), { keep: Math.max(0, Math.round(toNumber(s.maxInterludes, 1))), banUserAction: ban }).lines
        : [];

    if (threadLines.length || interludeLines.length) {
        threadLines.push('（支线与插曲都是配菜：与主线冲突时，永远先照顾主线当前那一拍。）');
    }

    const body = [...mainLines, ...threadLines, ...interludeLines].filter(Boolean);
    // 没有任何东西要说时，连 header 都不注入（空的「幕后引导」外壳只会占额度）
    if (!body.length) return '';
    return substitute([...header, ...body, '</story_director_status>'].join('\n'));
}

/** 注入槽同步：主线/支线/插曲/变量契约各占一个槽，都独立于别的插件。 */
function syncMainInjection() {
    try {
        const s = settings();
        const text = buildInjection();
        const depth = Math.max(0, Math.round(toNumber(s.injectDepth, 4)));
        // text 为空时 setExtensionPrompt 会写入空串 = 这一轮什么都不注入（ST 不会渲染空块）

        // 主线与支线/插曲共用一段文本（内部已按优先级排好），所以放一个槽里保证同深度。
        setExtensionPrompt(SLOT.main, text, extension_prompt_types.IN_CHAT, depth, true, extension_prompt_roles.SYSTEM);
        setExtensionPrompt(SLOT.threads, '', extension_prompt_types.IN_CHAT, 0, false, extension_prompt_roles.SYSTEM);
        setExtensionPrompt(SLOT.interludes, '', extension_prompt_types.IN_CHAT, 0, false, extension_prompt_roles.SYSTEM);

        const contract = s.injectContract ? substitute(renderContractSection({ banUserAction: settings().banUserAction !== false }).join('\n')) : '';
        setExtensionPrompt(SLOT.contract, contract, extension_prompt_types.IN_CHAT, depth, false, extension_prompt_roles.SYSTEM);

        if (panel && !panel.hidden) renderDiagnostics(text, contract);
    } catch (error) {
        console.debug('[故事导演] 主提示词注入失败', error);
    }
}

function renderDiagnostics(text = null, contract = null) {
    const s = settings();
    const root = rootOf();
    const ns = namespaceOf(root);
    const main = mainOf(root);
    const beats = beatsOf(main);
    const beat = currentBeat(main);
    const node = panel?.querySelector('.sd-status');
    if (node) {
        node.textContent = [
            `主线：${String(unwrap(main[MAIN_TITLE]) ?? '').trim() || '未开篇'}${beats.length ? `　第 ${beat}/${beats.length} 拍` : ''}`,
            `支线：${liveThreads().length} 条在演／共 ${threadsState().length} 条`,
            `插曲：${interludesState().filter(interludePending).length} 条待演／共 ${interludesState().length} 条`,
            `MVU：${mvu() ? '可用' : '未加载'}`,
            `变量自管：${interceptionReady ? '已接上' : '未接上'}`,
            `挡下拍号回退：${beatOrderSkipsRead()} 次`,
            `生成闸门：${storyGenerating ? '进行中' : (isPending(`epic:${chatKey()}`) ? '定篇章排队中' : '空闲')}${failedKeys.size ? `　退避中 ${failedKeys.size} 项` : ''}`,
            `命名空间：${namespaceReport(ns)}`,
            `世界书：${isGlobalBookEnabled(PLUGIN_WORLD) ? '已挂载' : '未挂载'}`,
            // 自带世界书的版本状态（这一行是给「要不要手动更新一下」用的）
            (() => {
                // ⚠ 导入的名字是 world_info（下划线）。且它可能还没加载 → 全程可选链。
                const installed = world_info?.[PLUGIN_WORLD]?.srVersion ? String(world_info[PLUGIN_WORLD].srVersion) : '';
                const bundled = String(BUNDLED_WORLD_VERSION || '(未读)');
                if (!installed) return `世界书版本：酒馆里那本没有版本标记（很旧）· 自带 ${bundled}`;
                if (installed === bundled) return `世界书版本：${installed}（最新）`;
                return `世界书版本：酒馆 ${installed} · 自带 ${bundled} ⚠ 需要更新（点「安装／重装」或开着自动更新）`;
            })(),
            `神谕接口：${(() => { const r = oracleCompatReport(); return r.fatal ? `不可用（${r.missing[0] || '未知'}）` : (r.ok ? '齐全' : `缺 ${r.missing.length} 项可选能力`); })()}`,
            `导演：${s.autoDirector ? '自动推进中' : '已暂停'}`,
            `本聊天切片：${s.chatSliceKey || '未就绪'}`,
        ].join('　');
    }
    const preview = panel?.querySelector('.sd-inject-preview');
    if (preview) preview.textContent = text ?? buildInjection() ?? '（当前没有注入内容）';
    const contractNode = panel?.querySelector('.sd-contract-preview');
    if (contractNode) {
        contractNode.textContent = contract
            ?? (settings().injectContract
                ? renderContractSection({ banUserAction: settings().banUserAction !== false }).join('\n')
                : '（变量契约注入已关）');
    }
}

// 阶段七：状态块剥离

/** 模型有时会把注入的状态块抄进正文：确定性剥离（只动我们自己那个标签）。 */
function stripStatusEcho(messageId) {
    try {
        const msg = chat?.[messageId];
        if (!msg || msg.is_user || msg.is_system || typeof msg.mes !== 'string') return false;
        const before = msg.mes;
        if (!before.includes(STATUS_TAG)) return false;
        let after = before.replace(new RegExp(`<${STATUS_TAG}>[\\s\\S]*?<\\/${STATUS_TAG}>`, 'gi'), '');
        const stray = after.search(new RegExp(`<${STATUS_TAG}>`, 'i'));
        if (stray >= 0) after = after.slice(0, stray);
        after = after.replace(new RegExp(`<\\/?${STATUS_TAG}>`, 'gi'), '').replace(/\n{3,}/g, '\n\n').trimEnd();
        if (after === before) return false;
        msg.mes = after;
        try { updateMessageBlock(messageId, msg); } catch { /* 老版本 ST 可能没有这个导出 */ }
        try { saveChatDebounced(); } catch { /* ignore */ }
        console.info(`[故事导演] 已从第 ${messageId} 楼剥掉被误输出的导演状态块（-${before.length - after.length} 字符）`);
        return true;
    } catch (error) {
        console.debug('[故事导演] 剥离状态块失败', error);
        return false;
    }
}

function stripStatusEchoFromLatest() {
    try {
        for (let i = chat.length - 1; i >= 0; i--) {
            const m = chat[i];
            if (!m || m.is_user || m.is_system) continue;
            return stripStatusEcho(i);
        }
    } catch { /* ignore */ }
    return false;
}

function cleanupStatusEchoInChat({ notify = true } = {}) {
    let cleaned = 0;
    try {
        for (let i = 0; i < chat.length; i++) {
            const m = chat[i];
            if (!m || m.is_user || m.is_system || typeof m.mes !== 'string') continue;
            if (!m.mes.includes(STATUS_TAG)) continue;
            if (stripStatusEcho(i)) cleaned++;
        }
    } catch (error) {
        console.debug('[故事导演] 清理历史状态块失败', error);
    }
    if (cleaned && notify) toast(`已清理 ${cleaned} 条回复里被误输出的导演状态块。`, 'success');
    return cleaned;
}

// 阶段八：给神谕的上下文与提示词

/** 给神谕的设定：我们自己的世界书（规则）+ 可选的角色卡世界书 + 最近对话 + 当前变量 + 神谕自己的引导。 */
/**
 * 给神谕的「当前剧情状态」。
 *
 * ⚠ 这里以前是 `JSON.stringify(整个 故事导演 命名空间)` —— 设计**一章**却把全部家当发过去：
 *   篇章的全部走向与伏笔、整章的拍列表、章节史、全部支线、全部插曲，全是嵌套 JSON。
 *   浪费上下文，还把模型的注意力摊薄。
 *
 * 现在按任务裁剪：
 *   · `chapter`：只给**当前这一章**（含聚焦到哪一拍、这一章要埋的伏笔）+ 章节史压缩成「章名（目标）」一行；
 *   · 其它（篇章 / 支线 / 插曲 / 间章）：保持原来的口袋，但同样把章节史压成一行。
 */
function focusedStateBlock(task) {
    const s = settings();
    const root = rootOf();
    const lines = [];
    const isChapter = task === 'chapter';

    // ── 篇章：给大势 + 还没兑现的伏笔（写章节时这是「该埋什么」的来源）──
    const epic = epicOf(root);
    if (epicStarted(epic)) {
        const title = String(unwrap(epic[EP.title]) ?? '').trim();
        const stage = String(unwrap(epic[EP.stage]) ?? '').trim();
        const line = String(unwrap(epic[EP.line]) ?? '').trim();
        const ledger = String(unwrap(epic[EP.ledger]) ?? '').trim();
        const hooks = epicHooks(epic);
        lines.push(`【长线】${title ? `《${title}》` : ''}${stage ? `　进程：${stage}` : ''}`);
        if (line) lines.push(`在争什么：${line}`);
        if (!isChapter) {
            const movements = epicMovements(epic);
            if (movements.length) lines.push(`几个大阶段：${movements.map((m, i) => `${i + 1}. ${m}`).join('　')}`);
        }
        if (hooks.length) lines.push(`**还没兑现的伏笔**（要埋就得与它们同源，不要另起炉灶）：${hooks.join('；')}`);
        if (ledger) lines.push(`既成事实：${ledger}`);
        lines.push('');
    }

    // ── 主线：写章节时**只给当前这一章** ──
    const main = mainOf(root);
    const beats = beatsOf(main);
    const title = String(unwrap(main[MAIN_TITLE]) ?? '').trim();
    if (title || beats.length) {
        lines.push('【当前这一章】（只为它设计，不要动别的章）');
        if (title) lines.push(`章名：${title}`);
        const arc = String(unwrap(main[MAIN_ARC]) ?? '').trim();
        const scope = String(unwrap(main[MAIN_SCOPE]) ?? '').trim();
        const goal = String(unwrap(main[MAIN_GOAL]) ?? '').trim();
        if (arc) lines.push(`分卷：${arc}`);
        if (scope) lines.push(`范围：${scope}`);
        if (goal) lines.push(`章目标：${goal}`);
        if (beats.length) {
            const current = currentBeat(main);
            lines.push(`拍（▶ = 正在演）：${beats.map((b, i) => `${i + 1 === current ? '▶' : '·'}${b}`).join('　')}`);
            lines.push(`已经演到第 ${current} 拍（**前面的不要再重演**）。`);
        }
        lines.push('');
    }

    // ── 章节史：压缩成「章名（目标）」一行（原来是把每章的嵌套对象全发过去）──
    const history = completedMainTitles(root);
    if (history.length) lines.push(`【走过的章】${history.join(' → ')}`);
    const goals = completedChapterGoals(root);
    if (goals.length) lines.push(`各章目标：${goals.join('；')}`);

    // ── 在演的支线 / 插曲：只列名字与目标，别抢戏即可 ──
    const threads = liveThreads().slice(0, Math.max(0, Math.round(toNumber(s.maxThreads, 2))));
    if (threads.length) {
        lines.push(`【在演的支线】${threads.map((item) => {
            const t = String(unwrap(item[THREAD_FIELDS.title]) ?? item.id).trim();
            const g = String(unwrap(item[THREAD_FIELDS.goal]) ?? '').trim();
            return g ? `${t}（${g}）` : t;
        }).join('；')}`);
    }
    const sides = interludesState().filter(interludePending).slice(0, Math.max(0, Math.round(toNumber(s.maxInterludes, 1))));
    if (sides.length) {
        lines.push(`【待演的插曲】${sides.map((item) => String(unwrap(item[INTERLUDE_FIELDS.title]) ?? item.id)).join('；')}`);
    }

    return `=== 当前 ${NS} 状态（已按本次任务裁剪：只给相关的那些）===\n${lines.join('\n')}`;
}

async function collectContextBlocks(task = 'chapter') {
    const s = settings();
    const blocks = [];

    // ① 我们自己的世界书：规则来源，放最前面
    try {
        const ours = await readOurWorldbookEntries();
        const digest = worldbookDigest(ours);
        if (digest) blocks.push(`=== 世界书「${PLUGIN_WORLD}」（本模块的最高规则来源，冲突一律以它为准）===\n${capText(digest, 24000)}`);
    } catch (error) {
        console.debug('[故事导演] 读取自己的世界书失败', error);
    }

    // ② 角色卡 / 别的世界书里的设定（交给神谕自己的 buildWorldInfo，按它的扫描规则取激活条目）
    //   ⚠ 接口契约：`context.buildWorldInfo(opts)` 是 **async，返回字符串**（不是对象）。
    //     以前这里按 `picked?.text` 读，于是恒为空 —— 用户的设定被静默漏掉，生成质量莫名其妙变差。
    const mode = ORACLE_WORLDINFO_MODES[s.oracleWorldInfo] ? s.oracleWorldInfo : 'char';
    if (mode !== 'off') {
        try {
            const api = window.StoryOracleAPI?.context;
            if (typeof api?.buildWorldInfo === 'function') {
                const picked = await api.buildWorldInfo({ forceMode: ORACLE_WORLDINFO_MODES[mode].forceMode, excludeBooks: [PLUGIN_WORLD] });
                const text = typeof picked === 'string' ? picked : String(picked ?? '');
                if (text.trim()) blocks.push(`=== 世界书 / 设定（${ORACLE_WORLDINFO_MODES[mode].label}；只含当前真正激活的条目）===\n${capText(text, 40000)}`);
                else oracleCaps.worldInfo = false;
            } else {
                oracleCaps.worldInfo = false;
            }
        } catch (error) {
            console.debug('[故事导演] 取世界书设定失败', error);
            oracleCaps.worldInfo = false;
        }
    }

    // ③ 最近对话（裸调用通道下唯一的现场信息来源）
    if (s.storyTranscript) {
        try {
            const api = window.StoryOracleAPI?.context;
            const ctx = api?.getContext?.();
            if (ctx && typeof api.buildTranscript === 'function') {
                oracleCaps.transcript = true;
                const transcript = api.buildTranscript(ctx, {});
                if (transcript) blocks.push(`=== 近期对话 ===\n${capText(transcript, Math.max(2000, Math.round(toNumber(s.transcriptLimit, 12000))))}`);
            }
        } catch (error) {
            console.debug('[故事导演] 取近期对话失败', error);
        }
    }

    // ④ 当前剧情状态（**按任务裁剪**：写章节时只给当前这一章，不再整包发命名空间）
    try {
        const focused = focusedStateBlock(task);
        if (focused) blocks.push(focused);
    } catch (error) {
        console.debug('[故事导演] 组装剧情状态失败，退回整包变量', error);
        const ns = namespaceOf();
        if (ns) blocks.push(`=== 当前 ${NS} 变量 ===\n${JSON.stringify(unwrapDeep(ns), null, 2)}`);
    }

    // ⑤ 故事神谕自己的引导（如果有）：新设计要与它兼容，不要互相顶牛
    try {
        const guidance = window.StoryOracleAPI?.guidance?.getActive?.();
        if (guidance?.directive) blocks.push('=== 故事神谕当前的主线引导（你的设计要与它兼容，不要互相顶牛）===\n' + guidance.directive);
    } catch { /* 快照口不可用就算了 */ }
    if (oracleCaps.present && !oracleCaps.guidance) probeOracleCaps();

    return blocks;
}

/**
 * 用户钉住的要求里，该带进**这次任务**的那一份。
 *   · epic  → 钉住的篇章要求
 *   · 其它  → 钉住的章节要求（章节要求只对「设计这一章」有意义）
 *
 * ⚠ 章节要求会在**章名变化时自动清掉**（见 syncChapterPin）：用户写的是「这一章别摊牌」，
 *   下一章不该继续背这个包袱。
 */
function pinnedAskText(task) {
    const s = settings();
    if (task === 'epic') return String(s.run.epicPin || '').trim();
    syncChapterPin();
    return String(s.run.chapterPin || '').trim();
}

/** 章名变了 → 自动清掉上一章钉住的要求（并保存）。 */
function syncChapterPin() {
    const s = settings();
    if (!s.run.chapterPin) return false;
    const title = String(unwrap(mainState()[MAIN_TITLE]) ?? '').trim();
    if (s.run.chapterPinFor === title) return false;
    s.run.chapterPin = '';
    s.run.chapterPinFor = '';
    save();
    console.info('[故事导演] 章名变了，已清掉上一章钉住的要求。');
    return true;
}

/** 这一份要求该钉到哪：'epic' 还是 'chapter'。 */
function pinAsk({ task = 'chapter', ask = '' } = {}) {
    const s = settings();
    const text = String(ask || '').trim();
    if (!text) return false;
    if (task === 'epic') {
        s.run.epicPin = text;
    } else {
        s.run.chapterPin = text;
        s.run.chapterPinFor = String(unwrap(mainState()[MAIN_TITLE]) ?? '').trim();
    }
    save();
    return true;
}

/** 清掉钉住的要求。task 不传就两个都清。 */
function clearPin(task = '') {
    const s = settings();
    let changed = false;
    if (!task || task === 'epic') { if (s.run.epicPin) { s.run.epicPin = ''; changed = true; } }
    if (!task || task !== 'epic') { if (s.run.chapterPin) { s.run.chapterPin = ''; s.run.chapterPinFor = ''; changed = true; } }
    if (changed) save();
    return changed;
}

/**
 * 每一章实际达成的目标，形如「章名（目标）」。
 * 给篇章校准用：**这才是长线真正走过的路**（比只看章名强得多）。
 */
function completedChapterGoals(root) {
    const box = isPlainObject(root?.[NS]?.['章节史']) ? root[NS]['章节史'] : null;
    if (!box) return [];
    return Object.keys(box)
        .filter((key) => /^\d+$/.test(key))
        .sort((a, b) => Number(a) - Number(b))
        .map((key) => {
            const item = box[key];
            const title = String(unwrap(isPlainObject(item) ? item[MAIN_TITLE] : item) ?? '').trim();
            const goal = isPlainObject(item) ? String(unwrap(item[MAIN_GOAL]) ?? '').trim() : '';
            if (!title) return '';
            return goal ? `${title}（${goal}）` : title;
        })
        .filter(Boolean);
}

/** 已走过的章 + 已用过的标题：喂给神谕做「不要重复」的硬约束。 */
function antiRepeatBlock() {    const root = rootOf();
    const history = completedMainTitles(root);
    const titles = takenTitles(root);
    const lines = [];
    if (history.length) lines.push(`已经走过的章（不要重演，也不要换个说法再来一遍）：${history.join('、')}`);
    if (titles.length) lines.push(`已经用过的标题（新的标题不要与它们重复或近似）：${titles.join('、')}`);
    return lines.length ? `=== 防重复 ===\n${lines.join('\n')}` : '';
}

/**
 * 所有产出共用的铁律。
 *
 * ⚠ 第一条是这套东西的**引擎**：剧情由「世界里发生了什么 + 别人做了什么 + 埋下的伏笔」推动，
 * 不是由 {{user}} 去做什么推动。{{user}} 是玩家，他的行为、台词、选择、决定**一个字都不能替他安排** ——
 * 导演只负责把局面摆到他面前，让他自己决定怎么走。
 */
const COMMON_RULES = [
    '铁律（对所有产出都有效）：',
    '- **不许安排 {{user}} 的行为**（最重要）：不写他做什么、说什么、想什么、决定什么、看到什么才反应，也不写「等他…之后再…」把剧情挂在他的选择上。'
        + '{{user}} 是玩家，他的行为只由他自己决定。剧情要靠**世界里发生了什么**往前推：别人做了什么、环境怎么变、什么消息传到了、什么意外发生了。',
    '- **每拍都必须发生在 {{user}} 之外**：写成「谁（NPC / 环境 / 第三方）做了什么、于是局面变成什么样」，',
    '  而不是「{{user}} 去做了 X，于是 Y」。有人要跟他说话，就写「有人来找他 / 当着他的面说了什么」，不要写他答应了什么。',
    '- **靠伏笔与事件推动**：优先用「一个新事实 / 一次意外 / 一句传话 / 一个别人做的决定」把局面往前推；',
    '  伏笔（异样的细节、巧合、欲言又止、被人瞒着的事）要具体、可复述，并且准备在后面的拍里兑现。',
    '- **不许无中生有**：上下文里出现过的角色、地点、关系、财产、职业、差事都是既成事实。不要给他们凭空增加院子、产业、工作、亲属、师门、婚约。',
    '- 每一拍都要能追溯到上下文里已经存在的条件，写成「因为已有 X，所以发生 Y」；确实需要新元素时，明说它是**新出现**的，并交代它为什么出现在这里。',
    '- 不要改既有角色的既有属性（年龄、身份、住处、亲属、能力边界）。',
    '- 不要替角色卡或世界书另立规则；冲突时以世界书「' + PLUGIN_WORLD + '」为准。',
    '- 只设计**剧情走向**，不写台词、不写露骨描写：拍要写成结果式的一句话（谁做了什么、局面变成什么样）。',
    // ★ 防制式化：连着几章都落在同一个场景形状上，读者会看出「又来一遍」。
    //   模型很容易照着上一章的骨架换个名字再写一次 —— 这一条专门挡它。
    '- **不要制式化**：两章之间的**场景形状**不许重复。',
    '  反面例子（连着两章都这样，就是制式）：「遇见一个新的人 → 他交代一件事 → 去那个地方把事做掉」。',
    '  正面做法：每一章的开场与推进方式都要**从当前处境里长出来**，而不是套上一次用过的骨架 ——',
    '  有的章靠一封送错地方的信起手，有的章靠一个早该露面的人终于出现，有的章靠某个人自己把事情办砸了。',
    '  写之前先问自己：**这一章和上一章，除了换了名字，还有什么不一样？** 答不上来就重想。',
];

/** 拍 / 支线 / 插曲统一的「怎么写」要求（各生成提示词里复用）。 */
const BEAT_FORMAT_RULES = [
    '每一拍按这个格式写：**谁做了什么 → 于是局面变成什么样**。',
    '   · 主语必须是 NPC、第三方或环境，**不能是 {{user}}**；',
    '   · 写「结果」（事情真的发生了），不要写「即将发生」「气氛渐渐…」；',
    '   · 不要以「{{user}} 的选择 / 回应 / 是否答应」为前置条件。',
    '好例子：「一名陌生的客商住进了后巷的客栈，第二天清早她的贴身侍女与他搭了两句话」',
    '　　「那位客商在席上送了她一支簪子，她收下之后没戴出来」（伏笔：簪子）',
    '坏例子：「她鼓起勇气向他搭话，他答应了」（安排了 {{user}}）',
    '　　「他若同意，她便说出实情」（把剧情挂在 {{user}} 的选择上）',
];

function buildChapterSystemPrompt({ regenerate = false, rejected = null, remaining = 0, keep = 0, evolution = '' } = {}) {
    const s = settings();
    const root = rootOf();
    const main = mainOf(root);
    const beats = beatsOf(main);
    const target = Math.max(BEAT_MIN, Math.min(BEAT_MAX, Math.round(toNumber(s.beatTarget, 4))));
    // 局部重排：只给剩下的拍，不要再给一整章
    const partial = remaining > 0;
    const budget = partial ? Math.max(1, Math.min(target, Math.round(remaining))) : target;
    const intensity = INTENSITIES[s.intensity] || INTENSITIES.normal;
    const history = completedMainTitles(root);
    const epic = epicOf(root);
    const hasEpic = epicStarted(epic);
    const tone = toneDirective(s.tone);

    const lines = [
        '你是「故事导演」的剧情设计师，为一个正在进行的角色扮演服务。',
        partial
            ? '你的唯一任务：**按现在的处境重排这一章剩下的拍**（已经演过的部分不许动），并把它拆成可以按顺序演出的「拍」。'
            : '你的唯一任务：设计**下一章主线**，并把它拆成可以按顺序演出的「拍」。',
        '规则优先级：世界书「' + PLUGIN_WORLD + '」> 用户在本插件里的设定；角色卡自带设定只作可选参考。',
        '你不写正文，只交一份给叙事者照做的演出计划。',
        '',
        ...COMMON_RULES,
        '',
    ];

    if (tone) lines.push('===== 基调（本故事是这一型，章节设计要贴合它）=====', tone, '===== 基调结束 =====', '');

    // ── 篇章：先给「大势」，再给「这一章怎么走」 ──
    if (hasEpic) {
        const title = String(unwrap(epic[EP.title]) ?? '').trim();
        const line = String(unwrap(epic[EP.line]) ?? '').trim();
        const stage = String(unwrap(epic[EP.stage]) ?? '').trim();
        const ledger = String(unwrap(epic[EP.ledger]) ?? '').trim();
        const movements = epicMovements(epic);
        const hooks = epicHooks(epic);
        lines.push(
            '这是一部**已经在跑的长线**，你要为它设计下一章：',
            `${title ? `《${title}》` : ''}${stage ? `　当前进程：${stage}` : ''}`,
            line ? `篇章：${line}` : '',
        );
        if (movements.length) lines.push(`这条长线的几个大阶段（**整部戏的骨架，不是章节表**）：${movements.map((m, i) => `${i + 1}. ${m}`).join('　')}`);
        if (hooks.length) lines.push(`还没兑现的伏笔（这一章最多兑现一个，也可以只是继续吊着）：${hooks.join('；')}`);
        if (ledger) lines.push(`既成事实（**不可撤销**）：${ledger}`);
        lines.push(
            '',
            '⚠ 上面给的是**大势**，不是这一章的剧本 —— **这一章怎么演，由你决定**：',
            '　· 一章要有**它自己的完整形状**：起（怎么进这一章）→ 承（事情往下走、压力加码）→ 转（这一章的**小高潮**：最要紧的那一下真的发生）→ 合（这一章的收场与余波）。',
            '　· 上面那些大阶段是**一大块**：这一章只在这块里推进一点，不必走完一个阶段，也**可能一章就把它走完**。',
            '　· 拍要按上面那个形状**排开**，最后几拍必须落到「合」上 —— 这一章结束时局面要有个明确的落点，不能停在半空。',
            '',
            '⚠ **为后文埋的伏笔（这一章要负责埋的）** —— 这是长线能接下去的关键，但**埋法必须自然**：',
            '　· 每一章至少要留下**一个**能在后文回收的细节（物件、一句话、一个被谁注意到的小动作、一个没解释的巧合）。',
            '　· **必须「顺手」埋，不能专门为它加戏**：它要长在**当前这个场景本来就会发生的事**里 ——',
            '　　某人来传话时顺带提到的一个名字、送礼时多出来的一件东西、临走前没关上的那扇门。',
            '　· **不许为了埋伏笔硬造条件**：不要凭空加一个新角色 / 新地点 / 新势力 / 新前史；',
            '　　如果这个场景里确实没有可埋的东西，那就**埋在这一章后面几拍的正常事件里**，或者这一章干脆不埋（下一章补）。',
            '　· 埋下去的细节要**能被复述**（「她袖口沾了不属于这里的灰」），不要写成「气氛有些微妙」。',
            '　· **不要当场解释它**：埋完就走，让它在后文自己响。也不要在一章里堆七八个 —— 一到两个就够。',
            '',
            '⚠ 新的一章必须让这条长线**真的往前一段**：局势变了、代价付了、或者某个伏笔兑现了。',
            '  如果只是想写「他们又赶了一程路 / 又过了一天」，那是**间章**的料，不要拿来当主线的一章。',
            '',
        );
    }

    if (partial) {
        lines.push(
            `⚠ 这是**局部重排**：这一章已经演完了前 ${Math.round(keep)} 拍，你只需要设计**第 ${Math.round(keep) + 1} 拍起**的剩余内容（最多 ${budget} 拍）。`,
            '已经演过的拍是既成事实：不要重演它们，也不要推翻它们造成的结果；但要接着它们往下走。',
            '标题 / 分卷 / 范围 / 章目标 照原样给回（可以微调措辞，但这一章的定位不要变）。',
            '',
        );
    } else if (history.length) {
        lines.push(
            `这个故事的章已经走过 ${history.length} 章：${history.join(' → ')}。`,
            '新的一章要**接着**它们往下走（上一章的后果已经成立），不要重演、不要倒回去补一段。',
            '',
        );
    } else {
        lines.push(
            '这是故事的第一章：承接开局与最近对话里已经发生的状况，不要一上来就把最大的冲突引爆。',
            '',
        );
    }

    // ── 演化守则：他的行为与剧本有误差时，以他为准 ──
    lines.push(
        '⚠ 演化守则（比大纲重要）：',
        '{{user}} 是主角，但他**不按剧本走**。设计这一章之前，先读最近对话，看他实际做了什么、去了哪、跟谁翻了脸、跟谁站到了一边：',
        '- **已经发生的，就是现在的前提**：不要假装没发生，也不要设计「让他回到原计划」的一章；',
        '- 如果他的做法让篇章里下一段走向不成立了，**换一条通往同一目标的路**（保留「他要付什么代价」，只改路径）；',
        '- 如果他走出了完全没想到的方向，就**顺着他的方向写下去** —— 那比硬拉回大纲好得多；',
        '- 拍的目标与他已做的事**不能矛盾**：他要是已经跟人撕破脸，就别安排「两人和和气气地谈一次」；',
        '- 但也不要写成「因为他说了 X，所以全世界立刻顺着 X 变」：世界有自己的惯性与别人的目的，反应要有迟滞、有杂音。',
        '',
    );

    // ── ★ 合理性自检：落笔**之前**就把走不通的拍换掉 ──
    //   路线 A：审查不该只靠正文模型写完之后的自觉回报（它经常硬演、不报），设计阶段就该自查一遍。
    //   放在**同一次调用**里，所以不多花一次钱。
    lines.push(
        '⚠ **交稿前的合理性自检（必须做，不是可选）**：',
        '把你想好的每一拍，拿**最近对话里的实际处境**过一遍 —— 时间（此刻是白天还是深夜、事情进行到哪一步）、',
        '地点（他们现在在哪、能不能在这里发生）、在场的人（谁在场、谁不在、谁现在不可能出现）、',
        '关系与情绪状态（刚翻过脸的人不会并肩坐着喝茶）。然后：',
        '- 有**走不通**的拍 → **现在就换掉或挪个场合**（保持那一拍要达成的结果不变），不要原样交出去指望正文模型自己扛；',
        '- 换了之后要**重新排一遍顺序**，保证因果仍然接得上（这一拍之所以能发生，是因为上一拍留下了什么）；',
        '- **不许**为了让某一拍成立而硬加新角色 / 新地点 / 新势力 / 新前史；',
        '- 自检之后如果不足 3 拍，就补一拍**能从当前处境自然长出来**的，而不是把被换掉的那拍再写一遍。',
        '',
    );

    if (evolution) {
        lines.push('=== 本次的演化说明（优先满足）===', evolution, '');
    }

    if (regenerate && (rejected || beats.length)) {
        if (rejected?.scrap) {
            // ②/③ 级：整章废弃 —— 必须换一个真正立得住的设计，不能只是把原拍换个说法
            lines.push(
                '⚠⚠ 本次是**废弃这一章、重新设计**（不是局部微调）：',
                `原因：${rejected.reason || rejected.note || rejected.state}`,
                '这一章原来的设计**整体不成立** —— 所以：',
                '　· **不要**沿用原来的地点、人物组合、事件顺序；换一个在当前处境下真正立得住的开场与推进方式；',
                '　· **不要**把原来的那几拍换个说法重新端上来（那是同一份失败的设计）；',
                '　· 但**这一章要服务的长线目标不能丢**：它仍然要是这条长线上往前走的一段。',
                '　· 先读最近对话，看清此刻的时间、地点、在场的人与关系状态，从**能自然发生的事**起手。',
            );
            if (Array.isArray(rejected.badBeats) && rejected.badBeats.length) {
                lines.push(`　· 已被废弃的那一版拍（**仅供避免重复**，不要照着改）：${rejected.badBeats.join('；')}`);
            }
            lines.push('');
        } else {
            lines.push(
                '⚠ 本次是**重新设计**：正文模型在真正落笔时判定当前的拍在这个场景里站不住。',
                '请按**现在的处境**（最近对话里的时间、地点、在场的人、关系状态）重新设计，而不是把原来那几拍换个说法。',
            );
            if (rejected?.note) lines.push(`它的原话：${rejected.note}`);
            lines.push('');
        }
    }

    const curTitle = String(unwrap(main[MAIN_TITLE]) ?? '').trim();
    if (curTitle) lines.push(`当前正在演的章：「${curTitle}」${beats.length ? `（共 ${beats.length} 拍）` : ''}`);
    const curGoal = String(unwrap(main[MAIN_GOAL]) ?? '').trim();
    if (curGoal) lines.push(`当前章目标：${curGoal}`);

    lines.push(
        '',
        '这一章的要求：',
        partial
            ? `- 只写剩余的 ${budget} 拍（**宁少勿多**），每拍必须能在正文里被真正叙述出来，不要停在「即将发生」。`
            : `- 拍数 ${BEAT_MIN}~${budget} 拍（**宁少勿多**：一两拍能说清就别硬拆），每拍必须能在正文里被真正叙述出来，不要停在「即将发生」。`,
        '- 每拍独占一行，用 `1. ` 起头。',
        ...BEAT_FORMAT_RULES,
        '',
        '⚠ **这一章必须「有戏」**（这是主线与间章的分界）：',
        '- 至少要有一件**实质推进**的事，**以下任何一种都够**：',
        '  · **往上走**：变强了、挣到了、被认可了、拿到了资格 / 名分 / 位置、跨过了一个门槛；',
        '  · **往下沉**：付了代价、输了、被算计了、失去了谁；',
        '  · **关系挪了一格**：谁和谁更近 / 更远 / 摊牌了；',
        '  · **悬念揭开一点**：某个被瞒着的事露出了角。',
        '  ⚠ **不要**把「有人付出代价 / 不可逆」当成每章的门槛 —— 那样连着几章就只能靠越来越黑来升级。',
        '- **不要写成「赶路 / 逛街 / 跟着商队走 / 又过了一天」这类日常流水账** —— 那是**间章**的素材，不是主线的料；',
        '- 想在「路上」发生事情可以，但那件事本身必须够格：被劫、被查出、被认出来、撞见了不该撞见的人、听到了不该听的话；',
        '- 想写轻松段落也可以，但它只能是**拍与拍之间的呼吸**，不能整章都是。',
        '- **别往一个方向滑**：反派、阴谋、跟踪、背叛**可以出现**，但不是默认走向；',
        '  「一步步攒起来、稳步变强、最后迎一场堂堂正正的高潮」同样成立 —— 甚至更耐看。',
        '',
        '⚠ **这一章必须有一个「矛盾」——它是驱动这一章的东西**（不是可选项，也不是「有人倒霉」）：',
        '- 这里的「矛盾」是**辩证意义上的**：**两样不能同时满足的东西**。缺了它，这一章就只是「发生了些事」，没有东西在推。',
        '- 常见形态（任一即可，也可以叠）：',
        '  · **想要 vs 挡着**：一个明确的目标，遇上不愿意让它发生的人 / 条件；',
        '  · **两难**：两个都要，但只能选一个（留住她 vs 拿到那个机会）；',
        '  · **身份冲突**：他现在的处境要求他做一件事，而他的原则 / 感情不允许；',
        '  · **两个都在理**：两边都站得住，谁也说服不了谁。**这种最耐看** ——',
        '    反派不必是坏人，对立方只是**要的东西不一样**（对手也想赢、家里人也为他好、同僚也有自己的难处）。',
        '- ⚠ **矛盾不是「坏人对付他」**：不必有恶意，甚至不必有人做错事。',
        '  **要的是「两个不能同时满足的东西」**，而不是「又一个来找麻烦的人」。',
        '- **每一条拍都要服务于这个矛盾**：它让矛盾更尖锐、或让它换了个形态。',
        '  排拍的时候自问：**这条拍是在加压，还是在放掉压力？** 一条都不加压，那这一章就散了。',
        '- **章内走一遍「正—反—合」**：提出（矛盾亮相）→ 激化（代价变具体、退路被堵上）',
        '  → 转化（小高潮：某个选择被做出、某个结果落下来）→ 新状态（这一章的收尾，已经是新局面了）。',
        '- **不要在章内解决掉长线的那个大矛盾**：只处理它在**这一章**的那一层（这一场的对手、这一次的取舍）。',
        '',
        '⚠ **两种相反的失败，都要避免**：',
        '- **太弱**：只是「事情有点不顺」—— 没有真正对立的东西，读者不会在乎；',
        '- **太强**：一上来就是你死我活 —— 后面几章没有余地了，而且会把整条线推向黑暗（见上面「别往一个方向滑」）；',
        '- **每章都靠「有人来找麻烦」**：这是最省事也最偷懒的一种，连着几章就变成制式化。',
        '',
        '⚠ **这一章要有一个小高潮**（你要的是一章讲完一整件事，不是一章只走半步）：',
        '- 这一章的拍要拧成**一条自己的弧线**：起（怎么进这一章）→ 承（压力往上加）→ **小高潮**（这一章最要紧的那一下）→ 落（收场与余波）。',
        '- **小高潮** = 这一章那件最要紧的事**真的发生了**的那一刻：摊牌、比赛打到关键一局、事情成了或砸了、',
        '  某个一直悬着的东西落下来。「一直铺垫、什么都没落地」不算一章，那只是半章。',
        '- 小高潮之后**必须留一拍收尾**：写它的结果与余波（别人的察觉、关系的位移、接下来要面对什么）。',
        '- 但**别在这一章里把大高潮用掉**：那是篇章层的事（见上面给的大阶段）—— 该攒的还得攒。',
        '',
        `- 章目标也要写成**矛盾的走向**、且与 {{user}} 的行为无关：写成「局面从什么样变成什么样」，`,
        '  例如「那位客商原本够不着他 ↔ 现在能单独见到他了」。',
        '  不要写成「他查到 / 决定 / 阻止了什么」—— 章目标达成与否，要看**世界这边的状态**，不看 {{user}} 做了什么。',
        `- 整章的推进方式：让**别人**动起来（各自有目的：示好、试探、瞒着、交换、催逼）、让**事件**发生（来客、传话、差事、意外、误会），`,
        '  再用**伏笔**维持张力（一个被收起来的物件、一句没说完的话、一个被瞒住的行踪）。{{user}} 只是身处其中的人。',
        `- 整体节奏：${intensity.label} —— ${intensity.directive}`,
        '- 范围（scope）写清这一章**不碰**什么，避免把后面几章的东西提前用掉。',
        '- 章与章之间要能接力：新章的第一个条件应该是上一章结尾自然带出来的。',
        '',
        '按下面格式输出，标签原样照写，且**只输出一个区块**：',
        '',
        '<StoryChapters>',
        '章标题: 4~10 字的短标题',
        '分卷: 这一章属于哪一部（例如「第一卷 · 初雪」；不确定就与章标题一致）',
        '范围: 这一章写到哪里为止、不写什么',
        '章目标: 一句话写清这一章的**矛盾与它的走向** —— 「谁要什么 ↔ 什么挡着」（整章走完才算；与 {{user}} 的行为无关）',
        '　（例：「他想拿下那个名额 ↔ 对手也在争，而且比他更被看好」；',
        '　　不要只写一个方向 —— 要把**对立的那一边**写出来，否则这一章没有驱动力）',
        '拍:',
        '1. 第一拍……（谁做了什么 → 局面变成什么样）',
        '2. 第二拍……',
        partial ? `（只写剩余的 ${budget} 拍就停）` : `（共 ${BEAT_MIN}~${budget} 拍）`,
        '</StoryChapters>',
    );
    return lines.join('\n');
}

/**
 * 「间章」的设计提示词：一段**日常的幕**，与主线互斥。
 * 关键差别（必须在提示词里说透，否则模型会把间章写成第二个主线）：
 *   · 不推进主线，只演生活与人物；
 *   · **不必跑完**：拍只是素材，写到合适的地方就收；
 *   · 顺手埋伏笔，但不兑现、不点破。
 */
function buildInterludeChapterSystemPrompt({ rejected = null } = {}) {
    const s = settings();
    const root = rootOf();
    const main = mainOf(root);
    const budget = Math.max(1, Math.min(BEAT_MAX, Math.round(toNumber(s.interludeBeats, 3))));
    const history = completedMainTitles(root);
    const lines = [
        '你是「故事导演」的剧情设计师，为一个正在进行的角色扮演服务。',
        '你的唯一任务：设计一段**间章** —— 主线收着的时候演的一段**日常**。',
        '规则优先级：世界书「' + PLUGIN_WORLD + '」> 用户在本插件里的设定；角色卡自带设定只作可选参考。',
        '你不写正文，只交一份给叙事者照做的演出计划。',
        '',
        ...COMMON_RULES,
        '',
    ];

    const last = String(unwrap(main[MAIN_TITLE]) ?? '').trim();
    const lastGoal = String(unwrap(main[MAIN_GOAL]) ?? '').trim();
    const lastInterlude = String(s.run.lastInterlude || '').trim();
    if (last) lines.push(`刚刚收尾的主线章：「${last}」${lastGoal ? `（章目标：${lastGoal}）` : ''}`);
    if (history.length) lines.push(`这个故事走过的章：${history.join(' → ')}`);
    if (lastInterlude) lines.push(`上一段间章是「${lastInterlude}」——这一次换一个场合与切入点，不要重演。`);
    lines.push('');

    if (rejected?.note) {
        lines.push('⚠ 正文模型上一轮报了问题：' + rejected.note, '');
    }

    lines.push(
        '一段间章的要求：',
        '- **它不推进主线**：没有冲突升级、没有关键转折、没有新角色登场。日常、误会、闲话、旧事、节庆、赶路、闲聊都可以。',
        `- 给 ${budget} 个左右的**日常画面**（**宁少勿多**，2~3 个通常够了）：每个都能独立成一个小场景，顺序只是建议。`,
        '- **它们不是「必须完成的拍」**：叙事者可以只挑其中几个、也可以在任何一个之后收尾。所以每个画面都要自成一个小段落，不要写成一条非走完不可的锁链。',
        '- **顺手埋一根线**：至少有一个画面里带上一个**具体、可复述**的细节（一件被收起来的物件、一句没说完的话、一个对不上的说法），以后可以兑现 —— 但不要当场兑现、不要点破、不要解释它的意义。',
        '- **写的是「别人在过日子」**：谁在忙什么、谁跟谁拌了嘴、听说了一件旧事、谁送来了什么。不要把 {{user}} 写进拍里。',
        '- **场合要小**：一间铺子、一顿饭、一场雨、一次赶集。不要为了日常硬开一个大场面。',
        `- 整体节奏：${(INTENSITIES[s.intensity] || INTENSITIES.normal).label}。`,
        '',
        '按下面格式输出，标签原样照写，且**只输出一个区块**：',
        '',
        '<StoryInterludeChapter>',
        '标题: 4~10 字的短标题（例如「雨后的集市」）',
        '场合: 这一段大致发生在哪 / 什么时间（一句话）',
        '拍:',
        '1. 第一个日常画面……',
        '2. 第二个日常画面……',
        `（共 ${budget} 个左右，不必更多）`,
        '</StoryInterludeChapter>',
    );
    return lines.join('\n');
}

/**
 * 「史诗」（篇章）的设计提示词。
 *
 * 这是让主线不平淡的地方：先定一条**围绕 {{user}}** 的长线，章只是它的一拍。
 * 但两件事必须同时守住，否则就会走偏成「安排玩家」或「平铺直叙」：
 *   · 主角是他 —— 大势压在他与他身边的人事上；
 *   · 但不替他行动 —— 篇章写的是世界会怎么压过来，不是他会怎么做。
 */
function buildEpicSystemPrompt({ mode = 'establish', diverged = '', tone = '', chapter = 0 } = {}) {
    const root = rootOf();
    const main = mainOf(root);
    const history = completedMainTitles(root);
    const last = String(unwrap(main[MAIN_TITLE]) ?? '').trim();
    const lines = [
        '你是「故事导演」的**篇章设计师**，为一个正在进行的角色扮演服务。',
        mode === 'establish'
            ? '你的唯一任务：定下这个故事**围绕 {{user}} 的那条长线**（篇章）。之后每一章都只是它的一拍。'
            : '你的唯一任务：**按 {{user}} 实际做了什么，重新校准这条长线**（篇章）。他不是按剧本走的，你要跟着他改。',
        '规则优先级：世界书「' + PLUGIN_WORLD + '」> 用户在本插件里的设定；角色卡自带设定只作可选参考。',
        '你只交一份篇章，不写正文、不写台词。',
        '',
        '两条必须同时守住的原则：',
        '1. **主角是 {{user}}**：这条长线写的是「围绕他发生了什么事、他被卷进什么里面、他身边的人怎么变」。',
        '   与他无关的势力动向只作背景与压力，不要喧宾夺主。',
        '2. **绝不替他行动**：篇章规划的是**世界这边会怎么压过来**（谁会找上他、什么会落到他头上、局势怎么变），',
        '   不是「他会怎么做」。写「他在两难里」（不说他选了哪边）、写「有人逼他表态」（不说他答没答应）。',
        '   他中途走出剧本是常态，所以篇章要留出这种余地。',
        '',
        ...COMMON_RULES,
        '',
        '对「不平淡」的硬要求（这是这一层存在的理由）：',
        '- **不许把日常流水账当主线**：跟着商队走、赶路、逛街、吃饭这类事**不是主线的料**，它们是「间章」的素材。',
        // ★ 这一条是补反馈的：以前写「必须有人付出代价 + 必须不可逆」，
        //   于是每一章都被逼着往「更黑」升级 —— 一个 VTB 的故事被写成全是私生粉、跟踪、阴谋。
        //   其实「攒粉丝、赚钱、打进武道会」一样是主线，而且是更好看的那种。
        '- **有进展就够，不必每章都出事**：一章只要有**实质性的推进**就是合格的主线。合格的推进包括 ——',
        '  **往上走**（变强了、挣到了、被认可了、拿到了资格 / 名分 / 位置、跨过了一个门槛）、',
        '  **往下沉**（付了代价、输了、被算计了、失去谁）、**关系挪了一格**、**一个悬念被揭开一点**。',
        '  以上**任何一种都算**。不要把「有人付出代价 / 发生不可逆的事」当成每章的门槛 ——',
        '  那样连着几章就只能靠越来越黑来升级，最后整条线只剩阴谋与背叛。',
        '- **要有「势」**：每一章结束时，局面应该与开始时**不同**（更接近目标、或更难），而不是转了一圈回到原点。',
        '  ⚠ 是「不同」，**不是**「必须更险」—— 稳步登高同样是「势」。',
        '- **代价要真实，但不必每章都流血**：失去的东西可以是机会、时间、别人的信任、一段安稳；',
        '  也不一定每次都在这一章结算 —— 收益与代价可以**先攒着，晚点一起还**。',
        '- **允许串联**：一条主线可以去铺垫另一条主线（旧案牵出旧人、一个小差事引出一场清算）。',
        '  多个这样的线交织成一部史诗是受欢迎的，但每一条都要有自己的推进与后果，不能只是「下一步去哪」。',
        '- **日常与轻松的部分不要写进篇章**：那些交给间章去演。篇章只留能推动大势的东西。',
        '',
        '⚠ **基调别往一个方向滑 —— 这是这一层最容易被模型带偏的地方。**',
        '- **黑暗与光明都要有位置**：反派、阴谋、背叛、险境**可以出现**，但不是默认走向；',
        '  一步步积攒、稳步变强、被认可、最后迎来一场堂堂正正的高潮（打进决赛、开成一场演唱会、把店开起来），',
        '  **同样成立，而且往往更好看**。',
        '- **不要为了「刺激」硬塞阴暗**：连续几段都是「被人算计 / 被跟踪 / 被背叛」，读者会疲；',
        '  而且一路只剩防御的人，故事走不到任何值得庆祝的地方。',
        '- **看角色与当前处境该往哪走**：如果这个人现在最要紧的是涨粉、练功、攒钱、把事办成，',
        '  那就照这个写 —— 威胁与阻力**服务于这条线**（有人来抢资源、有人使绊子、有人看不起他），',
        '  而不是把线本身替换成一场围猎。',
        '- **大高潮可以来自「做到了」**：赢了比赛、突破了瓶颈、被当众认可 —— 这些与「失去了什么」一样是高潮。',
        '',
        '⚠ **篇章是「大势」，不是章纲 —— 这是这一层最容易写坏的地方。**',
        '- **不许把篇章写成「接下来几章分别干什么」**：那是主线的事。你写的是**整部戏的骨架**，',
        '  粒度比一章大得多：一章可能整章都在同一个阶段里，也可能一章就把一个阶段走完。',
        '- **你不负责排章节、也不排「起承转合」**：一章内部的起承转合由主线自己设计（你要相信它做得好）。',
        '  一写「第一段是起、第二段是承」，你就把篇章压成了章纲，这一层就白设了。',
        '- **要写的是「势」怎么变**：谁和谁的关系到了哪一步、什么东西从背景走到台前、局面朝哪边动了。',
        '- **大事件不等于长线**：大事件是「发生了什么」，长线是「这一路他要付什么代价、变成什么样」。',
        '  只堆大事件就会变成大纲流水账 —— 每个阶段都要带着「对他意味着什么」。',
        '',
        '⚠ **但更要紧的是：这是一条「有归宿」的完整弧线，不是一串越来越大的事件。**',
        '- **先定下那个贯通的矛盾**：这条线从头到尾在争什么？（谁要什么、谁挡着、为什么现在非解决不可）',
        '  「每章都发生了点事」不等于有矛盾 —— 没有那个贯通的矛盾，阶段就只是一串事件，读者感觉不到「在往哪儿去」。',
        '  这个矛盾是「篇章」那一句的核心；每个阶段都在它上面加上一层新的压力或代价。',
        '一条只有「不断升级」的篇章会越写越夸张，最后收不了场（也写不出回报与余味）。所以：',
        '- **必须写得出归宿**：这几个阶段要能收束到**一个具体的结果**——事情解决了 / 没能解决但付出去了代价 / 他变成了不一样的人。',
        '  最后一个阶段就该是那个结果，而不是「更大的事又要来了」。',
        '- **回报与代价都要落地**：写了「险境」就要写「怎么出来」，写了「阴谋」就要写「揭破之后如何」。',
        '- **阶段 3~4 个为宜**：少于 3 个撑不起弧线，多于 5 个就是在排章节表了。',
        '- **允许篇章走完**：这条线讲完之后就该收，到时候你会被请来**定下一条新的长线**。',
        '  所以**不要为了「永远写下去」而故意不收束** —— 有始有终才是完整的故事。',
        '',
        '⚠ **两级高潮：你负责「大高潮」落在哪，主线负责「每章一个小高潮」。**',
        '- **大高潮在篇章层**：这几个阶段要有一个**明显的高点**（这条线最要紧的那一场），',
        '  它应该落在**靠后的那个阶段**里 —— 不是最后一段的余波，也不是第 2 章就烧掉。',
        '  在走向里**点明它是哪一场**（例如「武道会决赛那场」「演唱会当晚」），让主线知道要往那里攒。',
        '- **大高潮之前要有「攒」的过程**：至少有两个阶段是在**往那个高点蓄力**（长本事、攒人望、铺关系、解决挡路的小麻烦）；',
        '  不要一路靠出更大的事把人推着走 —— 那样到了高潮也没有可用的本钱。',
        '- **大高潮之后留一个收束阶段**：写它的结果与之后的样子（成了什么样、失去了什么、下一步是什么）。',
        '- **每一章有自己的小高潮**（那一章最要紧的一下真的发生）—— 那是**主线**的事，你不排，',
        '  但你给的阶段要**留得出**这种空间：别把阶段写成一串「必须连续承受打击」的压迫，那样每章都只能应付、立不起自己的高点。',
        '',
    ];

    if (tone) {
        lines.push(
            '===== 基调（用户选的，最高优先级的创作方针）=====',
            tone,
            '===== 基调结束 =====',
            '',
        );
    }

    if (mode === 'establish') {
        if (history.length) lines.push(`这个故事已经走过的章：${history.join(' → ')}（新篇章要接得上它们）。`);
        if (last) lines.push(`当前正在演的章：「${last}」——可以把它当成这条长线的开场，也可以重新定位它。`);
        if (chapter > 0) lines.push(`这条线从**当前这一章（第 ${chapter} 章）**开始排；走向第 1 段就该是「接下来马上要发生的事」。`);
        lines.push('请从**现在的处境**出发：读最近对话，看他是谁、他身边有谁、他手里有什么、什么东西正在逼近他。');
    } else {
        lines.push('本次是**重新校准**，请按下面这些事实改写篇章：');
        if (last) lines.push(`最近一章：「${last}」`);
        if (history.length) lines.push(`走过的章：${history.join(' → ')}`);
        const chapterGoals = completedChapterGoals(rootOf());
        if (chapterGoals.length) lines.push(`每一章实际达成的目标（**这是长线真正走过的路，以它为准**）：${chapterGoals.join('；')}`);
        if (diverged) lines.push(`⚠ 偏离说明（正文模型的回报）：${diverged}`);
        lines.push(
            '',
            '⚠ **先做一次自检，再改**（这一步不能跳过）：',
            '- 拿上面「每一章实际达成的目标」回头看：**当前这一段大阶段是不是还走得通？**',
            '  如果实际剧情已经把这一段架空了（该发生的事发生不了了、该出现的人不在了、代价已经被付掉了），',
            '  就**重设这一段**，而不是硬把它圆回去。',
            '- 自检的判据只有一条：**下一章还能从当前处境里自然长出来吗？** 长不出来，就是方向要改。',
            '',
            '校准的原则（**长线不要丢，路线可以改**）：',
            '- 已经发生的事**不可撤销**：把它们全部并入「既成事实」，后面的一切建立在上面；',
            '- 他做过的事、他表过的态，就是这条长线现在的走向 —— 不要假装没发生，也不要拉他回去；',
            '- 如果他的做法让原来的走向不成立了，就**换一条通往同一个终局的路**（保留他在乎的东西与要付的代价，改中间的路径）；',
            '- 如果他走出了一个完全没想到的方向，就**顺着他的方向重新想这个故事的去处与终局** —— 那可能比原来的更好；',
            '- 走向只保留**从现在往后还成立的 3~4 个大阶段**；已经走完的不要留，也不要在阶段里排章节；',
            '- **粒度要守住**：如果你写出来的走向已经细到「下一章该演什么」，那就是写错了层级 —— 那是主线的事。',
        );
    }

    lines.push(
        '',
        '按下面格式输出，标签原样照写，且**只输出一个区块**：',
        '',
        '<StoryEpic>',
        '标题: 这条长线的名字（6~14 字，例如「商路上的三封密信」）',
        '篇章: 两三句话说清这条线是什么、**在争什么**、他在其中的位置、以及为什么这事躲不掉',
        '走向: 这条长线的**几个大阶段**（整部戏的骨架，3~4 个；**不是章节表、不要写起承转合**）',
        '1. （一大段：局势处在什么局面；这一段里他在**攒**什么 —— 本事、人望、资源、关系；什么东西在变）',
        '2. （再一大段：往高点蓄力的过程；阻力与「服务这条线的人」同时出现）',
        '3. （**大高潮**：点明它是**哪一场** —— 例如「武道会决赛那场」「演唱会当晚」；这一场要让攒的东西全部兑现）',
        '4. （收束：这一场之后是什么结果、他变成了什么样 —— 不是「更大的事又要来了」）',
        '（3~4 条，每条是**一大块**，粒度远大于一章；每章只在这几段里推进一点。',
        '  **大高潮那一段不必是最后一段** —— 高潮之后留一段收束更好）',
        '伏笔: 三到六个还没兑现的细节，用「；」分开（要具体到能被复述）',
        '既成事实: 已经发生、不可撤销的事（用「；」分开；第一次定篇章时写现在的处境）',
        '当前进程: 启程 / 试炼 / 至暗 / 转折 / 终局（选一个，标记整条线走到哪儿了）',
        '</StoryEpic>',
        '',
        '⚠ 走向写的是**世界的动作**，不是{{user}}的动作：',
        '好例子：「使团的密信被人劫走，他的差事变成了别人的把柄」',
        '坏例子：「他决定暗中调查密信的去向」← 这是替他做决定',
        '⚠ 走向也**不要写成**「1. 起：… 2. 承：…」这种一章一段的章纲 —— 那是主线的工作。',
        '⚠ 但也**不要**把 3~4 段全写成「一次比一次更惨的打击」：登高型的故事',
        '  （攒起来 → 登上高处 → 在大场面兑现）同样是对的写法，就看这个角色与当前处境该走哪条路。',
    );
    return lines.join('\n');
}

function buildThreadSystemPrompt() {
    const s = settings();
    const root = rootOf();
    const main = mainOf(root);
    const live = liveThreads();
    const lines = [
        '你是「故事导演」的剧情设计师。',
        '你的唯一任务：设计**一条支线**——一个与主线并行、但不会抢戏的短插曲式小线。',
        '',
        ...COMMON_RULES,
        '',
        `当前主线：${String(unwrap(main[MAIN_TITLE]) ?? '').trim() || '（未开篇）'}${String(unwrap(main[MAIN_GOAL]) ?? '').trim() ? ` —— ${String(unwrap(main[MAIN_GOAL])).trim()}` : ''}`,
        `本轮聚焦：第 ${currentBeat(main)} 拍`,
    ];
    if (live.length) {
        lines.push(`已经在演的支线（新支线不要与它们撞车、不要替它们收尾）：${live.map((item) => String(unwrap(item[THREAD_FIELDS.title]) ?? item.id)).join('、')}`);
    }
    lines.push(
        '',
        '一条支线的要求：',
        '- 它必须**服务于主线**：要么给主线提供动机、线索或压力，要么让人物的关系状态发生变化；不许与主线无关地自娱自乐。',
        ...BEAT_FORMAT_RULES,
        '- 篇幅极小：**一条支线只写一个落点**（一个画面、一次对话、一个发现），不要写成多拍的长线。',
        '- 切入要轻：从最近对话里已经有的场合、人物、物件长出来，不要凭空开一个新场景。',
        '- 它不能越过主线当前的进度：不要让第三方、秘密或冲突提前发生。',
        '- **触发支线的必须是别人**：某个 NPC 起了念头、做了件事、放了句风，而不是 {{user}} 去问了、去做了。',
        `- 节奏：${(INTENSITIES[s.intensity] || INTENSITIES.normal).label}。`,
        '',
        '按下面格式输出，标签原样照写，且**只输出一个区块**：',
        '',
        '<StoryThreads>',
        '标题: 4~10 字的短标题',
        '目标: 这条支线要达成什么（一句话；与 {{user}} 的行为无关）',
        '切入: 谁做了什么 / 发生了什么小状况，让这条线自己冒出来（不要写 {{user}} 去触发）',
        '落点: 它演到什么程度就算收（一个可以在正文里被写出来的小结果）',
        '时限: 建议在几轮内收掉（一个数字，例如 3）',
        '</StoryThreads>',
    );
    return lines.join('\n');
}

function buildInterludeSystemPrompt() {
    const s = settings();
    const root = rootOf();
    const main = mainOf(root);
    return [
        '你是「故事导演」的剧情设计师。',
        '你的唯一任务：设计**一条插曲**——主线之外的一个幕间小段，用来让故事喘口气。',
        '',
        ...COMMON_RULES,
        '',
        `当前主线：${String(unwrap(main[MAIN_TITLE]) ?? '').trim() || '（未开篇）'}${String(unwrap(main[MAIN_GOAL]) ?? '').trim() ? ` —— ${String(unwrap(main[MAIN_GOAL])).trim()}` : ''}`,
        `本轮聚焦：第 ${currentBeat(main)} 拍`,
        '',
        '一条插曲的要求：',
        '- **它不推进主线**：没有冲突升级、没有关键转折、没有新角色登场。它是日常、误会、闲话、旧事回忆、节庆、赶路、闲聊。',
        '- **它是「别人在过日子」，不是「{{user}} 去做了什么」**：谁在忙什么、谁跟谁拌了嘴、听说了一件旧事、谁送来了什么。',
        '- 它要有**呼吸感**：写出人物的生活质感与性格侧面，让读者觉得这些人真的在过日子。',
        '- 它可以顺手**埋一根线**（一个以后会兑现的细节），但不要当场兑现，也不要点破。',
        '- 篇幅：一到两个画面就该结束，不要展开成大场面。',
        `- 节奏：${(INTENSITIES[s.intensity] || INTENSITIES.normal).label}。`,
        '',
        '按下面格式输出，标签原样照写，且**只输出一个区块**：',
        '',
        '<StoryInterlude>',
        '标题: 4~10 字的短标题',
        '内容: 这一段里**别人 / 环境**发生了什么（一到两句，具体到画面；不要写 {{user}} 做什么）',
        '接在: 主线第几拍之后演（写一个数字，例如 第 3 拍之后；说了随时就写 随时）',
        '</StoryInterlude>',
    ].join('\n');
}

async function buildUserPrompt(task, userText = '') {
    const blocks = await collectContextBlocks(task);
    const ask = String(userText || '').trim();
    // ★ 钉住的用户要求（若已钉）—— 每轮都带上，这样插件自己触发的重生成也不会把它丢掉。
    const pinned = pinnedAskText(task);
    if (pinned) blocks.push(`=== 用户钉住的要求（**每一轮都要满足**，与其它规则冲突时以它为准）===\n${pinned}`);
    if (ask) blocks.push(`=== 用户的额外要求（优先满足）===\n${ask}`);
    const anti = antiRepeatBlock();
    if (anti) blocks.push(anti);
    const tail = {
        chapter: '请按上面的格式输出一个 <StoryChapters> 区块。',
        thread: '请按上面的格式输出一个 <StoryThreads> 区块。',
        interlude: '请按上面的格式输出一个 <StoryInterludeChapter> 区块。',
        side: '请按上面的格式输出一个 <StoryInterlude> 区块。',
        epic: '请按上面的格式输出一个 <StoryEpic> 区块。',
    }[task] || '';
    if (tail) blocks.push(tail);
    return blocks.filter(Boolean).join('\n\n');
}

// 阶段九：神谕联动（生成 / 采用 / 模式注册）

/**
 * 通用对话框：把一段自建内容放进酒馆的标准弹窗里，带自定义按钮。
 *
 * 用**原生 `<dialog>`**（酒馆的弹窗就是它）而不是自己搭浮层，好处是不用处理层级 / 遮罩 / Esc：
 * 我们的面板嵌在酒馆页面里，自己搭的浮层容易被外面的层叠上下文夹住。
 *
 * @param {object} spec
 * @param {string} spec.title 窗口标题
 * @param {string|HTMLElement} spec.body 正文（HTML 字符串或现成节点）
 * @param {Array<{label:string,result:*,kind?:'ok'|'cancel',emit?:boolean}>} spec.actions 按钮
 * @returns {Promise<*>} 点中的按钮 result（emit 时会把 [data-field] 的值挂成 `result.fields`）；
 *                       按 Esc / 点遮罩关闭时回 null
 */
function storyDialog({ title, body, actions = [] }) {
    return new Promise((resolve) => {
        // 同一时间只允许一个导演弹窗：先清掉可能残留的（Esc / 切页 / 重渲染都可能留下一个开着的）。
        for (const old of document.querySelectorAll('dialog.sd-dialog')) {
            try { old.close(); } catch { /* 已经关了 */ }
            old.remove();
        }

        const dialog = document.createElement('dialog');
        dialog.className = 'sd-dialog';
        const box = document.createElement('div');
        box.className = 'sd-dialog-box';

        const head = document.createElement('div');
        head.className = 'sd-dialog-head';
        head.textContent = title;
        box.appendChild(head);

        const content = document.createElement('div');
        content.className = 'sd-dialog-body';
        if (typeof body === 'string') content.innerHTML = body;
        else content.appendChild(body);
        box.appendChild(content);

        let settled = false;
        const finish = (value) => {
            if (settled) return;
            settled = true;
            try { dialog.close(); } catch { /* 已经关了 */ }
            dialog.remove();
            resolve(value);
        };

        const row = document.createElement('div');
        row.className = 'sd-dialog-actions';
        for (const action of actions) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = action.kind === 'ok' ? 'sd-btn sd-btn-primary' : 'sd-btn';
            button.textContent = action.label;
            button.addEventListener('click', () => {
                // emit：把表单里所有 [data-field] 读出来挂在 result 上（「按这些要求生成」那种）
                const value = action.result;
                if (action.emit && value && typeof value === 'object') value.fields = readDialogFields(content);
                // emitText：把内容里那个输入框的值直接当结果返回（给「只想收一段文字」的调用方用）
                if (action.emitText) {
                    const node = content.querySelector('[data-field="ask"], textarea, input');
                    return finish(node ? node.value : '');
                }
                finish(value);
            });
            row.appendChild(button);
        }
        box.appendChild(row);
        dialog.appendChild(box);

        // Esc 键 → 视为取消（浏览器会自己关；拦截 close 事件以便 resolve）
        dialog.addEventListener('cancel', (event) => { event.preventDefault(); finish(null); });
        // 点遮罩（dialog 本体，不含内部盒子）→ 取消
        dialog.addEventListener('click', (event) => { if (event.target === dialog) finish(null); });
        dialog.addEventListener('close', () => finish(null));

        document.body.appendChild(dialog);
        dialog.showModal();
        const first = content.querySelector('textarea, input, select');
        if (first) setTimeout(() => first.focus(), 30);
    });
}

/** 从对话框内容里读出所有 [data-field] 控件的值。 */
function readDialogFields(container) {
    const out = {};
    container.querySelectorAll('[data-field]').forEach((node) => { out[node.dataset.field] = node.value; });
    return out;
}

let storyGenerating = false;
/** 上一次开始生成的时间戳：用来兜住「模型请求挂死」——否则 storyGenerating 永远是 true，整个插件不动。 */
let storyGeneratingSince = 0;
/** 一次生成最多允许挂多久（毫秒）。超过就当成死了，放开闸门重试。 */
const GENERATE_WATCHDOG = 4 * 60 * 1000;

/** 开始一次生成：顺带做看门狗检查（超时就当上一次已经死了）。 */
function beginGenerate() {
    if (storyGenerating) {
        const hung = storyGeneratingSince && Date.now() - storyGeneratingSince > GENERATE_WATCHDOG;
        if (!hung) return false;
        console.warn(`[故事导演] 上一次生成已经挂了 ${Math.round((Date.now() - storyGeneratingSince) / 1000)} 秒，判定为死掉，放开闸门重试。`);
        storyGenerating = false;
        storyGeneratingSince = 0;
    }
    storyGeneratingSince = Date.now();
    return true;
}

function endGenerate() {
    storyGenerating = false;
    storyGeneratingSince = 0;
}

/**
 * 生成失败的退避表：key → 失败时间戳。
 * ⚠ 以前是个「只加不减」的 Set —— 一次偶发失败（网络抖一下 / 神谕吐不出格式）就把那一路生成
 * **永久**关掉，而且悄无声息。这正是「主线一直不生成」的主因。
 * 现在改成有时间窗的退避：窗口内不重试（省调用），窗口一过自动放行。
 */
const failedKeys = new Map();
const GENERATE_RETRY_BACKOFF = 90 * 1000;
function markFailed(key) { failedKeys.set(key, Date.now()); }
function clearFailed(key) { failedKeys.delete(key); }
/** 正在生成中的标记（异步期间不再重复排队）。与失败退避分开存，语义不混。 */
const pendingGenerates = new Set();
const isPending = (key) => pendingGenerates.has(key);
const markPending = (key) => pendingGenerates.add(key);
const clearPending = (key) => pendingGenerates.delete(key);

function isBackingOff(key) {
  const at = failedKeys.get(key);
  if (!at) return false;
  if (Date.now() - at > GENERATE_RETRY_BACKOFF) { clearFailed(key); return false; }
  return true;
}

function oracleApi() { return window.StoryOracleAPI; }

/**
 * 从用户在神谕窗口里打的那句话里嗅出任务类型。
 * ⚠ system 提示词与 user 尾注必须用**同一个**判定，否则会出现「system 要插曲格式、user 尾注要
 * <StoryChapters>」这种自相矛盾的要求（模型只能两套格式对撞）。
 */
function taskFromText(userText) {
    const ask = String(userText || '').trim();
    if (/支线|旁支|side/i.test(ask)) return 'thread';
    if (/插曲|幕间|日常/i.test(ask)) return 'interlude';
    return 'chapter';
}

/** onSend（神谕窗口里的「故事导演」模式）只给任务，上下文由神谕自己带。 */
function modeSystemPrompt(userText) {
    const task = taskFromText(userText);
    if (task === 'thread') return buildThreadSystemPrompt();
    if (task === 'interlude') return buildInterludeSystemPrompt();
    return buildChapterSystemPrompt();
}

/** 借神谕的模型连接裸调用一次（不带任何上下文 → 我们自己把上下文拼进去）。 */
async function askOracle({ task = 'chapter', userText = '', regenerate = false, rejected = null, keep = 0, remaining = 0, quiet = true, ephemeralSystem = '' } = {}) {
    const api = oracleApi();
    if (typeof api?.run !== 'function') {
        if (!quiet) toast('没有可用的模型连接——需要启用「故事神谕」扩展。也可以在主线上直接手写。', 'warning');
        return null;
    }
    const system = ephemeralSystem || (task === 'thread' ? buildThreadSystemPrompt()
        : task === 'side' ? buildInterludeSystemPrompt()
            : task === 'interlude' ? buildInterludeChapterSystemPrompt({ rejected })
                : buildChapterSystemPrompt({ regenerate, rejected, keep, remaining: Math.max(0, Math.round(toNumber(remaining, 0))) }));
    const user = await buildUserPrompt(task, userText);
    // ⚠ **绝不往神谕窗口里写东西**（这一条是补事故）。
    //   这里以前用 api.appendReply() 把「导演请求全文」和「模型原始回复」追加进神谕的对话里 ——
    //   后果有两个，都很难绷：
    //     ① 神谕窗口里会冒出一大段**正文**（模型偶尔不按 <StoryChapters> 输出而写成散文，也会被原样贴进去）；
    //     ② 那两条是 assistant 消息、还会 persistConvo() 存进聊天，等于把导演的提示词污染进神谕自己的历史。
    //   神谕的 api.run() 是**裸调用**（只带我们给的这两条消息、不带它的对话），所以想不留痕根本不用它提供机制 ——
    //   不发 appendReply 就够了。真要排查，看控制台与面板「诊断」页（生成闸门 / 世界书 / 实际注入的引导全文）。
    if (!quiet) console.debug(`[故事导演] 本次生成（${task}）的提示词与原始回复不写入神谕窗口；需要排查见面板「诊断」页。`);
    const result = await api.run([
        { role: 'system', content: system },
        { role: 'user', content: user },
    ]);
    return String(result ?? '');
}

/**
 * 解析并采用一条主线。
 *
 * ★ `keep` 的语义（这一条是补事故的）：
 *   · `undefined`（默认）→ **自动**：这一章已经演过几拍就保住几拍，新给的拍接在**后面**。
 *     —— 以前默认是 0，于是任何没显式传 keep 的路径都会把已演的拍全丢掉、拍号回到 1：
 *        用户演到第 2 拍、主线一重生成，就被打回第 1 拍重来。
 *   · `0` → **整章重来**（拍号从 1 开始）。只在「重新生成本章」这种明确说了推倒重写的入口用。
 *   · `>0` → 强制保留前 N 拍（「只重排剩下的拍」用）。
 *
 * `restart: true` 是 `keep: 0` 的显式写法（更不容易被误读），两者都表示整章重来。
 */
async function applyChapter(chapter, { live = null, quiet = false, keep = undefined, restart = false } = {}) {
    const s = settings();
    const fresh = Array.isArray(chapter?.[MAIN_BEATS]) ? chapter[MAIN_BEATS] : [];
    const previous = mainState(live);
    const old = beatsOf(previous);
    // 已经真的演过几拍：以 MVU 里的「当前拍 - 1」为准（这是唯一的真相来源）
    const alreadyPlayed = Math.max(0, Math.min(old.length, currentBeat(previous) - 1));
    const played = restart || keep === 0
        ? 0                                                   // 明确要求整章重来
        : (keep === undefined || keep === null
            ? alreadyPlayed                                   // 默认：保住已演的，接着往后排
            : Math.max(0, Math.min(old.length, Math.round(toNumber(keep, 0)))));
    if (!fresh.length && played <= 0) {
        if (!quiet) toast('这一章没有拍列表，没有采用。', 'warning');
        return false;
    }
    // 先把新给的拍裁到剩下的额度里，再拼接：这样总拍数**永远**不超过 BEAT_MAX，
    // 与注入（renderMainSection 的 maxBeats）和状态机（beats.length）三处同源。
    // 保住已演过的、只换掉后面的 —— 算法在 model.js 里（纯函数，可离线测）。
    const beats = mergeBeats(old, played, fresh, BEAT_MAX);
    const fields = {
        [MAIN_TITLE]: played > 0 ? (String(unwrap(previous[MAIN_TITLE]) ?? '').trim() || chapter[MAIN_TITLE]) : chapter[MAIN_TITLE],
        [MAIN_ARC]: played > 0 ? (String(unwrap(previous[MAIN_ARC]) ?? '').trim() || chapter[MAIN_ARC]) : chapter[MAIN_ARC],
        [MAIN_SCOPE]: played > 0 ? (String(unwrap(previous[MAIN_SCOPE]) ?? '').trim() || chapter[MAIN_SCOPE]) : chapter[MAIN_SCOPE],
        [MAIN_GOAL]: played > 0 ? (String(unwrap(previous[MAIN_GOAL]) ?? '').trim() || chapter[MAIN_GOAL]) : chapter[MAIN_GOAL],
        [MAIN_BEATS]: beats,
        [KEY_BEAT]: played + 1,
        [KEY_BEAT_DONE]: false,
        [KEY_CHAPTER_DONE]: false,
        [KEY_READY]: false,
        [KEY_REVIEW]: REVIEW_PASS,
        [KEY_REVIEW_NOTE]: '',
        [MAIN_STARTED]: played > 0 ? (String(unwrap(previous[MAIN_STARTED]) ?? '') || new Date().toISOString()) : new Date().toISOString(),
        [MAIN_ENDED]: '',
    };
    await patchMain(fields, { live });
    const rt = s.run;
    rt.focusBeat = played + 1;
    rt.beatAt = aiMessageCount();
    rt.chapterOpenedAt = rt.beatAt;
    // 支线／插曲的节奏基准一起播在开章这一刻：这一个间隔之内只推主线，
    // 满了一个间隔才开始考虑往里面插配菜（挂机/狂点都不会提前）。
    rt.threadAt = rt.beatAt;
    rt.interludeAt = rt.beatAt;
    rt.redesigns = 0;
    save();
    syncMainInjection();
    if (!panel?.hidden) render();
    if (!quiet) {
        toast(played > 0
            ? `已重排第 ${played + 1} 拍起的内容（共 ${beats.length} 拍，前 ${played} 拍没动）。`
            : `已开新章「${chapter[MAIN_TITLE]}」（${beats.length} 拍），从下一轮开始引导。`, 'success');
    }
    return true;
}

async function applyThread(thread, { live = null, quiet = false } = {}) {
    const id = thread.id || nextId(threadsState().map((item) => item.id), 't');
    await patchEntry('支线', id, thread, { live });
    if (!quiet) toast(`已接入支线「${String(thread[THREAD_FIELDS.title] || id)}」。`, 'success');
    syncMainInjection();
    if (!panel?.hidden) render();
    return true;
}

async function applyInterlude(interlude, { live = null, quiet = false } = {}) {
    const id = interlude.id || nextId(interludesState().map((item) => item.id), 'i');
    await patchEntry('插曲', id, interlude, { live });
    if (!quiet) toast(`已安排插曲「${String(interlude[INTERLUDE_FIELDS.title] || id)}」。`, 'success');
    syncMainInjection();
    if (!panel?.hidden) render();
    return true;
}

/** 采用一段间章：进间章幕、写盘、把节奏基准一起播下。 */
async function applyInterludeChapter(chapter, { live = null, quiet = false } = {}) {
    const s = settings();
    const beats = Array.isArray(chapter?.[IL.beats]) ? chapter[IL.beats] : [];
    const fields = { ...emptyInterlude(), ...chapter, [IL.active]: true, [IL.beat]: 1, [IL.beatDone]: false, [IL.done]: false, [IL.ready]: false };
    await patchInterlude(fields, { live });
    await patchMain({ [MAIN_CLOSED]: true, [KEY_READY]: false }, { live });
    const rt = s.run;
    rt.mode = 'interlude';
    rt.focusInterlude = 1;
    rt.beatAt = aiMessageCount();
    rt.interludeAt = rt.beatAt;
    rt.lastInterlude = String(chapter?.[IL.title] ?? '').trim();
    rt.redesigns = 0;
    save();
    syncInterludeWrites();
    syncMainInjection();
    if (!panel?.hidden) render();
    if (!quiet) {
        toast(beats.length
            ? `已开间章「${rt.lastInterlude || '日常'}」（${beats.length} 个日常画面，不必全演）。`
            : `已开间章「${rt.lastInterlude || '日常'}」。`, 'success');
    }
    return true;
}

/** 生成一段间章（与主线互斥的那一幕）。 */
async function generateInterludeChapter({ quiet = true, userText = '', force = false, rejected = null } = {}) {
    if (!mvu()?.getMvuData) {
        if (!quiet) toast('MVU 未加载：先确认酒馆助手与 MVU 装好了、这个聊天有变量。', 'warning');
        return false;
    }
    const key = `interlude-chapter:${chatKey()}`;
    if (!beginGenerate()) return false;
    if (!force && isBackingOff(key)) return false;
    if (quiet) toast('正在请故事神谕设计一段间章…');
    const origin = chatKey();
    try {
        const raw = await askOracle({ task: 'interlude', rejected, quiet, userText });
        if (raw === null) { markFailed(key); return false; }
        if (origin && chatKey() !== origin) {
            console.info('[故事导演] 生成期间切换了聊天，这段间章（属于旧聊天）没有落盘。');
            return false;
        }
        const blocks = parseBlocks(raw, 'StoryInterludeChapter');
        const chapter = blocks.length
            ? interludeChapterFromBlock(blocks[blocks.length - 1], { beatBudget: Math.max(1, Math.round(toNumber(settings().interludeBeats, 3))) })
            : null;
        if (!chapter) {
            console.info('[故事导演] 神谕没有返回 <StoryInterludeChapter> 区块，原始回复：\n' + raw);
            toast('没解析到 <StoryInterludeChapter> 区块，原始回复已打印到控制台。', 'warning');
            markFailed(key);
            return false;
        }
        clearFailed(key);
        await applyInterludeChapter(chapter, { quiet: false });
        return true;
    } catch (error) {
        console.debug('[故事导演] 生成间章失败', error);
        toast(`生成失败：${error?.message || error}`, 'error');
        markFailed(key);
        return false;
    } finally {
        endGenerate();
        if (panel && !panel.hidden) render();
    }
}

/**
 * 「手动定篇章」弹窗：让用户先说说她想要什么样的篇章，留空就走默认。
 *
 * 返回 true = 已经发起生成；false = 用户取消了。
 */
async function openEpicDialog({ mode = 'establish', entry = 0, diverged = '' } = {}) {
    const s = settings();
    const rebuilding = mode === 'establish';
    const currentTone = TONES[toneOf(s.tone)]?.label || '自动';

    const body = document.createElement('div');
    body.className = 'sd-epic-form';
    const pinnedEpic = String(s.run.epicPin || '').trim();
    body.innerHTML = `
        <p class="sd-dialog-note">
            <b>篇章是「大势」不是章纲</b> —— 它只讲整部戏分几个大阶段、在争什么。
            一章内部怎么起承转合由主线自己设计，所以<b>不用在这里安排章节</b>。
        </p>
        ${pinnedEpic ? `<p class="sd-dialog-pin">📌 <b>已钉住的要求</b>（每轮都会带上，不会被重生成覆盖）：<br>${esc(pinnedEpic)}</p>` : ''}
        <label class="sd-dialog-field">
            <span>你对这条篇章的要求 / 倾向<b>（留空 = 让它自己按角色卡与当前剧情判断）</b></span>
            <textarea data-field="ask" rows="6" placeholder="例如：&#10;· 我想要一条关于「旧账被人翻出来」的线，别搞世界危机&#10;· 主角身边的人至少有一个会背叛，但不要太早&#10;· 结局别是简单的胜利，留一点没解决的东西&#10;· 少写打斗，多写人情与试探">${esc(pinnedEpic)}</textarea>
        </label>
        <div class="sd-dialog-row">
            <label class="sd-dialog-field"><span>基调（这条线是什么型的故事）</span>
                <select data-field="tone">
                    ${toneOptions().map((item) => `<option value="${esc(item.value)}" ${toneOf(s.tone) === item.value ? 'selected' : ''}>${esc(item.label)}</option>`).join('')}
                </select>
            </label>
        </div>
        <p class="sd-dialog-hint">当前基调：${esc(currentTone)}　·　${rebuilding ? '本次是<b>重新定篇章</b>（换一部）' : '本次是<b>按现在的情况重新校准</b>（长线不丢，路线可改）'}<br>
        💡 <b>「记住它」</b>= 以后每次重生成（包括审查打回、自动换章）都会带上这些要求，不会被覆盖。</p>
    `;

    const picked = await storyDialog({
        title: rebuilding ? '重新定篇章（换一部）' : '按现在的情况重新校准',
        body,
        actions: [
            { label: '取消', result: null, kind: 'cancel' },
            { label: '留空，让它自己判断', result: { go: true, ask: '' } },
            ...(pinnedEpic ? [{ label: '清掉钉住的要求', result: { go: false, clear: true } }] : []),
            { label: '按这些要求生成（只这一次）', result: { go: true, submit: true }, emit: true },
            { label: '记住它，每轮都带上', result: { go: true, submit: true, pin: true }, kind: 'ok', emit: true },
        ],
    });

    if (!picked) return false;                      // 取消 / Esc / 点遮罩
    if (picked.clear) { clearPin('epic'); toast('已清掉钉住的篇章要求。', 'info'); render(); return false; }
    if (!picked.go) return false;

    const ask = String(picked.ask || '').trim() || String(picked.fields?.ask || '').trim();
    // 弹窗里改过基调就顺手存下来（提示词会按新基调重写）。
    // ⚠ 只有「按这些要求生成 / 记住它」那条路才会带 fields；「留空」那条没有 —— 所以这里必须用 fields 判断，
    //   不能直接拿 fields?.tone 去算：toneOf(undefined) 会兜底成 'auto'，那会把用户原有的基调悄悄改掉。
    if (picked.fields) {
        const pickedTone = toneOf(picked.fields.tone);
        if (pickedTone !== toneOf(s.tone)) { s.tone = pickedTone; save(); }
    }

    // 钉住（「记住它」）或清掉（填了空又选了记住）
    if (picked.pin) {
        if (ask) { pinAsk({ task: 'epic', ask }); toast('已记住这条要求 —— 以后每次重生成都会带上它。', 'success'); }
        else { clearPin('epic'); }
    }

    const userText = userAskText(ask, 'epic');
    void generateEpic({ quiet: false, force: true, mode, entry, diverged, userText });
    return true;
}

/**
 * 「设计下一章 / 重新生成本章」弹窗：让用户先说说她想要这一章怎么写，留空就走默认。
 * 返回 true = 已经发起生成；false = 用户取消了。
 */
async function openChapterDialog({ regenerate = false } = {}) {
    const s = settings();
    syncChapterPin();                               // 章名变了就先把上一章的钉清掉
    const pinnedChapter = String(s.run.chapterPin || '').trim();
    const body = document.createElement('div');
    body.className = 'sd-chapter-form';
    body.innerHTML = `
        <p class="sd-dialog-note">
            <b>这是给「这一章」的方向，不是给整部戏的。</b>
            整部戏的大势由篇章管；这里写的只影响<b>接下来这一章</b>的拍列表。
        </p>
        ${pinnedChapter ? `<p class="sd-dialog-pin">📌 <b>已钉住的要求</b>（每次重生成都会带上，审查打回也不会丢）：<br>${esc(pinnedChapter)}</p>` : ''}
        <label class="sd-dialog-field">
            <span>你对这一章的要求 / 倾向<b>（留空 = 让它自己按当前处境判断）</b></span>
            <textarea data-field="ask" rows="6" placeholder="例如：&#10;· 这一章我想让她先发现自己被跟踪，别直接摊牌&#10;· 少写打斗，多写试探和眼神&#10;· 结尾留个钩子，但别把主线谜底揭开&#10;· 让那个配角这次站在她这边">${esc(pinnedChapter)}</textarea>
        </label>
        <label class="sd-dialog-field"><span>这一章几拍（共 3~6 拍）</span>
            <input data-field="beats" type="number" min="3" max="6" step="1" value="${esc(String(settings().beatTarget))}">
        </label>
        <p class="sd-dialog-hint">${regenerate ? '本次是<b>重新生成本章</b>（整章推倒重写）' : '本次是<b>设计下一章</b>'}　·　只想改后面几拍就用「主线」页的「只重排剩下的拍」。<br>
        💡 <b>「记住它」</b>= 以后每次重生成（包括正文模型把这一章打回、重排剩下的拍）都会带上这些要求，不会被覆盖。换章后自动失效。</p>
    `;

    const picked = await storyDialog({
        title: regenerate ? '重新生成本章' : '设计下一章',
        body,
        actions: [
            { label: '取消', result: null, kind: 'cancel' },
            { label: '留空，让它自己判断', result: { go: true, ask: '' } },
            ...(pinnedChapter ? [{ label: '清掉钉住的要求', result: { go: false, clear: true } }] : []),
            { label: '按这些要求生成（只这一次）', result: { go: true, submit: true }, emit: true },
            { label: '记住它，每轮都带上', result: { go: true, submit: true, pin: true }, kind: 'ok', emit: true },
        ],
    });

    if (!picked) return false;                      // 取消 / Esc / 点遮罩
    if (picked.clear) { clearPin('chapter'); toast('已清掉钉住的章节要求。', 'info'); render(); return false; }
    if (!picked.go) return false;

    const ask = String(picked.ask || '').trim() || String(picked.fields?.ask || '').trim();
    // 拍数顺手存下来（只有带 fields 的那两条路）
    if (picked.fields && picked.fields.beats !== undefined) {
        const beats = Math.max(BEAT_MIN, Math.min(BEAT_MAX, Math.round(toNumber(picked.fields.beats, settings().beatTarget))));
        if (beats !== settings().beatTarget) { settings().beatTarget = beats; save(); }
    }
    // 钉住（「记住它」）或清掉（填了空又选了记住）
    if (picked.pin) {
        if (ask) { pinAsk({ task: 'chapter', ask }); toast('已记住这一章的要求 —— 审查打回重排时也会带上它。', 'success'); }
        else { clearPin('chapter'); }
    }

    // ★「重新生成本章」= 用户明确说要推倒重写 → 允许拍号回到 1（restart）。
    //   其它所有路径（审查重排 / 重设计 / 采用 / 自动）都走自动保留，不会把进度打回去。
    void generateChapter({ quiet: false, regenerate, restart: regenerate, force: true, userText: userAskText(ask, 'chapter') });
    return true;
}

/** 生成 / 校准史诗（篇章）。entry = 这一份篇章算「校准到第几章」。 */
async function generateEpic({ quiet = true, userText = '', force = false, mode = 'establish', diverged = '', entry = 0 } = {}) {
    if (!mvu()?.getMvuData) {
        if (!quiet) toast('MVU 未加载：先确认酒馆助手与 MVU 装好了、这个聊天有变量。', 'warning');
        return false;
    }
    const key = `epic:${chatKey()}`;
    if (!beginGenerate()) return false;
    if (!force && isBackingOff(key)) return false;
    if (quiet) toast(mode === 'establish' ? '正在请故事神谕定下这条长线（篇章）…' : '正在按他实际做的事重新校准篇章…');
    const origin = chatKey();
    try {
        const raw = await askOracle({
            task: 'epic',
            ephemeralSystem: buildEpicSystemPrompt({
                mode,
                diverged,
                tone: toneDirective(settings().tone),
                chapter: Math.max(0, Math.round(toNumber(entry, 0))) + 1,
            }),
            quiet,
            userText,
        });
        if (raw === null) { clearFailed(key); return false; }
        if (origin && chatKey() !== origin) {
            clearFailed(key);
            console.info('[故事导演] 生成期间切换了聊天，这份篇章（属于旧聊天）没有落盘。');
            return false;
        }
        const blocks = parseBlocks(raw, 'StoryEpic');
        const epic = blocks.length ? epicFromBlock(blocks[blocks.length - 1], { chapter: entry }) : null;
        if (!epic || !epicStarted(epic)) {
            console.info('[故事导演] 神谕没有返回可用的 <StoryEpic> 区块，原始回复：\n' + raw);
            toast('没解析到 <StoryEpic> 区块，原始回复已打印到控制台。', 'warning');
            markFailed(key);
            return false;
        }
        await applyEpic(epic, { quiet: false, entry });
        return true;
    } catch (error) {
        console.debug('[故事导演] 生成史诗失败', error);
        toast(`生成失败：${error?.message || error}`, 'error');
        markFailed(key);
        return false;
    } finally {
        endGenerate();
        // pending 由本函数独家负责：无论成功、失败还是中途换了聊天，结束就放开
        clearPending(key);
        if (panel && !panel.hidden) render();
    }
}

/**
 * 生成新的一章主线（面板按钮 / 自动开章 / 重排剩余拍共用）。keep>0 时保留前 keep 拍不动。
 */
async function generateChapter({ quiet = true, regenerate = false, rejected = null, userText = '', force = false, keep = undefined, restart = false } = {}) {
    // ★ 先把 keep 归一成**明确的数字**，后面所有判断与落盘都用它。
    //   undefined = 自动：保住这一章已经演过的拍，新拍接在后面（默认行为，防「重生成把进度打回第 1 拍」）；
    //   0 / restart: true = 整章重来；
    //   >0 = 强制保留前 N 拍。
    {
        const current = mainState();
        const currentBeats = beatsOf(current);
        const playedNow = Math.max(0, Math.min(currentBeats.length, currentBeat(current) - 1));
        keep = (restart || keep === 0)
            ? 0
            : (keep === undefined || keep === null ? playedNow : Math.max(0, Math.round(toNumber(keep, 0))));
    }
    if (!mvu()?.replaceMvuData && !mvu()?.getMvuData) {
        if (!quiet) toast('MVU 未加载：先确认酒馆助手与 MVU 装好了、这个聊天有变量。', 'warning');
        return false;
    }
    const key = `chapter:${chatKey()}:${regenerate ? 're' : 'new'}`;
    if (!beginGenerate()) return false;
    if (!force && isBackingOff(key)) return false;
    const button = panel?.querySelector('.sd-generate-chapter');
    const label = button?.textContent || '';
    if (button && !quiet) { button.disabled = true; button.textContent = '生成中…'; }
    if (quiet) toast('正在请故事神谕设计下一章…');
    // 身份钉：神谕调用可能跨几十秒，期间用户可能切了聊天。为 A 聊天设计的章绝不能写进 B 聊天。
    const origin = chatKey();
    try {
        const raw = await askOracle({
            task: 'chapter',
            regenerate,
            rejected,
            keep,
            remaining: remainingBeatBudget(keep, settings().beatTarget),
            quiet,
            userText,
        });
        if (raw === null) { markFailed(key); return false; }
        if (origin && chatKey() !== origin) {
            console.info('[故事导演] 生成期间切换了聊天，这一章（属于旧聊天）没有落盘。');
            return false;
        }
        const blocks = parseBlocks(raw, 'StoryChapters');
        const chapter = blocks.length ? chapterFromBlock(blocks[blocks.length - 1], { index: Object.keys(settings().chapters || {}).length }) : null;
        if (!chapter || (!chapter[MAIN_BEATS].length && keep <= 0)) {
            console.info('[故事导演] 神谕没有返回可用的 <StoryChapters> 区块，原始回复：\n' + raw);
            toast('没解析到 <StoryChapters> 或拍列表为空，原始回复已打印到控制台。', 'warning');
            markFailed(key);
            return false;
        }
        clearFailed(key);
        await applyChapter(chapter, { quiet: false, keep });
        return true;
    } catch (error) {
        console.debug('[故事导演] 生成主线失败', error);
        toast(`生成失败：${error?.message || error}`, 'error');
        markFailed(key);
        return false;
    } finally {
        endGenerate();
        if (button && !quiet) { button.disabled = false; button.textContent = label; }
        // 让面板上的「神谕生成中…」及时消失（成功时 applyChapter 已经重画过，这里是失败/静默路径的兜底）
        if (panel && !panel.hidden) render();
    }
}

async function generateThread({ quiet = true, userText = '', force = false } = {}) {
    if (!beginGenerate()) return false;
    const key = `thread:${chatKey()}`;
    if (!force && isBackingOff(key)) return false;
    if (quiet) toast('正在请故事神谕设计一条支线…');
    const origin = chatKey();
    try {
        const raw = await askOracle({ task: 'thread', quiet, userText });
        if (raw === null) { markFailed(key); return false; }
        if (origin && chatKey() !== origin) {
            console.info('[故事导演] 生成期间切换了聊天，这条支线（属于旧聊天）没有落盘。');
            return false;
        }
        const blocks = parseBlocks(raw, 'StoryThreads');
        const thread = blocks.length ? threadFromBlock(blocks[blocks.length - 1], {}) : null;
        if (!thread) { toast('没解析到 <StoryThreads> 区块，原始回复已打印到控制台。', 'warning'); markFailed(key); return false; }
        clearFailed(key);
        thread.id = nextId(threadsState().map((item) => item.id), 't');
        thread[THREAD_FIELDS.status] = STATUS_ACTIVE;
        await applyThread(thread, { quiet: false });
        return true;
    } catch (error) {
        console.debug('[故事导演] 生成支线失败', error);
        toast(`生成失败：${error?.message || error}`, 'error');
        markFailed(key);
        return false;
    } finally {
        endGenerate();
        if (panel && !panel.hidden) render();
    }
}

async function generateInterlude({ quiet = true, userText = '', force = false } = {}) {
    if (!beginGenerate()) return false;
    const key = `interlude:${chatKey()}`;
    if (!force && isBackingOff(key)) return false;
    if (quiet) toast('正在请故事神谕设计一条插曲…');
    const origin = chatKey();
    try {
        // ⚠ 必须用 task:'side'（小插曲）。'interlude' 现在是**间章**那条通道，
        //    用错会让不占幕的小插曲生成出一整章的数据结构。
        const raw = await askOracle({ task: 'side', quiet, userText });
        if (raw === null) { markFailed(key); return false; }
        if (origin && chatKey() !== origin) {
            console.info('[故事导演] 生成期间切换了聊天，这条插曲（属于旧聊天）没有落盘。');
            return false;
        }
        const blocks = parseBlocks(raw, 'StoryInterlude');
        const interlude = blocks.length ? interludeFromBlock(blocks[blocks.length - 1], {}) : null;
        if (!interlude) { toast('没解析到 <StoryInterlude> 区块，原始回复已打印到控制台。', 'warning'); markFailed(key); return false; }
        clearFailed(key);
        interlude.id = nextId(interludesState().map((item) => item.id), 'i');
        await applyInterlude(interlude, { quiet: false });
        return true;
    } catch (error) {
        console.debug('[故事导演] 生成插曲失败', error);
        toast(`生成失败：${error?.message || error}`, 'error');
        markFailed(key);
        return false;
    } finally {
        endGenerate();
        if (panel && !panel.hidden) render();
    }
}

// 阶段十：自动导演

let evaluating = false;
let evaluateTimer = 0;
let interceptionReady = false;

/** 主线是否已经开篇。 */
function mainStarted(live = null) {
    const main = mainState(live);
    return beatsOf(main).length > 0 || !!String(unwrap(main[MAIN_TITLE]) ?? '').trim();
}

/**
 * 处理「正文模型说这一拍站不住」的回报。返回 true 表示本轮已经重新设计，自动推进让位。
 *
 * ★ 升级梯（见 REDESIGN_MAX_L1 的注释）：
 *   ① 重排剩下的拍（保留已演过的）→ ② 仍然报错就**废掉这一章重建** → ③ 再报错就**重设篇章这一段**。
 * 节流两道：级内次数上限 + 两次重设计之间至少隔 `redesignGap` 轮。
 * 换章时（章名变了）整套计数清零，所以每一章的额度是独立的。
 */
async function handleBeatReview({ live = null } = {}) {
    const s = settings();
    if (!s.autoRedesign) return false;
    const main = mainState(live);
    const state = reviewStateOf(main);
    if (state === REVIEW_PASS) {
        if (s.run.redesigns || s.run.redesignsL2 || s.run.redesignAt) {
            s.run.redesigns = 0; s.run.redesignsL2 = 0; s.run.redesignAt = 0; save();
        }
        return false;
    }

    // 换了章 → 每一章的审查额度独立（用章名当 key，和 closedChapter 一个路子）
    const title = String(unwrap(main[MAIN_TITLE]) ?? '').trim();
    if (s.run.redesignFor !== title) {
        s.run.redesignFor = title;
        s.run.redesigns = 0;
        s.run.redesignsL2 = 0;
        s.run.redesignAt = 0;
    }

    // 节流：两次重设计之间至少隔 redesignGap 轮（否则模型连着报两次就把调用全烧在这上面）
    const gap = Math.max(0, Math.round(toNumber(s.redesignGap, 3)));
    const count = aiMessageCount();
    const lastAt = Math.round(toNumber(s.run.redesignAt, 0));
    if (lastAt && count - lastAt < gap) {
        // 还不够间隔：结论留着不清，下一轮再看（这样不会把信号吃掉）
        return false;
    }

    const note = reviewNoteOf(main);
    // 复位结论，免得下一轮又照它重设计一次
    await patchMain({ [KEY_REVIEW]: REVIEW_PASS, [KEY_REVIEW_NOTE]: '' }, { live });

    const maxL1 = Math.max(1, Math.round(toNumber(s.redesignMax, REDESIGN_MAX_L1)));
    const l1 = Math.round(toNumber(s.run.redesigns, 0));
    const l2 = Math.round(toNumber(s.run.redesignsL2, 0));
    const played = Math.max(0, currentBeat(main) - 1);
    const why = `${state}」${note ? `：${note}` : ''}`;

    s.run.redesignAt = count;

    if (l1 < maxL1) {
        // ① 级：只重排剩下的拍，已演过的一字不动
        s.run.redesigns = l1 + 1;
        save();
        toast(`正文模型报「${why}——正按当前情况重排剩下的拍（第 ${Math.min(maxL1, l1 + 1)}/${maxL1} 次）。`, 'info');
        void generateChapter({ quiet: true, regenerate: true, rejected: { state, note }, force: true, keep: played });
        return true;
    }

    if (l2 < REDESIGN_MAX_L2) {
        // ② 级：这一章的设计本身立不住 → **废掉整章重建**（不再保留已演过的拍）
        s.run.redesignsL2 = l2 + 1;
        save();
        toast(`这一章重排 ${maxL1} 次仍然报「${why}——判断为**这一章的设计立不住**，正在**重设计剩下的拍**（已演过的 ${played} 拍保留；第 ${l2 + 1}/${REDESIGN_MAX_L2} 次）。`, 'warning');
        console.info(`[故事导演] 升级到②级：重设计《${title || '当前章'}》剩下的拍（保留已演的 ${played} 拍；原因：${state}${note ? ' —— ' + note : ''}）。`);
        void generateChapter({
            // ★ 保留已经演过的拍（keep 走自动）—— 重设计的是**剩下的**那一部分。
            //   以前这里是 keep: 0（把整章连进度一起废掉）；那会让用户「演了一半被打回第 1 拍」，
            //   而且刚播下的伏笔、已经付掉的代价一起作废，反而更容易再被判站不住。
            quiet: true, regenerate: true, force: true,
            rejected: {
                state,
                note,
                scrap: true,
                badBeats: beatsOf(main).slice(played),
                reason: `这一章的**剩余部分**反复立不住（重排 ${maxL1} 次仍未解决）：${note || state}。`
                    + '请**换一套推进方式**：不要沿用原来剩下的那几拍的地点、人物组合与事件顺序，'
                    + '换一条在当前处境下真正走得通的路 —— 但这一章要服务的长线目标不能丢。',
            },
        });
        return true;
    }

    // ③ 级：连重建都不行 → 病在长线方向上。请神谕重设篇章这一段，然后重建这一章。
    s.run.redesigns = 0;
    s.run.redesignsL2 = 0;
    save();
    const past = completedMainTitles(rootOf(live)).length;
    toast(`这一章重建 ${REDESIGN_MAX_L2} 次仍然报「${why}——判断为**长线这一段的方向立不住**，正在请神谕重设篇章这一段，然后重建这一章。`, 'warning');
    console.info(`[故事导演] 升级到③级：重设篇章这一段并重建《${title || '当前章'}》。`);
    void (async () => {
        const ok = await generateEpic({
            quiet: true, force: true, mode: 'evolve', entry: past,
            diverged: `当前这一段走向在实际演出里反复立不住（正文模型连续报「${state}」${note ? `：${note}` : ''}）。`
                + '请**重设这一段大阶段**：换一条通往同一终局、但当前处境下真正走得通的路；'
                + '如果这个阶段的设定本身就不可行，就换一个阶段。',
        });
        if (!ok) {
            // 篇章没改成也不该把故事卡死：照样重建这一章（带着失败原因）
            toast('篇章没能重设成功 —— 仍然会重建这一章（它只是配料）。', 'warning');
        }
        void generateChapter({
            // ★ 同样保留已演过的拍：篇章换了方向，也只是「剩下的怎么走」要重新想。
            quiet: true, regenerate: true, force: true,
            rejected: {
                state, note, scrap: true,
                badBeats: beatsOf(main).slice(played),
                reason: '长线这一段的方向已经被判定立不住，篇章刚刚重设过。'
                    + '这一章的**剩余部分**要按**新的长线方向**重新设计，不要沿用原来的设计。',
            },
        });
    })();
    return true;
}

/**
 * 「为什么还没有开篇」——把所有能拦住第一章的条件都查一遍，返回一条**给用户看**的说明。
 * ⚠ 这很要紧：以前未开篇时面板只写「还没有拍列表」，用户完全不知道是等、是坏、还是没配好。
 */
function firstChapterBlocker({ live = null } = {}) {
    const s = settings();
    const rt = s.run;
    const count = aiMessageCount();
    if (!s.enabled) return { key: 'plugin-off', text: '插件已停用（扩展列表里重新启用）' };
    if (!mvu()) return { key: 'no-mvu', text: 'MVU 没加载：先确认酒馆助手与 MVU 装好了' };
    if (!namespaceOf(rootOf(live))) return { key: 'no-namespace', text: '这个聊天还没有 MVU 变量：先和角色聊一句' };
    if (!s.autoDirector) return { key: 'director-off', text: '「自动导演总闸」是关着的 —— 去「设定」页打开，或点下面的「设计下一章」' };
    if (typeof oracleApi()?.run !== 'function') {
        return { key: 'no-oracle', text: '读不到「故事神谕」的模型连接 —— 确认故事神谕已安装并启用（版本要 1.21 以上，且它的 Hook API 没被关掉）' };
    }
    if (s.autoEpic && !epicStarted(epicOf(rootOf(live))) && Math.round(toNumber(rt.epicTries, 0)) < 3 && count >= 2) {
        return { key: 'epic-pending', text: '正在定篇章（定篇章完成或失败 3 次之后就会开第一章）' };
    }
    if (!s.autoChapter) return { key: 'chapter-off', text: '「自动换章」是关着的 —— 打开它，或点下面的「设计下一章」' };
    if (count < 3) return { key: 'too-few-rounds', text: `这个聊天才 ${count} 轮 AI 回复，聊满 3 轮才会自动开第一章` };
    const opened = Math.round(toNumber(rt.chapterOpenedAt, 0));
    if (opened && count - opened < 3) return { key: 'epic-gap', text: `再聊 ${3 - (count - opened)} 轮就会开第一章` };
    if (blockedByCooldown(s, count, rt)) return { key: 'cooldown', text: '生成冷却中：再等一两轮就会自己开第一章' };
    return { key: 'none', text: '一切就绪，下一次心跳就会开第一章（也可以点下面的「设计下一章」马上开）' };
}

let lastBlock = { key: 'none', text: '', at: 0 };
function noteBlock(reason) {
    lastBlock = { key: reason.key, text: reason.text, at: aiMessageCount() };
}
/** 原因变化时才值得打一行日志（否则每轮刷屏）。 */
function alsoShowWhy(key) {
    if (key === 'none') return false;
    if (lastBlockLogged === key) return false;
    lastBlockLogged = key;
    return true;
}
let lastBlockLogged = '';

let lastAttempt = { key: 'none', text: '', at: 0 };
function noteAttempt(ok, error) {
    lastAttempt = { key: ok ? 'ok' : 'fail', text: ok ? '上一次开章成功' : `上一次开章失败：${String(error || '').slice(0, 80)}`, at: aiMessageCount() };
}

/**
 * 导演心跳：每次「MVU 处理完这一楼」以及每条新回复之后跑一次。
 *
 * 决策顺序（全部满足才动手，宁可少动不要乱动）：
 *   0. 面板开关 / 有 MVU / 有命名空间；
 *   1. 合理性审查（正文模型驳回当前拍）→ 重新设计当前章；
 *   2. 自动换拍：当前拍已经落了 → 拍号 +1（插件自己写 MVU，不等模型）；
 *   3. 自动换章：整章走完（拍演完 + 章目标达成 + 场景收尾）→ 请神谕开新章；
 *   4. 自动续支线 / 插曲：按回复数节奏补充（有并发上限）。
 */
async function evaluateDirector({ live = null } = {}) {
    if (evaluating) return;
    evaluating = true;
    try {
        const s = settings();
        if (!s.enabled) return;
        if (!mvu()) return;
        if (!namespaceOf(rootOf(live))) return;

        const key = chatKey();
        if (s.run.chatId !== key) {
            s.run = JSON.parse(JSON.stringify(DEFAULT.run));
            s.run.chatId = key;
            save();
        }

        // ★ 回退聊天（重新生成 / 删楼 / 换 swipe）会让回复数变少，把「按回复数记账」的游标修回来。
        //   必须放在**任何冷却判断之前** —— 否则冷却会因为差值为负而永久卡死。
        if (repairRunCursors(s.run, aiMessageCount())) save();

        if (await handleBeatReview({ live })) return;

        // 支线收尾扫描：落的标完成、超期没动的标「已收尾」（放在前面，这样任何分支都不会漏掉它）
        await sweepThreads({ live });

        // 幕的开关：模型只能在「间章」时段里写 间章.* 的变量
        syncInterludeWrites();

        const main = mainState(live);
        const beats = beatsOf(main);
        const count = aiMessageCount();
        const rt = s.run;
        const minReplies = Math.max(0, Math.round(toNumber(s.minReplies, 1)));
        const threadWarmup = Math.max(0, Math.round(toNumber(s.threadWarmup, 3)));
        const opened = Math.round(toNumber(rt.chapterOpenedAt, 0));

        // ═══ 间章幕：与主线互斥。只推进日常的拍，并把「随时可以收」这件事照顾好 ═══
        if (currentMode(live) === 'interlude') {
            const chapter = interludeChapterOf(rootOf(live));
            const ilBeats = interludeBeatsOf(chapter);
            const ilBeat = interludeBeat(chapter);

            // 间章里的换拍：与主线同款算法（focusInterlude 是基准，模型可能自己把拍号写成 N+1）
            if (s.autoBeat && truthy(chapter[IL.beatDone])) {
                const at = Math.round(toNumber(rt.beatAt, 0));
                if (!at || count - at >= minReplies) {
                    const focus = Math.max(1, Math.round(toNumber(rt.focusInterlude, 0)) || ilBeat);
                    const next = Math.max(ilBeat, focus + 1);
                    rt.focusInterlude = next;
                    rt.beatAt = count;
                    save();
                    await patchInterlude({ [IL.beat]: next, [IL.beatDone]: false }, { live });
                    toast(`间章第 ${Math.min(focus, next - 1)} 个日常画面已演过，接着第 ${next} 个。`, 'success');
                    syncMainInjection();
                    if (!panel?.hidden) render();
                }
                return;
            }

            // 收间章：**不要求跑完拍** —— 模型说够了就收，或者素材全演完了也收。
            const allPlayed = ilBeats.length > 0 && ilBeat > ilBeats.length;
            const wantsBack = truthy(chapter[IL.ready]) || allPlayed;
            const ilKey = `间章:${String(unwrap(chapter[IL.title]) ?? '').trim()}`;
            if (wantsBack && rt.closedChapter !== ilKey) {
                if (typeof oracleApi()?.run !== 'function' || !s.autoDirector) return;
                if (blockedByCooldown(s, count, rt)) return;
                rt.aftermathAt = count;
                rt.beatAt = count;
                markGenerated(rt, count);
                save();
                await rememberInterlude(chapter, { live });
                await switchMode('main', { live, quiet: true });
                toast('间章演够了，正在请故事神谕接着开主线的新一章…', 'success');
                // 与章收尾同款：**生成成功才把钉子钉死**，失败就放开让下一轮重试
                if (s.autoChapter) {
                    if (await ensureClosingChapter({ interlude: false })) {
                        rt.closedChapter = ilKey;
                    } else {
                        rt.lastGenerateAt = 0;
                        console.info('[故事导演] 间章之后没能开出新章（生成失败），已放开钉子，下一轮会重试。');
                    }
                    save();
                } else {
                    rt.closedChapter = ilKey;
                    save();
                }
                return;
            }
            return;
        }

        // ═══ 主线幕 ═══
        // ⓪ 不变量：**不是主线就是间章**。既没有拍在演、又不在间章 = 未开篇，这是个**非法状态**，
        //   不应该靠「等条件满足」坐着不动 —— 这里就地把它推回正轨。
        if (!beats.length && !interludeActive(rootOf(live)) && s.autoDirector) {
            const mainNow = mainState(live);
            // ⚠ 关键：如果模型已经报过「本章收尾」，那这一刻本来该由收尾流程接管（间距 / 生成 / 开下一幕）。
            //   只要把新一幕真的做出来，`已收尾` 就是真话；把它清掉，后面整条换章流程就正常了。
            //   这个自愈治的是「收尾那一次失败之后卡在 未开篇」以及「插件是聊到一半才装上的」。
            if (truthy(mainNow[MAIN_CLOSED])) {
                console.info('[故事导演] 发现非法状态：主线已收尾但既没有拍在演、也不在间章 —— 自动放开「已收尾」，交给收尾流程重来一次。');
                await patchMain({ [MAIN_CLOSED]: false }, { live });
                if (!Math.round(toNumber(rt.aftermathAt, 0))) {
                    // 余波基准没记过，就先当它从此刻开始，让间距判断有个正当起点
                    rt.aftermathAt = count;
                }
                rt.closedChapter = '';
                rt.lastGenerateAt = 0;
                save();
            }
        }

        // ⓪′ 史诗（篇章）闸门：定篇章 / 按「他实际做了什么」校准。**在开新章之前**跑 ——
        //   第一章之前先有篇章，之后每开一章之前先按最近对话重新校准（他随时可能偏出剧本）。
        //
        //   ⚠ 三道保险，确保它**永远不会把「开章」卡死**：
        //     ① 定篇章/校准各自一个 pending 标记（异步生成期间不再重复排队）；
        //     ② 冷却基准由生成成功后写（失败不消耗名额）；
        //     ③ **失败次数超限就放行** —— 定篇章只是「让剧情不平淡」的手段，
        //        它自己失败了不该让整个插件停摆（以前正是这样卡在「未开篇」）。
        const EPIC_GIVE_UP = 3;
        if (s.autoDirector && s.autoEpic && typeof oracleApi()?.run === 'function') {
            const epic = epicOf(rootOf(live));
            const past = completedMainTitles(rootOf(live)).length;
            const pendingEpic = isPending(`epic:${chatKey()}`);
            const tries = Math.round(toNumber(rt.epicTries, 0));
            const canTryEpic = !pendingEpic && tries < EPIC_GIVE_UP;
            // 章已经收尾（没有拍在演）但篇章还没校准到这些章 → 先校准，再开新章
            if (beats.length === 0 && epicStarted(epic) && s.evolveEpic && epicChapter(epic) < past) {
                if (canTryEpic && !blockedByCooldown(s, count, rt)) {
                    rt.epicTries = tries + 1;
                    markPending(`epic:${chatKey()}`);
                    save();
                    void generateEpic({ quiet: true, force: true, mode: 'evolve', entry: past });
                    return;
                }
            }
            // 还没定篇章：这是万事的前提，**不该被生成冷却卡住**（卡住就等于整个插件不动）
            if (!epicStarted(epic) && canTryEpic && count >= 2) {
                rt.epicTries = tries + 1;
                markPending(`epic:${chatKey()}`);
                save();
                void generateEpic({ quiet: true, force: true, mode: 'establish', entry: 0 });
                return;
            }
        }

        // 还没有开篇：聊过几轮之后再自动开第一章。
        // ⚠ 不要用 `truthy(main[KEY_READY]) || count >= 3`：模型在「本拍已落」之外往往还会把
        // `可进下一章` 写成 true，那样会在正文已经演到第 3 拍时重新开一章，把刚演的内容整章覆盖掉。
        if (!beats.length) {
            // 把「为什么还没开篇」记下来给面板用（这样用户不必猜）
            const why = firstChapterBlocker({ live });
            noteBlock(why);
            if (alsoShowWhy(why.key)) {
                console.info(`[故事导演] 还没开篇：${why.text}`);
            }
            if (why.key !== 'none') {
                if (!panel?.hidden) renderNowTab();
                return;
            }
            rt.chapterOpenedAt = count;
            markGenerated(rt, count);
            save();
            void generateChapter({ quiet: true, force: true }).then((ok) => noteAttempt(ok));
            return;
        }
        noteBlock({ key: 'none', text: '' });

        const beat = currentBeat(main);
        const total = beats.length;

        // ★ 同一拍已经连着注入好几轮了吗？（正文模型没回报「本拍已落」时，注入块会和上一轮几乎一模一样 ——
        //   提示词如此相似，模型写出高度相似甚至复读的话是**可预期的**。见 buildInjection 里那段叮嘱。）
        //   「几轮」按回复数算，和别的节奏同源。
        {
            const since = Math.round(toNumber(rt.focusBeatSince, 0));
            if (!since || Math.round(toNumber(rt.focusBeat, 0)) !== beat) {
                rt.focusBeatSince = count;              // 换拍（或首次）→ 重新开始计时
                save();
            } else if (count - since >= FOCUS_STALE_REPLIES) {
                rt.focusStale =
                    `第 ${beat} 拍已经连着演了 ${count - since} 轮还没落地`;
                if (count - since === FOCUS_STALE_REPLIES) {
                    console.info(`[故事导演] ${rt.focusStale} —— 已在注入里叮嘱不要重复同一场景 / 同一句台词；`
                        + '若正文模型一直没写 `本拍已落`，可以用面板的「手动推进一拍」纠偏。');
                }
            }
        }

        // ② 自动换拍（手动模式下也照做：写盘不需要调模型）
        if (s.autoBeat && truthy(main[KEY_BEAT_DONE])) {
            const at = Math.round(toNumber(rt.beatAt, 0));
            if (!at || count - at >= minReplies) {
                const focus = Math.max(1, Math.round(toNumber(rt.focusBeat, 0)) || beat);
                const next = Math.max(beat, focus + 1);
                rt.focusBeat = next;
                rt.beatAt = count;
                rt.focusBeatSince = count;          // 换拍了：同一拍的「连着演了几轮」重新计时
                rt.focusStale = '';
                save();
                await patchMain({ [KEY_BEAT]: next, [KEY_BEAT_DONE]: false }, { live });
                toast(`第 ${Math.min(focus, next - 1)} 拍已落地，进入第 ${next} 拍。`, 'success');
                syncMainInjection();
                if (!panel?.hidden) render();
            }
            return;
        }

        if (!s.autoDirector) return;
        const chapterGap = Math.max(0, Math.round(toNumber(s.chapterGap, 4)));

        // ③ 主线收尾 → 记账 → **交给间章**（而不是立刻开下一章：间隙由间章填上，主线不会一时半会没内容）
        const allBeatsPlayed = beat > total;
        const chapterDone = allBeatsPlayed && truthy(main[KEY_CHAPTER_DONE]);
        const mainKey = `主线:${String(unwrap(main[MAIN_TITLE]) ?? '').trim()}`;
        if (s.autoChapter && chapterDone && rt.closedChapter !== mainKey) {
            if (!truthy(main[KEY_READY])) return;              // 等正文模型确认场景收尾
            // 余波从「上一幕收尾」那一刻算起（不是本章开始那一刻 —— 那是另一个时钟）
            const after = Math.round(toNumber(rt.aftermathAt, 0));
            const span = after ? count - after : Number.POSITIVE_INFINITY;
            if (span < chapterGap) return;                     // 先留出「余波」
            // ⚠ 这里**不再看 autoCooldown**：收尾是剧情已经发生的事实，不该被「刚生成过支线 / 插曲」
            //   这种无关的节流推迟（以前正是它让「拍演完却不换章」）。冷却要在收尾之后才生效。
            if (typeof oracleApi()?.run !== 'function') return;
            rt.aftermathAt = count;
            rt.beatAt = count;
            markGenerated(rt, count);
            save();
            await rememberChapter(main, { live });
            syncInterludeWrites();
            const useInterlude = s.autoInterludeChapter;
            toast(useInterlude
                ? '本章收尾，间隙交给间章 —— 正在请故事神谕设计一段日常…'
                : '本章目标达成，正在请故事神谕开下一章…', 'success');
            // ⚠ 关键：**先看生成是否真的成功，再决定要不要把「已收尾」钉死**。
            //   以前一进门就写 closedChapter，一旦这一次生成失败（网络 / 解析不出来），
            //   这个钉子就永远摘不掉 —— 表现就是「拍演完了，永远不换章」。
            if (await ensureClosingChapter({ interlude: useInterlude })) {
                rt.closedChapter = mainKey;
            } else {
                rt.closedChapter = '';
                // 失败时把冷却基准回退，让下一次心跳立刻能重试（不要白等 autoCooldown 轮）
                rt.lastGenerateAt = 0;
                console.info('[故事导演] 这一章没能交给神谕（生成失败），已放开「已收尾」钉子，下一轮会重试。');
            }
            save();
            return;
        }

        // ④ 自动续支线与插曲。
        // 三道闸门，缺一不可：
        //   a. 本章至少演够 threadWarmup 轮（刚换章时先把主线立住，别一开章就插支线）；
        //   b. 各自的节奏间隔（threadEvery / interludeEvery）；
        //   c. **跨线冷却 autoCooldown**：任意两次自动生成之间都要隔够几轮 —— 没有它，支线与插曲
        //      会在同一个心跳里各发一次，一轮多烧两次调用，页面上还同时冒出两条新线。
        // 另外支线与插曲在一轮里**最多补一条**（用 generated 互斥），绝不并发。
        if (typeof oracleApi()?.run !== 'function') return;
        const warmFrom = Math.round(toNumber(rt.aftermathAt, 0)) || opened;
        if (warmFrom && count - warmFrom < threadWarmup) return;
        let generated = false;
        if (s.autoThread) {
            const every = Math.max(1, Math.round(toNumber(s.threadEvery, 10)));
            const liveCount = liveThreads(live).length;
            const cap = Math.max(0, Math.round(toNumber(s.maxThreads, 2)));
            if (liveCount < cap && spaced(rt.threadAt, count, every) && !blockedByCooldown(s, count, rt)) {
                markGenerated(rt, count);
                rt.threadAt = count;
                save();
                void generateThread({ quiet: true });
                generated = true;
            }
        }
        if (!generated && s.autoInterlude) {
            const every = Math.max(1, Math.round(toNumber(s.interludeEvery, 10)));
            const pending = interludesState(live).filter(interludePending).length;
            const cap = Math.max(0, Math.round(toNumber(s.maxInterludes, 1)));
            if (pending < cap && spaced(rt.interludeAt, count, every) && !blockedByCooldown(s, count, rt)) {
                markGenerated(rt, count);
                rt.interludeAt = count;
                save();
                void generateInterlude({ quiet: true });
            }
        }
    } finally {
        evaluating = false;
    }
}

/**
 * 把我们注册的模式按钮钉在故事神谕图标栏的**最左**。
 *
 * 为什么不改神谕：那是别人的文件，改了会被它的扩展更新覆盖，也不该让我们的安装去动别人。
 * 为什么需要：神谕自己的按钮里 `#so-*` 的 id 会变（它自己也一直在加模式），依赖某个 id 的定位不稳；
 * 而已有的 `before:advisor` 这类锚点，多个插件一起用时，顺序取决于谁先注册 ——
 * 同一版本在不同机器上按钮顺序会不一样。这里改成「插进第一个子节点之前」，位置确定且不看 id。
 */
function pinModeButtonFirst() {
    try {
        const hdr = document.querySelector('#so-header-btns');
        const btn = document.getElementById(`so-${ORACLE_MODE_ID}-btn`);
        if (!hdr || !btn || !btn.parentNode) return false;
        if (hdr.firstChild === btn) return true;          // 已经是最左
        hdr.insertBefore(btn, hdr.firstChild);
        return true;
    } catch (error) {
        console.debug('[故事导演] 调整模式按钮位置失败', error);
        return false;
    }
}

/**
 * 把「这一幕交出去」跑完并返回是否成功（给章收尾用）。
 * 串行化：同一时间只跑一个；已有在跑就等它（返回它的结果），避免重复生成。
 */
let closingChapterTask = null;
async function ensureClosingChapter({ interlude = true } = {}) {
    if (closingChapterTask) return closingChapterTask;
    closingChapterTask = (async () => {
        if (interlude) {
            return await generateInterludeChapter({ quiet: true, force: true });
        }
        return await generateChapter({ quiet: true, force: true });
    })().catch((error) => {
        console.debug('[故事导演] 交出新一幕失败', error);
        return false;
    }).finally(() => { closingChapterTask = null; });
    return closingChapterTask;
}

/** 把一段间章记进章节史（与主线章同一本，但标上类型；回主线后它就不再注入）。 */
async function rememberInterlude(chapter, { live = null } = {}) {
    const title = String(unwrap(chapter?.[IL.title]) ?? '').trim();
    if (!title) return false;
    const s = settings();
    const record = { 类型: '间章', [MAIN_TITLE]: title, [MAIN_ARC]: String(unwrap(chapter?.[IL.scene]) ?? '').trim() };
    const root = rootOf(live);
    const fromMvu = isPlainObject(root?.[NS]?.章节史) ? { ...root[NS].章节史 } : {};
    const fromSettings = isPlainObject(s.chapters) ? s.chapters : {};
    const box = { ...(Object.keys(fromMvu).length ? fromMvu : fromSettings) };
    delete box.$meta;
    for (const key of Object.keys(box)) if (!/^\d+$/.test(key)) delete box[key];
    const duplicate = Object.values(box).some((item) => isPlainObject(item)
        && String(unwrap(item[MAIN_TITLE]) ?? '').trim() === title
        && String(unwrap(item[MAIN_ARC]) ?? '').trim() === record[MAIN_ARC]);
    if (duplicate) return true;
    let next = 1;
    while (box[String(next)]) next++;
    box[String(next)] = record;
    const keys = Object.keys(box).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
    while (keys.length > 8) delete box[String(keys.shift())];
    s.chapters = box;
    save();

    const apply = (target) => {
        if (!isPlainObject(target[NS])) target[NS] = {};
        if (!isPlainObject(target[NS].章节史)) target[NS].章节史 = {};
        const history = target[NS].章节史;
        for (const key of Object.keys(history)) {
            if (!/^\d+$/.test(key) && key !== '$meta') delete history[key];
        }
        history[String(next)] = { ...record };
        const ids = Object.keys(history).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
        while (ids.length > 8) delete history[String(ids.shift())];
    };
    if (live && isPlainObject(live.stat_data)) { apply(live.stat_data); return true; }
    const api = mvu();
    const d = mvuData();
    if (!api?.replaceMvuData || !isPlainObject(d?.stat_data)) return false;
    apply(d.stat_data);
    try { await api.replaceMvuData(d, { type: 'message', message_id: 'latest' }); return true; }
    catch (error) { console.debug('[故事导演] 记录间章失败', error); return false; }
}

/**
 * ★ 回退聊天后的记账修复。
 *
 * 所有节奏都按「AI 回复数」记账（见 blockedByCooldown / spaced），这套算法**默认 count 只增不减**。
 * 但用户可以随时回退：
 *   · 酒馆的「重新生成」/ 换 swipe —— 楼数变少
 *   · 删掉几楼、从前面重新续 —— 楼数变少
 *   · 删掉一条 AI 回复 —— 楼数变少
 * 一旦 count 掉到某个游标之下，`count - 游标` 就是负数：
 *   · blockedByCooldown → 永远 < cooldown，**冷却被永久卡死**（这正是「刚生成完就回退，结果一直不生成」）
 *   · spaced           → 永远不满足，支线 / 插曲再也不补
 *
 * 修法：把游标夹到当前 count，并清掉 lastGenerateAt。
 *   · 夹到 count 而不是清零 —— 收紧档位（只增不减）那一类判断的语义得以保留
 *     （夹完 chapterOpenedAt 仍 ≤ count，不会凭空造出「章开了很久」）
 *   · lastGenerateAt 清 0 而不是夹 —— 回退意味着「那一次生成我不要了（或要重来）」，
 *     此时立刻放行是合理的；仍要夹的话用户还得白等一轮，那正是这次要修的毛病
 *
 * 只动「按回复数记账」的游标；focusBeat / 章史这些**表示剧情进度**的字段一概不碰 ——
 * 回退的是聊天记录，不是已经演过的剧情。
 */
const COUNT_CURSORS = ['beatAt', 'chapterOpenedAt', 'aftermathAt', 'threadAt', 'interludeAt', 'epicAt', 'redesignAt'];

function repairRunCursors(rt, count) {
    if (!Number.isFinite(count)) return false;
    let changed = false;
    for (const field of COUNT_CURSORS) {
        const at = Math.round(toNumber(rt[field], 0));
        if (at > count) { rt[field] = count; changed = true; }
    }
    // 上一次自动生成落在「已经不存在的那几楼」里 → 这次节流不该再算数
    const generated = Math.round(toNumber(rt.lastGenerateAt, 0));
    if (generated > count) { rt.lastGenerateAt = 0; changed = true; }
    return changed;
}

/**
 * 跨线节流：上一次自动生成之后至少隔 autoCooldown 轮。
 * 这是「不要一直生成」的总闸门 —— 支线、插曲、换章都走它。
 */
function blockedByCooldown(s, count, rt) {
    const cooldown = Math.max(0, Math.round(toNumber(s.autoCooldown, 3)));
    if (!cooldown) return false;
    const at = Math.round(toNumber(rt.lastGenerateAt, 0));
    if (!at) return false;
    // 回退后 count 可能小于基准：把差值夹到 0，等效「刚生成完」，绝不让它算成负数而永久卡死。
    // （正常路径下 repairRunCursors 已把这种情形修掉了，这里是第二道保险。）
    const since = Math.max(0, count - at);
    return since < cooldown;
}

/** 记下「刚刚生成过一次」（跨线节流用）。 */
function markGenerated(rt, count) {
    rt.lastGenerateAt = count;
}

/**
 * 按节奏间隔判断某个线该不该补。
 * 基准（at）在开章时会被播下（= 开章那一轮的回复数），所以不会出现「0 就永远不补」的死锁；
 * 一进新章就补也不行 —— 那正是「应接不暇」的来源，先让本章演满一个间隔。
 */
function spaced(at, count, every) {
    const last = Math.round(toNumber(at, 0));
    if (!last) return false;                       // 没有基准（还没播过种）：先不补
    // 同上：回退后夹到 0，避免「永远差一个负数」导致这支线 / 插曲再也不补
    return Math.max(0, count - last) >= every;
}

/** 支线收尾扫描：落的标完成，长期没动又没落的标「已收尾」。 */
async function sweepThreads({ live = null } = {}) {
    const list = threadsState(live);
    if (!list.length) return;
    // 用 AI 回复数记账（与 threadAt 同源），不要拿墙钟分钟数当「轮」——挂机回来会误伤。
    const count = aiMessageCount();
    const every = Math.max(1, Math.round(toNumber(settings().threadEvery, 8)));
    const budget = every * 3;
    for (const thread of list) {
        const status = String(display(thread[THREAD_FIELDS.status] ?? '')).trim();
        if (status === STATUS_DONE || status === STATUS_STALLED || status === STATUS_SKIPPED) continue;
        if (threadLanded(thread)) {
            await patchEntry('支线', thread.id, { [THREAD_FIELDS.status]: STATUS_DONE, [THREAD_FIELDS.ended]: new Date().toISOString() }, { live });
            continue;
        }
        // 首次看到它时把当前回复数记进「开始」字段（正常是 ISO 时间，认不出数字就是第一次）
        const seen = Number(String(unwrap(thread[THREAD_FIELDS.started]) ?? '').trim());
        if (!Number.isFinite(seen)) {
            await patchEntry('支线', thread.id, { [THREAD_FIELDS.started]: String(count) }, { live });
            continue;
        }
        // 超过 3 个节奏周期还没有进展：让它自然收尾，别永远挂在注入里
        if (count - seen >= budget) {
            await patchEntry('支线', thread.id, {
                [THREAD_FIELDS.status]: STATUS_STALLED,
                [THREAD_FIELDS.note]: `超过 ${budget} 轮没有进展，自动收尾`,
            }, { live });
            console.info(`[故事导演] 支线 ${thread.id} ${budget} 轮没动，已自动收尾`);
        }
    }
}

function scheduleEvaluate(delay = AFTER_MVU_DELAY) {
    window.clearTimeout(evaluateTimer);
    evaluateTimer = window.setTimeout(() => { void evaluateDirector(); }, delay);
}

// 阶段十一：事件绑定 / 神谕接口

let modeRegistered = false;
let actionRegistered = false;
let oracleListenerBound = false;

function registerOracleAction(api) {
    if (actionRegistered || typeof api?.addMessageAction !== 'function') return;
    const ok = api.addMessageAction({
        id: ORACLE_ACTION_ID,
        icon: 'fa-solid fa-clapperboard',
        title: '采用为本故事的下一章',
        onClick: (_el, raw) => {
            const blocks = parseBlocks(raw, 'StoryChapters');
            if (!blocks.length) {
                toast('这条回复里没有 <StoryChapters> 区块——在「故事导演」模式里让它设计一章。', 'warning');
                return;
            }
            const chapter = chapterFromBlock(blocks[blocks.length - 1], { index: Object.keys(settings().chapters || {}).length });
            if (!chapter[MAIN_BEATS].length) { toast('这个区块里没有可识别的拍列表。', 'warning'); return; }
            // ★ 不传 keep = 自动：本章已经演过的拍会保留，新设计的拍接在后面。
            //   以前这里是裸调用（keep 默认 0），一按就把进度打回第 1 拍 ——
            //   用户演到第 2 拍时点这个按钮，等于把前两拍白演了。
            void applyChapter(chapter, { quiet: false });
        },
    });
    if (ok !== false) actionRegistered = true;
}

function registerOracleMode(api) {
    if (modeRegistered || typeof api?.registerMode !== 'function') return;
    const ok = api.registerMode({
        id: ORACLE_MODE_ID,
        title: '故事导演',
        icon: 'fa-solid fa-clapperboard',
        // 'first' = 插到神谕图标栏最左。新版神谕认这个值；旧版不认会退回 appendChild，
        // 我们随后用 pinModeButtonFirst() 自己挪 —— 所以**不需要改神谕任何文件**。
        order: 'first',
        accent: '#6a8fc9',
        placeholder: '想给下一章什么方向？（例如「让她先发现自己被跟踪」）',
        onSend: async (userText) => ({
            system: modeSystemPrompt(userText),
            messages: [{ role: 'user', content: await buildUserPrompt(taskFromText(userText), userText) }],
        }),
        buildBar: (host) => {
            host.textContent = '';
            const now = document.createElement('div');
            now.className = 'sd-bar-now';
            const row = document.createElement('div');
            row.className = 'sd-bar-row';
            const refresh = () => {
                const main = mainState();
                const beats = beatsOf(main);
                now.textContent = `当前章：${String(unwrap(main[MAIN_TITLE]) ?? '').trim() || '未开篇'}　拍 ${beats.length ? `${currentBeat(main)}/${beats.length}` : '—'}　`
                    + `支线 ${liveThreads().length}　插曲 ${interludesState().filter(interludePending).length}　`
                    + `${settings().autoDirector ? '自动推进中' : '已暂停'}`;
            };
            row.innerHTML = '<button type="button" class="sd-bar-btn" data-act="chapter">设计下一章</button>'
                + '<button type="button" class="sd-bar-btn" data-act="thread">加一条支线</button>'
                + '<button type="button" class="sd-bar-btn" data-act="interlude">加一条插曲</button>';
            row.onclick = (event) => {
                const act = event.target?.dataset?.act;
                if (act === 'chapter') void generateChapter({ quiet: false, userText: '用户希望现在就设计下一章。', force: true });
                if (act === 'thread') void generateThread({ quiet: false, force: true });
                if (act === 'interlude') void generateInterlude({ quiet: false, force: true });
            };
            host.append(now, row);
            refresh();
        },
    });
    if (ok) {
        modeRegistered = true;
        pinModeButtonFirst();
        // 神谕切模式 / 重画窗口时标题栏可能被重建：观察一次，发现我们不在最左就再挪
        try {
            const hdr = document.querySelector('#so-header-btns');
            if (hdr && !hdr.dataset.sdPinned) {
                hdr.dataset.sdPinned = '1';
                const obs = new MutationObserver(() => { pinModeButtonFirst(); });
                obs.observe(hdr, { childList: true });
            }
        } catch { /* 旧浏览器没有 MutationObserver 就算了，位置不影响功能 */ }
    }
}

function oracleReady(api) {
    if (!api) return;
    oracleCaps.present = true;
    probeOracleCaps();
    registerOracleAction(api);
    registerOracleMode(api);
    void ensureNamespace();
    if (!mainStarted() && settings().autoDirector) {
        // 神谕一就绪就顺手把第一章补上（页面加载时神谕常常还没准备好）
        window.setTimeout(() => { void evaluateDirector(); }, 800);
    }
}

function connectOracle() {
    if (window.StoryOracleAPI) { oracleReady(window.StoryOracleAPI); return; }
    if (oracleListenerBound) return;
    oracleListenerBound = true;
    document.addEventListener('story-oracle-ready', () => oracleReady(window.StoryOracleAPI), { once: true });
}

/** 接上所有可能送达「MVU 变量更新完」的信号，外加不依赖事件总线的兜底。 */
function bindDirectorSignals() {
    const onEnded = (variables) => {
        window.setTimeout(() => stripStatusEchoFromLatest(), 200);
        const live = variables && isPlainObject(variables.stat_data) ? variables : null;
        if (live && settings().enabled) void ensureNamespace({ live });
        if (live) reconcileFromLatestMessage(live);
        if (panel && !panel.hidden) renderDiagnostics();
        if (live) { void evaluateDirector({ live }); return; }
        scheduleEvaluate(AFTER_MVU_DELAY);
    };
    try { eventSource?.on?.('mag_variable_update_ended', onEnded); } catch { /* ignore */ }
    const helper = window.TavernHelper;
    for (const fn of [helper?.eventOn, helper?._bind?._eventOn]) {
        if (typeof fn !== 'function') continue;
        try { fn.call(helper, 'mag_variable_update_ended', onEnded); } catch { /* ignore */ }
    }
    for (const name of ['message_received', 'message_edited', 'message_swiped']) {
        try {
            eventSource?.on?.(name, (id) => {
                if (typeof id !== 'number') { window.setTimeout(() => stripStatusEchoFromLatest(), 300); return; }
                window.setTimeout(() => stripStatusEcho(id), 250);
                window.setTimeout(() => stripStatusEcho(id), 4000);
            });
        } catch { /* ignore */ }
    }
    // 兜底：MVU 的 MESSAGE_RECEIVED 入口有 3s throttle，所以必须等够了再去读。
    for (const name of ['message_received', 'message_updated', 'message_swiped', 'message_sent']) {
        try { eventSource?.on?.(name, () => { window.setTimeout(() => scheduleEvaluate(0), AFTER_MESSAGE_DELAY); }); } catch { /* ignore */ }
    }
    for (const name of ['mag_variable_initiailized', 'mag_variable_initialized']) {
        try {
            eventSource?.on?.(name, () => {
                if (settings().enabled) void ensureNamespace();
                window.setTimeout(() => scheduleEvaluate(0), AFTER_MVU_DELAY);
            });
        } catch { /* ignore */ }
    }
}

// 阶段十二：面板

let panel = null;
let bubble = null;
let dragging = false;

const TABS = [['now', '当前'], ['epic', '篇章'], ['main', '主线'], ['interlude', '间章'], ['side', '支线/插曲'], ['set', '设定']];

function esc(value) {
    const node = document.createElement('div');
    node.textContent = value === undefined || value === null ? '' : String(value);
    return node.innerHTML;
}

function firstLine(text) {
    return String(text || '').trim().split('\n').map((line) => line.trim()).filter(Boolean)[0] || '';
}

function statusChip(ok, label) {
    return `<span class="sd-chip ${ok ? 'is-ok' : 'is-off'}">${esc(label)}</span>`;
}

/** 后台正在生成时在面板上给个可见的提示（否则自动导演静默跑，用户看不到任何反馈）。 */
function busyChip() {
    return storyGenerating ? '<span class="sd-chip is-busy">神谕生成中…</span>' : '';
}

/**
 * 「下一次会自动生成什么、还要等几轮」——把节奏摊开给用户看，否则自动导演是黑箱。
 * 只描述，不改任何状态。
 */
function pacingHint() {
    const s = settings();
    if (!s.autoDirector) return '自动导演已暂停：不会自己调模型，注入与手动按钮照常。';
    const rt = s.run;
    const count = aiMessageCount();
    const cooldown = Math.max(0, Math.round(toNumber(s.autoCooldown, 3)));
    const left = (at, need) => Math.max(0, Math.round(toNumber(need, 0)) - (count - Math.round(toNumber(at, 0))));

    const bits = [];
    const last = Math.round(toNumber(rt.lastGenerateAt, 0));
    if (cooldown && last && count - last < cooldown) bits.push(`生成冷却还剩 ${left(last, cooldown)} 轮`);

    const main = mainState();
    const beats = beatsOf(main);
    if (!beats.length) {
        bits.push(count < 3 ? `再聊 ${3 - count} 轮开第一章` : '下一次心跳就开第一章');
    } else if (currentMode() === 'interlude') {
        bits.push('现在在间章：演到你满意就收（模型会报「可回主线」），主线随时可以接上');
    } else if (currentBeat(main) > beats.length && truthy(main[KEY_CHAPTER_DONE])) {
        const gap = Math.max(0, Math.round(toNumber(s.chapterGap, 4)));
        const leftGap = Math.max(0, gap - (count - Math.round(toNumber(rt.aftermathAt, 0))));
        bits.push(leftGap > 0
            ? `本章已收尾，余波再 ${leftGap} 轮后可开下一章`
            : (s.autoInterludeChapter ? '本章已收尾，接着会自动开一段间章' : '本章已收尾，可以开下一章了'));
    } else {
        bits.push(`主角：本章第 ${Math.min(currentBeat(main), beats.length)}/${beats.length} 拍`);
    }

    const warmup = Math.max(0, Math.round(toNumber(s.threadWarmup, 3)));
    if (warmup && count - Math.round(toNumber(rt.chapterOpenedAt, 0)) < warmup) {
        bits.push(`再 ${left(rt.chapterOpenedAt, warmup)} 轮才会补支线／插曲`);
    } else {
        if (s.autoThread) bits.push(`支线：再 ${left(rt.threadAt, s.threadEvery)} 轮可补一条`);
        if (s.autoInterlude) bits.push(`插曲：再 ${left(rt.interludeAt, s.interludeEvery)} 轮可补一条`);
    }
    return `节奏（每 1 轮 = 1 条 AI 回复，不看墙钟）：${bits.join('；')}。`;
}

function renderNowTab() {
    const host = panel?.querySelector('.sd-now-tab');
    if (!host) return;
    const s = settings();
    const main = mainState();
    const beats = beatsOf(main);
    const beat = currentBeat(main);
    const title = String(unwrap(main[MAIN_TITLE]) ?? '').trim();
    const goal = String(unwrap(main[MAIN_GOAL]) ?? '').trim();
    const scope = String(unwrap(main[MAIN_SCOPE]) ?? '').trim();
    const arc = String(unwrap(main[MAIN_ARC]) ?? '').trim();
    const threads = liveThreads();
    const interludes = interludesState().filter(interludePending);
    const history = completedMainTitles(rootOf());
    const mode = currentMode();
    const ilChapter = interludeChapterOf(rootOf());
    const ilBeats = interludeBeatsOf(ilChapter);
    const ilBeat = interludeBeat(ilChapter);
    const ilTitle = String(unwrap(ilChapter[IL.title]) ?? '').trim();
    const ilScene = String(unwrap(ilChapter[IL.scene]) ?? '').trim();

    const beatRows = beats.length
        ? beats.map((text, index) => {
            const mark = index + 1 < beat ? '✔' : (index + 1 === beat ? '▶' : '·');
            return `<li class="sd-beat ${index + 1 === beat ? 'is-now' : ''}">${esc(`${mark} ${index + 1}. ${text}`)}</li>`;
        }).join('')
        : (() => {
            const why = firstChapterBlocker();
            const last = lastAttempt.key === 'fail' ? `<p class="sd-note">${esc(lastAttempt.text)}</p>` : '';
            return `<li class="sd-empty">还没有开篇 —— ${esc(why.text)}</li>`;
        })();

    host.innerHTML = `
        <div class="sd-card sd-card-main">
            <div class="sd-card-head">
                <span class="sd-card-title">${mode === 'interlude' ? `间章 · ${esc(ilTitle || '一段日常')}` : esc(title || '未开篇')}</span>
                <span class="sd-chip ${mode === 'interlude' ? 'is-busy' : ''}">${mode === 'interlude' ? '间章中' : (beats.length ? `第 ${Math.min(beat, beats.length)}/${beats.length} 拍` : '无拍')}</span>
            </div>
            ${mode === 'interlude' ? `
            ${ilScene ? `<p class="sd-sub">${esc(ilScene)}</p>` : ''}
            <p class="sd-line sd-dim"><b>主线</b>「${esc(title || '上一章')}」暂时收着（间隙交给间章，主线不会空着）</p>
            <ul class="sd-beats">${ilBeats.length
                ? ilBeats.map((text, index) => {
                    const mark = index + 1 < ilBeat ? '✔' : (index + 1 === ilBeat ? '▶' : '·');
                    return `<li class="sd-beat ${index + 1 === ilBeat ? 'is-now' : ''}">${esc(`${mark} ${index + 1}. ${text}`)}</li>`;
                }).join('')
                : '<li class="sd-empty">这段间章还没有日常画面。</li>'}</ul>
            <p class="sd-note">间章**不要求跑完**：这些只是日常素材，谁都可以跳过。你在正文里写到合适的地方，模型会报「可回主线」，插件随即接着开主线的新一章。</p>
            <div class="sd-row">
                <button type="button" class="sd-btn sd-regen-interlude">换一段间章</button>
                <button type="button" class="sd-btn sd-end-interlude">现在回主线</button>
                <button type="button" class="sd-btn sd-next-ilbeat">手动推进一个画面</button>
            </div>` : `
            ${arc ? `<p class="sd-sub">${esc(arc)}</p>` : ''}
            ${goal ? `<p class="sd-line"><b>章目标</b>${esc(goal)}</p>` : ''}
            ${scope ? `<p class="sd-line sd-dim"><b>范围</b>${esc(scope)}</p>` : ''}
            <ul class="sd-beats">${beatRows}</ul>
            <div class="sd-row">
                <button type="button" class="sd-btn sd-generate-chapter">${title ? '重新生成本章' : '设计下一章'}</button>
                <button type="button" class="sd-btn sd-force-open">立刻开篇</button>
                <button type="button" class="sd-btn sd-next-beat">手动推进一拍</button>
                <button type="button" class="sd-btn sd-finish-chapter">本章收尾</button>
                <button type="button" class="sd-btn sd-start-interlude">开一段间章</button>
            </div>
            <p class="sd-note">「重新生成本章」会按**当前处境**重写整章的拍；只想改后面几拍就用「主线」页的「只重排剩下的拍」。「手动推进一拍」用于正文模型忘了写回报时的手动纠偏。<br>
            主线收尾后，**间隙会自动交给「间章」**（演日常、顺手埋伏笔），而不是让场子空着等新章 —— 你可以随时手动「开一段间章」。</p>`}
        </div>
        <div class="sd-card">
            <div class="sd-card-head"><span class="sd-card-title">支线</span><span class="sd-chip">${threads.length} 条在演</span></div>
            ${threads.length ? `<ul class="sd-threads">${threads.map((item) => `<li><b>${esc(String(unwrap(item[THREAD_FIELDS.title]) ?? item.id))}</b><span>${esc(firstLine(String(unwrap(item[THREAD_FIELDS.goal]) ?? '')))}</span></li>`).join('')}</ul>` : '<p class="sd-empty">一条支线都没有。</p>'}
            <div class="sd-row">
                <button type="button" class="sd-btn sd-add-thread">加一条支线</button>
                <button type="button" class="sd-btn sd-manage-thread">管理支线</button>
            </div>
        </div>
        <div class="sd-card">
            <div class="sd-card-head"><span class="sd-card-title">插曲</span><span class="sd-chip">${interludes.length} 条待演</span></div>
            ${interludes.length ? `<ul class="sd-threads">${interludes.map((item) => `<li><b>${esc(String(unwrap(item[INTERLUDE_FIELDS.title]) ?? item.id))}</b><span>${esc(firstLine(String(unwrap(item[INTERLUDE_FIELDS.beat]) ?? '')))}</span></li>`).join('')}</ul>` : '<p class="sd-empty">没有待演的插曲。</p>'}
            <div class="sd-row">
                <button type="button" class="sd-btn sd-add-interlude">加一条插曲</button>
                <button type="button" class="sd-btn sd-manage-interlude">管理插曲</button>
            </div>
        </div>
        <div class="sd-card">
            <div class="sd-card-head"><span class="sd-card-title">导演状态</span></div>
            <div class="sd-chips">
                ${busyChip()}
                ${statusChip(!!s.autoDirector, s.autoDirector ? '自动推进' : '已暂停')}
                ${statusChip(!!mvu(), mvu() ? 'MVU 就绪' : 'MVU 未加载')}
                ${statusChip(typeof oracleApi()?.run === 'function', typeof oracleApi()?.run === 'function' ? '神谕可用' : '神谕不可用')}
                ${statusChip(isGlobalBookEnabled(PLUGIN_WORLD), isGlobalBookEnabled(PLUGIN_WORLD) ? '世界书已挂载' : '世界书未挂载')}
            </div>
            ${history.length ? `<p class="sd-note">已经走过的章：${esc(history.join(' → '))}</p>` : ''}
            <p class="sd-note sd-pacing">${esc(pacingHint())}</p>
            <div class="sd-row">
                <button type="button" class="sd-btn sd-toggle-director">${s.autoDirector ? '暂停自动导演' : '继续自动导演'}</button>
                <button type="button" class="sd-btn sd-clear-story">清空这个故事</button>
            </div>
        </div>
        <details class="sd-fold">
            <summary>诊断</summary>
            <div class="sd-fold-body">
                <p class="sd-status"></p>
                <details class="sd-log"><summary>实际注入的引导全文</summary><pre class="sd-inject-preview"></pre></details>
                <details class="sd-log"><summary>变量契约（注入在主提示词里）</summary><pre class="sd-contract-preview"></pre></details>
            </div>
        </details>`;

    host.querySelector('.sd-generate-chapter')?.addEventListener('click', () => {
        void openChapterDialog({ regenerate: !!title });
    });
    host.querySelector('.sd-force-open')?.addEventListener('click', () => { void forceOpenStory(); });
    host.querySelector('.sd-next-beat')?.addEventListener('click', () => {
        void manualAdvanceBeat();
    });
    host.querySelector('.sd-finish-chapter')?.addEventListener('click', () => {
        void finishChapter();
    });
    host.querySelector('.sd-add-thread')?.addEventListener('click', () => {
        void generateThread({ quiet: false, force: true });
    });
    host.querySelector('.sd-add-interlude')?.addEventListener('click', () => {
        void generateInterlude({ quiet: false, force: true });
    });
    host.querySelector('.sd-manage-thread')?.addEventListener('click', () => { settings().tab = 'side'; save(); render(); });
    host.querySelector('.sd-manage-interlude')?.addEventListener('click', () => { settings().tab = 'side'; save(); render(); });
    host.querySelector('.sd-toggle-director')?.addEventListener('click', () => {
        settings().autoDirector = !settings().autoDirector;
        save();
        syncMainInjection();
        render();
    });
    host.querySelector('.sd-clear-story')?.addEventListener('click', () => { void clearStory(); });
    host.querySelector('.sd-start-interlude')?.addEventListener('click', () => {
        void generateInterludeChapter({ quiet: false, force: true });
    });
    host.querySelector('.sd-regen-interlude')?.addEventListener('click', () => {
        void generateInterludeChapter({ quiet: false, force: true });
    });
    host.querySelector('.sd-end-interlude')?.addEventListener('click', () => {
        void endInterludeNow();
    });
    host.querySelector('.sd-next-ilbeat')?.addEventListener('click', () => {
        void manualAdvanceInterludeBeat();
    });

    renderDiagnostics();
}

function renderMainTab() {
    const host = panel?.querySelector('.sd-main-tab');
    if (!host) return;
    const s = settings();
    const main = mainState();
    const beats = beatsOf(main);
    host.innerHTML = `
        <div class="sd-card">
            <div class="sd-card-head"><span class="sd-card-title">主线（一章一拍地演）</span></div>
            <label class="sd-field"><span>章标题</span><input name="main-title" value="${esc(String(unwrap(main[MAIN_TITLE]) ?? ''))}"></label>
            <label class="sd-field"><span>分卷（这一章属于哪一部）</span><input name="main-arc" value="${esc(String(unwrap(main[MAIN_ARC]) ?? ''))}"></label>
            <label class="sd-field"><span>章目标（写成矛盾的走向：局面从什么样变成什么样）</span><textarea name="main-goal" rows="2">${esc(String(unwrap(main[MAIN_GOAL]) ?? ''))}</textarea></label>
            <label class="sd-field"><span>范围（不写什么）</span><textarea name="main-scope" rows="2">${esc(String(unwrap(main[MAIN_SCOPE]) ?? ''))}</textarea></label>
            <label class="sd-field"><span>拍（一行一拍，<code>1. …</code> 起头）</span><textarea name="main-beats" rows="8">${esc(beats.map((text, index) => `${index + 1}. ${text}`).join('\n'))}</textarea></label>
            <div class="sd-row">
                <button type="button" class="sd-btn sd-save-main">保存这一章</button>
                <button type="button" class="sd-btn sd-generate-chapter">重新生成本章</button>
                <button type="button" class="sd-btn sd-regen-rest">只重排剩下的拍</button>
            </div>
            <p class="sd-note">「只重排剩下的拍」不会动已经演过的部分：它把第 ${currentBeat(main)} 拍起的剩余内容交给神谕重新设计（因为它报了这一拍在当前场景里站不住时最有用）。</p>
        </div>
        <div class="sd-card">
            <div class="sd-card-head"><span class="sd-card-title">节奏</span></div>
            <div class="sd-row sd-intensities">
                ${Object.entries(INTENSITIES).map(([key, item]) => `<button type="button" class="sd-btn sd-intensity ${s.intensity === key ? 'is-active' : ''}" data-key="${key}" title="${esc(item.caption)}">${esc(item.label)}</button>`).join('')}
            </div>
            <label class="sd-field"><span>每章拍数（${BEAT_MIN}~${BEAT_MAX}）</span><input name="beat-target" type="number" min="${BEAT_MIN}" max="${BEAT_MAX}" step="1" value="${esc(s.beatTarget)}"></label>
            <p class="sd-note">节奏影响的是**写作时的发力程度**（埋伏笔 / 慢慢推进 / 快点引爆），不会改变拍的顺序。</p>
        </div>`;

    host.querySelector('.sd-save-main')?.addEventListener('click', () => { void saveMainFromForm(); });
    host.querySelector('.sd-generate-chapter')?.addEventListener('click', () => { void openChapterDialog({ regenerate: true }); });
    host.querySelector('.sd-regen-rest')?.addEventListener('click', () => { void regenerateRemainingBeats(); });
    host.querySelectorAll('.sd-intensity').forEach((button) => {
        button.addEventListener('click', () => {
            settings().intensity = button.dataset.key;
            save();
            syncMainInjection();
            render();
        });
    });
    host.querySelector('[name="beat-target"]')?.addEventListener('change', (event) => {
        settings().beatTarget = Math.max(BEAT_MIN, Math.min(BEAT_MAX, Math.round(toNumber(event.target.value, 4))));
        save();
        render();
    });
}

function renderSideTab() {
    const host = panel?.querySelector('.sd-side-tab');
    if (!host) return;
    const threads = threadsState();
    const interludes = interludesState();
    const threadRows = threads.length ? threads.map((item) => {
        const status = String(display(item[THREAD_FIELDS.status] ?? '')).trim() || STATUS_PENDING;
        return `<div class="sd-item">
            <div class="sd-item-head">
                <b>${esc(String(unwrap(item[THREAD_FIELDS.title]) ?? item.id))}</b>
                <span class="sd-chip">${esc(status)}</span>
            </div>
            <p class="sd-line"><b>目标</b>${esc(String(unwrap(item[THREAD_FIELDS.goal]) ?? ''))}</p>
            <p class="sd-line"><b>落点</b>${esc(String(unwrap(item[THREAD_FIELDS.land]) ?? ''))}</p>
            <div class="sd-row">
                <button type="button" class="sd-btn sd-thread-done" data-id="${esc(item.id)}">标记完成</button>
                <button type="button" class="sd-btn sd-thread-drop" data-id="${esc(item.id)}">删除</button>
            </div>
        </div>`;
    }).join('') : '<p class="sd-empty">还没有支线。</p>';

    const interludeRows = interludes.length ? interludes.map((item) => {
        const status = String(display(item[INTERLUDE_FIELDS.status] ?? '')).trim() || STATUS_PENDING;
        return `<div class="sd-item">
            <div class="sd-item-head">
                <b>${esc(String(unwrap(item[INTERLUDE_FIELDS.title]) ?? item.id))}</b>
                <span class="sd-chip">${esc(status)}</span>
            </div>
            <p class="sd-line"><b>内容</b>${esc(String(unwrap(item[INTERLUDE_FIELDS.beat]) ?? ''))}</p>
            <p class="sd-line sd-dim"><b>接在</b>${esc(String(unwrap(item[INTERLUDE_FIELDS.after]) ?? ''))}</p>
            <div class="sd-row">
                <button type="button" class="sd-btn sd-interlude-done" data-id="${esc(item.id)}">标记已演</button>
                <button type="button" class="sd-btn sd-interlude-drop" data-id="${esc(item.id)}">删除</button>
            </div>
        </div>`;
    }).join('') : '<p class="sd-empty">还没有插曲。</p>';

    host.innerHTML = `
        <div class="sd-card">
            <div class="sd-card-head"><span class="sd-card-title">支线</span><span class="sd-chip">共 ${threads.length} 条</span></div>
            ${threadRows}
            <div class="sd-row"><button type="button" class="sd-btn sd-add-thread">让神谕再加一条</button></div>
        </div>
        <div class="sd-card">
            <div class="sd-card-head"><span class="sd-card-title">插曲</span><span class="sd-chip">共 ${interludes.length} 条</span></div>
            ${interludeRows}
            <div class="sd-row"><button type="button" class="sd-btn sd-add-interlude">让神谕再加一条</button></div>
        </div>`;

    host.querySelector('.sd-add-thread')?.addEventListener('click', () => { void generateThread({ quiet: false, force: true }); });
    host.querySelector('.sd-add-interlude')?.addEventListener('click', () => { void generateInterlude({ quiet: false, force: true }); });
    host.querySelectorAll('.sd-thread-done').forEach((button) => button.addEventListener('click', () => {
        void patchEntry('支线', button.dataset.id, { [THREAD_FIELDS.status]: STATUS_DONE, [THREAD_FIELDS.done]: true, [THREAD_FIELDS.ended]: new Date().toISOString() }).then(() => { syncMainInjection(); render(); });
    }));
    host.querySelectorAll('.sd-thread-drop').forEach((button) => button.addEventListener('click', () => {
        void dropEntry('支线', button.dataset.id).then(() => { syncMainInjection(); render(); });
    }));
    host.querySelectorAll('.sd-interlude-done').forEach((button) => button.addEventListener('click', () => {
        void patchEntry('插曲', button.dataset.id, { [INTERLUDE_FIELDS.status]: STATUS_DONE, [INTERLUDE_FIELDS.done]: true }).then(() => { syncMainInjection(); render(); });
    }));
    host.querySelectorAll('.sd-interlude-drop').forEach((button) => button.addEventListener('click', () => {
        void dropEntry('插曲', button.dataset.id).then(() => { syncMainInjection(); render(); });
    }));
}

function renderSetTab() {
    const host = panel?.querySelector('.sd-set-tab');
    if (!host) return;
    const s = settings();
    const t = (name) => `[name="${name}"]`;
    host.innerHTML = `
        <div class="sd-card">
            <div class="sd-card-head"><span class="sd-card-title">自动化</span></div>
            <label class="sd-switch"><input name="auto-director" type="checkbox"> 自动导演总闸（关掉＝只手动生成与采用）</label>
            <label class="sd-switch"><input name="auto-beat" type="checkbox"> 自动换拍（当前拍落了就进入下一拍）</label>
            <label class="sd-switch"><input name="auto-chapter" type="checkbox"> 自动换章（章目标达成后请神谕开下一章）</label>
            <label class="sd-switch"><input name="auto-thread" type="checkbox"> 自动续支线</label>
            <label class="sd-switch"><input name="auto-interlude" type="checkbox"> 自动加插曲（不占幕的随机小段）</label>
            <label class="sd-switch"><input name="auto-interlude-chapter" type="checkbox"> <b>主线收尾后自动开「间章」</b>（间隙演日常，不让场子空着）</label>
            <label class="sd-switch"><input name="auto-redesign" type="checkbox"> 拍站不住时重新设计（正文模型报「调整 / 驳回」）</label>
            <p class="sd-sub">审查的升级梯：**重排剩下的拍** → 仍然报错就**废掉整章重建** → 再报错就**重设篇章这一段**。</p>
            <div class="sd-row">
                <label class="sd-field"><span>「重排剩下的拍」最多试几次（之后废章重建）</span><input name="redesign-max" type="number" min="1" max="5" step="1"></label>
                <label class="sd-field"><span>两次自动重设计之间至少隔几轮（节流）</span><input name="redesign-gap" type="number" min="0" max="30" step="1"></label>
            </div>
            <div class="sd-row">
                <label class="sd-field"><span>每多少轮加一条支线</span><input name="thread-every" type="number" min="1" max="200" step="1"></label>
                <label class="sd-field"><span>每多少轮加一条插曲</span><input name="interlude-every" type="number" min="1" max="200" step="1"></label>
                <label class="sd-field"><span>换拍最小间隔（轮）</span><input name="min-replies" type="number" min="0" max="20" step="1"></label>
            </div>
            <p class="sd-sub">下面这三项是「不要一直生成」的总闸门：</p>
            <div class="sd-row">
                <label class="sd-field"><span>任意两次生成的最小间隔（轮）</span><input name="auto-cooldown" type="number" min="0" max="30" step="1"></label>
                <label class="sd-field"><span>上一章收尾后隔几轮才开下一章</span><input name="chapter-gap" type="number" min="0" max="30" step="1"></label>
                <label class="sd-field"><span>新章开头几轮先不插支线／插曲</span><input name="thread-warmup" type="number" min="0" max="30" step="1"></label>
            </div>
            <div class="sd-row">
                <label class="sd-field"><span>开间章前再等几轮（余波）</span><input name="interlude-gap" type="number" min="0" max="30" step="1"></label>
                <label class="sd-field"><span>一段间章最多几个日常画面</span><input name="interlude-beats" type="number" min="1" max="6" step="1"></label>
            </div>
            <p class="sd-note">「自动导演」关掉后，插件不再自己调模型，但注入与变量回报照常工作——你可以只在需要时点按钮。<b>每次自动生成都是一次真实的模型调用</b>，节奏调太密会费 token。<br>
            一轮 = 一条 AI 回复；挂机不影响节奏（不看墙钟）。「任意两次生成的最小间隔」跨线生效：支线与插曲不会在同一轮里一起冒出来。想知道下一次什么时候能生成，看「当前」页的导演状态卡片。</p>
        </div>
        <div class="sd-card">
            <div class="sd-card-head"><span class="sd-card-title">注入</span></div>
            <label class="sd-switch"><input name="inject-main" type="checkbox"> 注入主线引导</label>
            <label class="sd-switch"><input name="inject-threads" type="checkbox"> 注入支线</label>
            <label class="sd-switch"><input name="inject-interludes" type="checkbox"> 注入插曲</label>
            <label class="sd-switch"><input name="inject-contract" type="checkbox"> 注入变量契约（落拍回报的写法）</label>
            <label class="sd-switch"><input name="ban-user-action" type="checkbox"> <b>禁止安排 {{user}} 的行为</b>（强烈建议保持开启）</label>
            <p class="sd-note">这条管的是**剧情的引擎**：开着时，注入会硬性要求正文模型把每一拍写成「谁做了什么 → 局面变成什么样」，
            绝不替 {{user}} 说话 / 做事 / 下决定，剧情靠**别人的行动、场里的事件与伏笔**往前推。
            关掉它就等于允许导演替你安排行为 —— 除了「我就想看 AI 也演我」这种玩法，一般不要关。</p>
            <div class="sd-row">
                <label class="sd-field"><span>注入深度（越小离最新一条越近）</span><input name="inject-depth" type="number" min="0" max="30" step="1"></label>
                <label class="sd-field"><span>同时在演的支线上限</span><input name="max-threads" type="number" min="0" max="5" step="1"></label>
                <label class="sd-field"><span>同时在演的插曲上限</span><input name="max-interludes" type="number" min="0" max="3" step="1"></label>
            </div>
        </div>
        <div class="sd-card">
            <div class="sd-card-head"><span class="sd-card-title">生成</span></div>
            <label class="sd-switch"><input name="story-transcript" type="checkbox"> 生成时把最近对话捎给故事神谕</label>
            <label class="sd-field"><span>附带哪一档世界书设定给神谕</span><select name="oracle-worldinfo">
                ${Object.entries(ORACLE_WORLDINFO_MODES).map(([key, item]) => `<option value="${key}">${esc(item.label)}</option>`).join('')}
            </select></label>
            <label class="sd-field"><span>近期对话上限（字符）</span><input name="transcript-limit" type="number" min="2000" max="60000" step="500"></label>
            <label class="sd-switch"><input name="auto-epic" type="checkbox"> <b>自动定篇章</b>（先有一条围绕 {{user}} 的长线，再开第一章）</label>
            <label class="sd-switch"><input name="evolve-epic" type="checkbox"> 每开新章前按「他实际做了什么」重新校准篇章</label>
            <p class="sd-note">篇章是主线不平淡的关键：有它，每一章才是「一部史诗的一拍」，而不是走到哪算哪。
            第一项定篇章花一次调用；第二项每开一章多花一次调用（但能跟住你的偏离——你随时可能不按剧本走）。两项都关掉时，主线就退回逐章续写。</p>
            <label class="sd-field"><span>世界书档位（影响这本世界书在酒馆里的注入）</span><select name="book-mode">
                ${Object.entries(BOOK_MODES).map(([key, item]) => `<option value="${key}">${esc(item.label)}</option>`).join('')}
            </select></label>
            <label class="sd-switch"><input name="auto-install-book" type="checkbox"> 缺失时自动安装自带世界书</label>
            <label class="sd-switch"><input name="auto-update-book" type="checkbox"> <b>内容有更新时自动重装</b>（按版本标记比对；<b>旧内容会先备份</b>）</label>
            <p class="sd-note">规则与变量契约都在自带世界书里，我们改了它就会升版本号 —— 开着这项就不用每次手点「安装／重装」。
            更新前会把酒馆里那份**原样备份**成「${esc(PLUGIN_WORLD)}（更新前备份 …）」，你可以随时对照或删掉。</p>
            <label class="sd-switch"><input name="auto-mount-book" type="checkbox"> 安装后挂到全局世界书</label>
            <div class="sd-row">
                <button type="button" class="sd-btn sd-install-book">安装／重装自带世界书</button>
                <button type="button" class="sd-btn sd-mount-book">挂载到全局世界书</button>
                <button type="button" class="sd-btn sd-refresh-book">刷新列表</button>
            </div>
            <div class="sd-card" style="margin-top:8px">
                <div class="sd-card-head"><span class="sd-card-title">故事神谕兼容性</span></div>
                <p class="sd-note sd-oracle-compat"></p>
                <div class="sd-row"><button type="button" class="sd-btn sd-check-oracle">重新探测</button></div>
            </div>
            <p class="sd-note">面板按钮与自动生成走的是 <code>StoryOracleAPI.run()</code>——<b>裸模型调用、不会自带上下文</b>，所以插件自己把世界书、近期对话与当前变量拼给它。要让它自己读设定，就在神谕窗口用「故事导演」模式聊。</p>
        </div>
        <div class="sd-card">
            <div class="sd-card-head"><span class="sd-card-title">外观</span></div>
            <div class="sd-row">
                <label class="sd-field"><span>悬浮球大小（px）</span><input name="bubble-size" type="number" min="28" max="120" step="1"></label>
                <label class="sd-field"><span>自定义图标（留空＝自带）</span><input name="bubble-icon" placeholder="https://… 或 icon.svg"></label>
            </div>
        </div>`;

    const bind = (name, key, kind = 'check') => {
        const node = host.querySelector(t(name));
        if (!node) return;
        if (kind === 'check') node.checked = !!s[key];
        else node.value = s[key];
        node.addEventListener(kind === 'check' ? 'change' : (node.tagName === 'SELECT' ? 'change' : 'input'), () => {
            if (kind === 'check') s[key] = node.checked;
            else if (node.type === 'number') s[key] = Number(node.value);
            else s[key] = node.value;
            save();
            syncMainInjection();
            if (key === 'bubbleSize' || key === 'bubbleIcon') applyBubbleLook();
        });
    };
    bind('auto-director', 'autoDirector');
    bind('auto-beat', 'autoBeat');
    bind('auto-chapter', 'autoChapter');
    bind('auto-thread', 'autoThread');
    bind('auto-interlude', 'autoInterlude');
    bind('auto-interlude-chapter', 'autoInterludeChapter');
    bind('interlude-gap', 'interludeGap', 'value');
    bind('interlude-beats', 'interludeBeats', 'value');
    bind('auto-redesign', 'autoRedesign');
    bind('redesign-max', 'redesignMax', 'value');
    bind('redesign-gap', 'redesignGap', 'value');
    bind('thread-every', 'threadEvery', 'value');
    bind('interlude-every', 'interludeEvery', 'value');
    bind('min-replies', 'minReplies', 'value');
    bind('auto-cooldown', 'autoCooldown', 'value');
    bind('chapter-gap', 'chapterGap', 'value');
    bind('thread-warmup', 'threadWarmup', 'value');
    bind('inject-main', 'injectMain');
    bind('inject-threads', 'injectThreads');
    bind('inject-interludes', 'injectInterludes');
    bind('inject-contract', 'injectContract');
    bind('ban-user-action', 'banUserAction');
    bind('inject-depth', 'injectDepth', 'value');
    bind('max-threads', 'maxThreads', 'value');
    bind('max-interludes', 'maxInterludes', 'value');
    bind('story-transcript', 'storyTranscript');
    bind('auto-epic', 'autoEpic');
    bind('evolve-epic', 'evolveEpic');
    bind('transcript-limit', 'transcriptLimit', 'value');
    bind('auto-install-book', 'autoInstallBook');
    bind('auto-update-book', 'autoUpdateBook');
    bind('auto-mount-book', 'autoMountBook');
    bind('bubble-size', 'bubbleSize', 'value');
    bind('bubble-icon', 'bubbleIcon', 'value');

    const wf = host.querySelector(t('oracle-worldinfo'));
    if (wf) {
        wf.value = ORACLE_WORLDINFO_MODES[s.oracleWorldInfo] ? s.oracleWorldInfo : 'char';
        wf.addEventListener('change', () => { s.oracleWorldInfo = wf.value; save(); });
    }
    const bm = host.querySelector(t('book-mode'));
    if (bm) {
        bm.value = BOOK_MODES[s.bookMode] ? s.bookMode : 'full';
        bm.addEventListener('change', () => { s.bookMode = bm.value; save(); void applyBookMode(); });
    }
    host.querySelector('.sd-install-book')?.addEventListener('click', () => {
        // 手动点 = 明确的重装意图：不管版本标记，直接把自带那份写回去（旧内容会先备份）
        void installBundledWorldbook({ notify: true, mount: settings().autoMountBook, ifMissing: false });
    });
    host.querySelector('.sd-mount-book')?.addEventListener('click', () => {
        setGlobalBook(PLUGIN_WORLD, true);
        toast('已把世界书「' + PLUGIN_WORLD + '」挂到全局世界书。', 'success');
        render();
    });
    const compatNode = host.querySelector('.sd-oracle-compat');
    if (compatNode) {
        const report = oracleCompatReport();
        compatNode.textContent = report.fatal
            ? `⚠ 不能工作：${report.missing.join('；')}`
            : (report.ok ? '✓ 接口齐全（run / context / 全部可选能力都在）' : `可用，但缺：${report.missing.join('；')}`);
    }
    host.querySelector('.sd-check-oracle')?.addEventListener('click', () => {
        const report = oracleCompatReport();
        toast(report.ok ? '故事神谕的接口齐全。' : (report.fatal ? '故事神谕的接口不可用，详见面板说明。' : '可用，但缺少部分可选能力。'), report.fatal ? 'error' : (report.ok ? 'success' : 'warning'));
        render();
    });
    host.querySelector('.sd-refresh-book')?.addEventListener('click', () => { void updateWorldInfoList().then(() => { render(); toast('世界书列表已刷新。', 'info'); }); });
}

/** 世界书档位：full 全开 / lite 关掉写作纪律 / vars 只留变量契约。 */
async function applyBookMode() {
    const s = settings();
    const mode = BOOK_MODES[s.bookMode] ? s.bookMode : 'full';
    try {
        const book = await loadWorldInfo(PLUGIN_WORLD);
        if (!book?.entries) return 'missing';
        let changed = false;
        for (const entry of Object.values(book.entries)) {
            if (!entry || typeof entry !== 'object') continue;
            const comment = String(entry.comment ?? '').trim();
            const want = mode === 'full' ? true
                : mode === 'lite' ? !/纪律|写作/.test(comment)
                    : /变量|契约/.test(comment);
            if (entry.disable === !want) continue;
            entry.disable = !want;
            entry.enabled = want;
            changed = true;
        }
        if (changed) await saveWorldInfo(PLUGIN_WORLD, book, true);
        return 'ok';
    } catch (error) {
        console.debug('[故事导演] 设置世界书档位失败', error);
        return 'failed';
    }
}

function renderTabs() {
    if (!panel) return;
    const s = settings();
    panel.querySelectorAll('.sd-tab').forEach((button) => {
        button.classList.toggle('is-active', button.dataset.tab === s.tab);
    });
    panel.querySelectorAll('.sd-page').forEach((page) => {
        page.hidden = page.dataset.tab !== s.tab;
    });
    if (s.tab === 'now') renderNowTab();
    if (s.tab === 'epic') renderEpicTab();
    if (s.tab === 'main') renderMainTab();
    if (s.tab === 'interlude') renderInterludeTab();
    if (s.tab === 'side') renderSideTab();
    if (s.tab === 'set') renderSetTab();
}

function render() {
    if (!panel) return;
    renderTabs();
}

// 阶段十三：面板操作

async function saveMainFromForm() {
    const host = panel?.querySelector('.sd-main-tab');
    if (!host) return;
    const beats = splitBeats(host.querySelector('[name="main-beats"]')?.value || '');
    const current = mainState();
    const before = beatsOf(current);
    const fields = {
        [MAIN_TITLE]: String(host.querySelector('[name="main-title"]')?.value || '').trim(),
        [MAIN_ARC]: String(host.querySelector('[name="main-arc"]')?.value || '').trim(),
        [MAIN_GOAL]: String(host.querySelector('[name="main-goal"]')?.value || '').trim(),
        [MAIN_SCOPE]: String(host.querySelector('[name="main-scope"]')?.value || '').trim(),
        // 清空输入框也要真的写进去（以前「空文本不写」会让旧拍留在库里，还顺手把游标倒回第 1 拍 → 整章重演）
        [MAIN_BEATS]: beats,
    };
    // 拍列表变了（条数或内容）＝换了一份演出计划，拍进度回到第 1 拍
    const changed = beats.length !== before.length || beats.some((text, index) => text !== before[index]);
    if (changed) {
        fields[KEY_BEAT] = 1;
        fields[KEY_BEAT_DONE] = false;
        fields[KEY_CHAPTER_DONE] = false;
        fields[KEY_READY] = false;
    }
    await patchMain(fields);
    if (changed) {
        const rt = settings().run;
        rt.focusBeat = 1;
        rt.beatAt = aiMessageCount();
        rt.closedChapter = '';
        save();
    }
    syncMainInjection();
    render();
    toast(beats.length ? `这一章已保存（${beats.length} 拍${changed ? '，拍进度已回到第 1 拍' : ''}）。` : '这一章的拍列表已清空。', 'success');
}

/** 手动推进一拍（正文模型忘了写回报时的纠偏）。 */
async function manualAdvanceBeat() {
    const main = mainState();
    const beats = beatsOf(main);
    if (!beats.length) { toast('还没有拍列表。', 'warning'); return; }
    const beat = currentBeat(main);
    if (beat > beats.length) { toast('本章的拍已经全部演过了。', 'info'); return; }
    await patchMain({ [KEY_BEAT]: beat + 1, [KEY_BEAT_DONE]: false });
    const rt = settings().run;
    rt.focusBeat = beat + 1;
    rt.beatAt = aiMessageCount();
    save();
    syncMainInjection();
    render();
    toast(`已切到第 ${beat + 1} 拍（共 ${beats.length} 拍）。`, 'success');
}

/** 本章收尾：把整章标成演完，等自动换章或手动点「设计下一章」。 */
async function finishChapter() {
    const main = mainState();
    const beats = beatsOf(main);
    await patchMain({ [KEY_BEAT]: beats.length + 1, [KEY_CHAPTER_DONE]: true, [KEY_READY]: true });
    // ⚠ 不要在这里伪造 live：rootOf() 是 getMvuData 的快照，包成 live 会让 rememberChapter 走
    // 「只原地改、不回写」的快路径，章节史就进不了 MVU（autoChapter 关掉时永远进不了）。
    await rememberChapter(main);
    settings().run.closedChapter = `主线:${String(unwrap(main[MAIN_TITLE]) ?? '').trim()}`;
    save();
    syncMainInjection();
    render();
    toast('本章已标记为收尾；自动换章开着的话会请神谕开下一章。', 'success');
    if (settings().autoDirector && settings().autoChapter) void evaluateDirector();
}

/** 只重排剩下的拍（已演过的不动）。 */
async function regenerateRemainingBeats() {
    const main = mainState();
    const beats = beatsOf(main);
    const beat = currentBeat(main);
    if (!beats.length) { void generateChapter({ quiet: false, force: true }); return; }
    if (beat > beats.length) {
        toast('这一章的拍已经全部演过了——点「设计下一章」，或先用「重新生成本章」整章重写。', 'info');
        return;
    }
    const played = Math.max(0, beat - 1);
    const tail = beats.slice(played);
    const userText = [
        '这是一次**局部重排**，只重写剩下的拍：',
        `已经演过的 ${played} 拍（不要重演、不要推翻它们造成的既成事实）：${beats.slice(0, played).map((text, index) => `${index + 1}. ${text}`).join('；') || '（无）'}`,
        `需要重排的剩余内容（原计划）：${tail.map((text, index) => `${played + index + 1}. ${text}`).join('；') || '（无）'}`,
        `请按现在的处境重新设计，并且**只给剩余的拍**，数量不要超过原来的 ${Math.max(1, tail.length)} 拍。`,
        '章标题 / 分卷 / 范围 / 章目标 可以照原样给回，也可以按新的处境微调——但这一章的定位不要变。',
    ].join('\n');
    await generateChapter({ quiet: false, regenerate: true, userText, force: true, keep: played });
}

async function clearStory() {
    if (!window.confirm('清空这个故事的主线、支线与插曲？MVU 里的 故事导演 命名空间会被重置（角色卡自己的变量不受影响）。')) return;
    const fields = {
        ...emptyMain(),
    };
    await patchMain(fields);
    const api = mvu();
    const d = mvuData();
    if (api?.replaceMvuData && isPlainObject(d?.stat_data)) {
        if (!isPlainObject(d.stat_data[NS])) d.stat_data[NS] = {};
        d.stat_data[NS].支线 = {};
        d.stat_data[NS].插曲 = {};
        d.stat_data[NS].章节史 = {};
        try { await api.replaceMvuData(d, { type: 'message', message_id: 'latest' }); } catch { /* ignore */ }
    }
    const s = settings();
    s.chapters = {};
    s.run = JSON.parse(JSON.stringify(DEFAULT.run));
    s.run.chatId = chatKey();
    save();
    failedKeys.clear();
    syncMainInjection();
    render();
    toast('这个故事已经清空。', 'success');
}

/**
 * 「立刻开篇」：把手动按钮该有的权力给足 —— 清掉退回 / 待办 / 冷却，
 * 需要就当场定篇章，然后开第一章。用于「等不及了」和「调试为什么不开篇」。
 */
async function forceOpenStory() {
    const s = settings();
    if (typeof oracleApi()?.run !== 'function') {
        toast('读不到「故事神谕」的模型连接 —— 先确认故事神谕已安装并启用。', 'error');
        return;
    }
    if (!mvu()?.getMvuData) { toast('MVU 没加载。', 'error'); return; }
    const rt = s.run;
    rt.epicTries = 0;
    rt.lastGenerateAt = 0;
    rt.aftermathAt = 0;
    rt.closedChapter = '';
    clearPending(`epic:${chatKey()}`);
    clearFailed(`epic:${chatKey()}`);
    clearFailed(`chapter:${chatKey()}:new`);
    save();
    const epic = epicOf(rootOf());
    if (s.autoEpic && !epicStarted(epic)) {
        toast('先定篇章…');
        const ok = await generateEpic({ quiet: false, force: true, mode: 'establish', entry: completedMainTitles(rootOf()).length });
        if (!ok) { toast('篇章没做成 —— 但可以照样开章（它只是配料）。', 'warning'); }
    }
    if (epicStarted(epicOf(rootOf()))) {
        await patchMain({ [MAIN_CLOSED]: false }, {});
    }
    const opened = await generateChapter({ quiet: false, force: true });
    noteAttempt(opened, opened ? '' : '见控制台日志');
    if (!opened) toast('开章失败 —— 控制台里有 [故事导演] 的原始回复，发给我看看。', 'error');
    syncMainInjection();
    if (!panel?.hidden) render();
}

/**
 * 排查用入口：`window.__storyDirector.why()` 会告诉你**现在为什么还没有开篇 / 卡在哪**。
 * 只读，不改任何状态 —— 面版里的说明与它是同一份逻辑。
 */
function exposeDiagnostics() {
    try {
        window.__storyDirector = {
            version: () => settings().schema,
            why: () => firstChapterBlocker(),
            oracle: () => oracleCompatReport(),
            forceOpen: () => forceOpenStory(),   // 排查用：立刻走一遍「定篇章 + 开章」全路径
            state: () => {
                const main = mainState();
                const chapter = interludeChapterOf(rootOf());
                return {
                    mode: currentMode(),
                    拍数: beatsOf(main).length,
                    当前拍: currentBeat(main),
                    章目标达成: truthy(main[KEY_CHAPTER_DONE]),
                    可进下一章: truthy(main[KEY_READY]),
                    已收尾: truthy(main[MAIN_CLOSED]),
                    间章进行中: truthy(chapter[IL.active]),
                    // ⚠ 这两个键改动名之后**不能再叫同一个名字**（同名会互相覆盖）：
                    //   史诗的**名字** vs 史诗**校准到第几章**，分开写清。
                    篇章名: epicStarted(epicOf(rootOf())) ? String(unwrap(epicOf(rootOf())[EP.title]) ?? '') : '',
                    篇章校准到第几章: epicChapter(epicOf(rootOf())),
                    定篇章已试: Math.round(toNumber(settings().run.epicTries, 0)),
                    AI回复数: aiMessageCount(),
                    生成中: storyGenerating,
                    在跑: [...pendingGenerates],
                    退避中: [...failedKeys.keys()],
                    档位: { 自动导演: settings().autoDirector, 自动定篇章: settings().autoEpic, 自动换章: settings().autoChapter, 基调: settings().tone },
                };
            },
        };
    } catch (error) { console.debug('[故事导演] 暴露诊断入口失败', error); }
}

/** 手动推进间章的一个日常画面。 */
async function manualAdvanceInterludeBeat() {
    const chapter = interludeChapterOf(rootOf());
    const beats = interludeBeatsOf(chapter);
    const beat = interludeBeat(chapter);
    if (!beats.length) { toast('这段间章还没有日常画面。', 'warning'); return; }
    if (beat > beats.length) { toast('素材里的日常画面都演过了 —— 点「现在回主线」吧。', 'info'); return; }
    await patchInterlude({ [IL.beat]: beat + 1, [IL.beatDone]: false });
    const rt = settings().run;
    rt.focusInterlude = beat + 1;
    rt.beatAt = aiMessageCount();
    save();
    syncMainInjection();
    render();
    toast(`间章切到第 ${beat + 1} 个日常画面（共 ${beats.length} 个）。`, 'success');
}

/** 「现在回主线」：立刻收掉间章（**不必跑完拍**），回主线并开新的一章。 */
async function endInterludeNow() {
    const chapter = interludeChapterOf(rootOf());
    if (!truthy(chapter[IL.active])) { toast('现在不在间章里。', 'info'); return; }
    await patchInterlude({ [IL.ready]: true });
    const rt = settings().run;
    // 手动按钮不受自动节奏的冷却限制：用户说了算
    rt.lastGenerateAt = 0;
    save();
    toast('好，回主线 —— 正在请故事神谕接上。', 'success');
    await evaluateDirector();
}

/** 手动开一段间章（把主线暂时收着）。 */
async function startInterludeNow() {
    if (currentMode() === 'interlude') { toast('已经在间章里了。', 'info'); return; }
    settings().run.lastGenerateAt = 0;
    save();
    await generateInterludeChapter({ quiet: false, force: true });
}

function renderInterludeTab() {
    const host = panel?.querySelector('.sd-interlude-tab');
    if (!host) return;
    const s = settings();
    const chapter = interludeChapterOf(rootOf());
    const beats = interludeBeatsOf(chapter);
    const beat = interludeBeat(chapter);
    const active = truthy(chapter[IL.active]);
    const rt = s.run;
    const count = aiMessageCount();
    const gap = Math.max(0, Math.round(toNumber(s.interludeGap, 3)));
    const afterMark = Math.round(toNumber(rt.aftermathAt, 0)) || Math.round(toNumber(rt.chapterOpenedAt, 0));
    const wait = Math.max(0, gap - (count - afterMark));
    const history = completedMainTitles(rootOf());

    host.innerHTML = `
        <div class="sd-card ${active ? 'sd-card-main' : ''}">
            <div class="sd-card-head">
                <span class="sd-card-title">间章${String(unwrap(chapter[IL.title]) ?? '').trim() ? ` · ${esc(String(unwrap(chapter[IL.title])).trim())}` : ''}</span>
                <span class="sd-chip ${active ? 'is-busy' : ''}">${active ? '进行中' : '未开始'}</span>
            </div>
            <p class="sd-note">间章是**与主线互斥**的另一种幕：主线收尾后的间隙交给它，演日常、顺手埋伏笔。
            与主线最大的区别是**它不要求跑完** —— 下面的日常画面只是素材，谁都可以跳过；写到合适的地方就收，随时回主线。</p>
            ${active ? `
                ${String(unwrap(chapter[IL.scene]) ?? '').trim() ? `<p class="sd-sub">场合：${esc(String(unwrap(chapter[IL.scene])).trim())}</p>` : ''}
                <label class="sd-field"><span>标题</span><input name="il-title" value="${esc(String(unwrap(chapter[IL.title]) ?? ''))}"></label>
                <label class="sd-field"><span>场合</span><input name="il-scene" value="${esc(String(unwrap(chapter[IL.scene]) ?? ''))}"></label>
                <label class="sd-field"><span>日常画面（一行一个，可写 <code>1. …</code>）</span><textarea name="il-beats" rows="5">${esc(beats.map((text, index) => `${index + 1}. ${text}`).join('\n'))}</textarea></label>
                <p class="sd-note">第 ${Math.min(beat, Math.max(1, beats.length))}/${beats.length || '—'} 个${beats.length && beat > beats.length ? '（素材已演完，可以回主线了）' : ''}
                ${String(unwrap(chapter[IL.note]) ?? '').trim() ? `　· 顺手埋的线：${esc(String(unwrap(chapter[IL.note])).trim())}` : ''}</p>
                <div class="sd-row">
                    <button type="button" class="sd-btn sd-save-interlude">保存这段间章</button>
                    <button type="button" class="sd-btn sd-next-ilbeat">手动推进一个画面</button>
                    <button type="button" class="sd-btn sd-end-interlude">现在回主线</button>
                    <button type="button" class="sd-btn sd-regen-interlude">换一段间章</button>
                </div>` : `
                <div class="sd-row">
                    <button type="button" class="sd-btn sd-start-interlude">现在开一段间章</button>
                    <button type="button" class="sd-btn sd-goto-main">去看看主线</button>
                </div>
                <p class="sd-note">${s.autoInterludeChapter
                    ? `自动：主线一章收尾、余波过 ${gap} 轮之后，会自动开一段间章（现在还要等 ${wait} 轮）。`
                    : '自动开间章是关着的：只有你点按钮才会进间章（主线收尾后会直接开下一章）。'}</p>`}
        </div>
        ${history.length ? `<div class="sd-card"><div class="sd-card-head"><span class="sd-card-title">走过的章</span></div><p class="sd-note">${esc(history.join(' → '))}</p></div>` : ''}`;

    host.querySelector('.sd-save-interlude')?.addEventListener('click', () => { void saveInterludeFromForm(); });
    host.querySelector('.sd-next-ilbeat')?.addEventListener('click', () => { void manualAdvanceInterludeBeat(); });
    host.querySelector('.sd-end-interlude')?.addEventListener('click', () => { void endInterludeNow(); });
    host.querySelector('.sd-regen-interlude')?.addEventListener('click', () => { void generateInterludeChapter({ quiet: false, force: true }); });
    host.querySelector('.sd-start-interlude')?.addEventListener('click', () => { void startInterludeNow(); });
    host.querySelector('.sd-goto-main')?.addEventListener('click', () => { settings().tab = 'main'; save(); render(); });
}

/** 保存间章手改（标题 / 场合 / 日常画面）。 */
async function saveInterludeFromForm() {
    const host = panel?.querySelector('.sd-interlude-tab');
    if (!host) return;
    const beats = splitBeats(host.querySelector('[name="il-beats"]')?.value || '');
    const before = interludeBeatsOf(interludeChapterOf(rootOf()));
    const fields = {
        [IL.title]: String(host.querySelector('[name="il-title"]')?.value || '').trim(),
        [IL.scene]: String(host.querySelector('[name="il-scene"]')?.value || '').trim(),
        [IL.beats]: beats,
    };
    const changed = beats.length !== before.length || beats.some((text, index) => text !== before[index]);
    if (changed) { fields[IL.beat] = 1; fields[IL.beatDone] = false; fields[IL.ready] = false; }
    await patchInterlude(fields);
    if (changed) {
        const rt = settings().run;
        rt.focusInterlude = 1;
        rt.beatAt = aiMessageCount();
        save();
    }
    syncMainInjection();
    render();
    toast('这段间章已保存。', 'success');
}

function renderEpicTab() {
    const host = panel?.querySelector('.sd-epic-tab');
    if (!host) return;
    const s = settings();
    const epic = epicOf(rootOf());
    const started = epicStarted(epic);
    const movements = epicMovements(epic);
    const hooks = epicHooks(epic);
    const past = completedMainTitles(rootOf()).length;
    const upTo = epicChapter(epic);

    host.innerHTML = `
        <div class="sd-card ${started ? 'sd-card-main' : ''}">
            <div class="sd-card-head">
                <span class="sd-card-title">篇章（围绕 {{user}} 的长线）</span>
                <span class="sd-chip">${started ? `校准到第 ${upTo} 章` : '还没有篇章'}</span>
            </div>
            <label class="sd-field"><span>基调（决定这条长线是什么型的故事；由你选，不由模型判断）</span><select name="tone">
                ${toneOptions().map((item) => `<option value="${esc(item.value)}" ${toneOf(s.tone) === item.value ? 'selected' : ''}>${esc(item.label)}</option>`).join('')}
            </select></label>
            <p class="sd-note">这条长线写的是「围绕他会发生什么」，<b>不写他会怎么做</b>：他中途走出剧本是常态，
            插件会在开新章之前按他实际做的事重新校准。<br>
            <b>它是「大势」不是章纲</b> —— 只讲整部戏分几个大阶段、现在走到哪；<b>一章内部怎么起承转合由主线自己设计</b>。<br>
            基调会作为**最高优先级的创作方针**同时给到篇章与每一章的设计：选「冒险」就允许远行、险境、突围；
            选「日常」就明确不要大事件，张力来自关系的小位移。换基调之后点一次「重新定篇章（换一部）」才会按新基调重写。</p>
            ${started ? `
                <label class="sd-field"><span>标题</span><input name="epic-title" value="${esc(String(unwrap(epic[EP.title]) ?? ''))}"></label>
                <label class="sd-field"><span>篇章（两三句，说清在争什么）</span><textarea name="epic-line" rows="3">${esc(String(unwrap(epic[EP.line]) ?? ''))}</textarea></label>
                <label class="sd-field"><span>大阶段（一行一段，整部戏的骨架 —— <b>不是章节表</b>，别写起承转合）</span><textarea name="epic-movements" rows="6">${esc(movements.map((text, i) => `${i + 1}. ${text}`).join('\n'))}</textarea></label>
                <label class="sd-field"><span>伏笔（用「；」分开）</span><textarea name="epic-hooks" rows="2">${esc(hooks.join('；'))}</textarea></label>
                <label class="sd-field"><span>既成事实（不可撤销）</span><textarea name="epic-ledger" rows="2">${esc(String(unwrap(epic[EP.ledger]) ?? ''))}</textarea></label>
                <label class="sd-field"><span>当前进程</span><select name="epic-stage">
                    ${['', ...EPIC_STAGES].map((name) => `<option value="${esc(name)}" ${String(unwrap(epic[EP.stage]) ?? '') === name ? 'selected' : ''}>${esc(name || '（未定）')}</option>`).join('')}
                </select></label>
                <div class="sd-row">
                    <button type="button" class="sd-btn sd-save-epic">保存篇章</button>
                    <button type="button" class="sd-btn sd-evolve-epic">按现在的情况重新校准</button>
                    <button type="button" class="sd-btn sd-rebuild-epic">重新定篇章（换一部）</button>
                </div>
                ${past > upTo ? `<p class="sd-note">⚠ 已经走过 ${past} 章，篇章只校准到第 ${upTo} 章 —— 建议点一次「重新校准」。</p>` : ''}` : `
                <div class="sd-row">
                    <button type="button" class="sd-btn sd-rebuild-epic">现在定一部篇章</button>
                </div>
                <p class="sd-note">${s.autoEpic ? '自动：聊满 2 轮、还没有拍列表时，会自动定篇章，然后才开第一章。' : '自动定篇章是关着的：只在「设定」页打开，或点上面的按钮。'}</p>`}
        </div>`;

    host.querySelector('[name="tone"]')?.addEventListener('change', (event) => {
        const picked = toneOf(event.target.value);
        settings().tone = picked;
        save();
        syncMainInjection();
        toast('基调已切到「' + TONES[picked].label + '」——点一次「重新定篇章（换一部）」才会按新基调重写篇章。', 'info');
        render();
    });
    host.querySelector('.sd-save-epic')?.addEventListener('click', () => { void saveEpicFromForm(); });
    host.querySelector('.sd-evolve-epic')?.addEventListener('click', () => {
        void openEpicDialog({ mode: 'evolve', entry: past });
    });
    host.querySelector('.sd-rebuild-epic')?.addEventListener('click', () => {
        void openEpicDialog({ mode: 'establish', entry: past });
    });
}

/** 保存篇章手改。 */
async function saveEpicFromForm() {
    const host = panel?.querySelector('.sd-epic-tab');
    if (!host) return;
    const movements = splitBeats(host.querySelector('[name="epic-movements"]')?.value || '');
    const hooks = String(host.querySelector('[name="epic-hooks"]')?.value || '')
        .split(/[；;\n]/).map((text) => text.trim()).filter(Boolean);
    await patchEpic({
        [EP.title]: String(host.querySelector('[name="epic-title"]')?.value || '').trim(),
        [EP.line]: String(host.querySelector('[name="epic-line"]')?.value || '').trim(),
        [EP.movements]: movements,
        [EP.hooks]: hooks,
        [EP.ledger]: String(host.querySelector('[name="epic-ledger"]')?.value || '').trim(),
        [EP.stage]: String(host.querySelector('[name="epic-stage"]')?.value || '').trim(),
        [EP.updated]: new Date().toISOString(),
    });
    syncMainInjection();
    render();
    toast('篇章已保存。', 'success');
}

// 阶段十四：悬浮窗

function applyBubbleLook(node = bubble) {
    if (!node) return;
    const s = settings();
    const size = Math.max(28, Math.min(120, Math.round(Number(s.bubbleSize) || 52)));
    node.style.setProperty('--sd-bubble-size', `${size}px`);
    const custom = String(s.bubbleIcon || '').trim();
    const url = custom || bundledIconUrl();
    let img = node.querySelector('.sd-bubble-img');
    if (!img) {
        node.textContent = '';
        img = document.createElement('img');
        img.className = 'sd-bubble-img';
        img.alt = '';
        img.draggable = false;
        img.addEventListener('error', () => {
            if (img.dataset.fallback === 'bundled') { node.classList.add('is-text'); node.textContent = '导'; return; }
            img.dataset.fallback = 'bundled';
            img.src = bundledIconUrl();
        });
        node.appendChild(img);
    }
    if (img.getAttribute('src') !== url) {
        img.dataset.fallback = url === bundledIconUrl() ? 'bundled' : 'custom';
        img.src = url;
    }
    node.classList.remove('is-text');
    node.classList.add('has-icon');
}

function makeBubble() {
    bubble = document.createElement('button');
    bubble.id = 'story-director-bubble';
    bubble.type = 'button';
    bubble.title = '打开 故事导演';
    bubble.setAttribute('aria-label', '打开 故事导演');
    bubble.textContent = '导';
    applyBubbleLook(bubble);
    const s = settings();
    if (Number.isFinite(s.bubbleX)) bubble.style.left = `${s.bubbleX}px`;
    if (Number.isFinite(s.bubbleY)) bubble.style.top = `${s.bubbleY}px`;
    bubble.addEventListener('click', (event) => {
        if (dragging) return;
        if (panel && !panel.hidden) close(); else open();
        event.stopPropagation();
    });
    bubble.addEventListener('pointerdown', (event) => {
        dragging = false;
        bubble.setPointerCapture(event.pointerId);
        const sx = event.clientX, sy = event.clientY, ox = bubble.offsetLeft, oy = bubble.offsetTop;
        const move = (e) => {
            if (Math.abs(e.clientX - sx) + Math.abs(e.clientY - sy) > 5) dragging = true;
            bubble.style.left = `${Math.max(0, ox + e.clientX - sx)}px`;
            bubble.style.top = `${Math.max(0, oy + e.clientY - sy)}px`;
        };
        const up = () => {
            settings().bubbleX = bubble.offsetLeft;
            settings().bubbleY = bubble.offsetTop;
            save();
            bubble.removeEventListener('pointermove', move);
            bubble.removeEventListener('pointerup', up);
        };
        bubble.addEventListener('pointermove', move);
        bubble.addEventListener('pointerup', up);
    });
    document.body.appendChild(bubble);
}

function placeWindow() {
    const s = settings();
    const maxX = Math.max(8, window.innerWidth - panel.offsetWidth - 8);
    const maxY = Math.max(8, window.innerHeight - panel.offsetHeight - 8);
    if (!Number.isFinite(s.winX)) s.winX = maxX - 8;
    if (!Number.isFinite(s.winY)) s.winY = 72;
    s.winX = Math.min(Math.max(0, s.winX), maxX);
    s.winY = Math.min(Math.max(0, s.winY), maxY);
    panel.style.left = `${s.winX}px`;
    panel.style.top = `${s.winY}px`;
}

function open() { panel.hidden = false; placeWindow(); render(); }
function close() { panel.hidden = true; persistChatSlice(); }

function makePanel() {
    panel = document.createElement('aside');
    panel.id = 'story-director-panel';
    panel.hidden = true;
    panel.innerHTML = `
        <div class="sd-head">
            <span class="sd-title">故事导演</span>
            <nav class="sd-tabs">
                ${TABS.map(([key, label]) => `<button type="button" class="sd-tab" data-tab="${key}">${esc(label)}</button>`).join('')}
            </nav>
            <button type="button" class="sd-close" title="关闭">✕</button>
        </div>
        <div class="sd-body">
            <section class="sd-page sd-now-tab" data-tab="now"></section>
            <section class="sd-page sd-epic-tab" data-tab="epic" hidden></section>
            <section class="sd-page sd-main-tab" data-tab="main" hidden></section>
            <section class="sd-page sd-interlude-tab" data-tab="interlude" hidden></section>
            <section class="sd-page sd-side-tab" data-tab="side" hidden></section>
            <section class="sd-page sd-set-tab" data-tab="set" hidden></section>
        </div>`;
    panel.querySelector('.sd-close').onclick = close;
    panel.querySelectorAll('.sd-tab').forEach((button) => {
        button.addEventListener('click', () => { settings().tab = button.dataset.tab; save(); renderTabs(); });
    });
    const head = panel.querySelector('.sd-head');
    head.addEventListener('pointerdown', (event) => {
        if (event.target.closest('button')) return;
        head.setPointerCapture(event.pointerId);
        const sx = event.clientX, sy = event.clientY, ox = panel.offsetLeft, oy = panel.offsetTop;
        const move = (e) => {
            const x = Math.max(0, ox + e.clientX - sx);
            const y = Math.max(0, oy + e.clientY - sy);
            panel.style.left = `${x}px`;
            panel.style.top = `${y}px`;
            settings().winX = x;
            settings().winY = y;
        };
        const up = () => {
            save();
            head.removeEventListener('pointermove', move);
            head.removeEventListener('pointerup', up);
        };
        head.addEventListener('pointermove', move);
        head.addEventListener('pointerup', up);
    });
    document.body.appendChild(panel);
}

// 阶段十五：提示条

function toast(message, type = 'info') {
    try {
        if (window.toastr?.[type]) { window.toastr[type](String(message), '故事导演', { timeOut: type === 'error' ? 12000 : 6000 }); return; }
        if (window.toastr?.info) { window.toastr.info(String(message), '故事导演'); return; }
    } catch { /* ignore */ }
    console.info(`[故事导演] ${message}`);
}

// 阶段十六：启动

function init() {
    if (!settings().enabled || document.getElementById('story-director-bubble')) return;
    if (!document.body) { window.setTimeout(init, 500); return; }
    makeBubble();
    makePanel();
    exposeDiagnostics();
    connectOracle();
    bindVariableInterception();
    bindDirectorSignals();
    syncMainInjection();
    void resolveMvu().then(async () => {
        // 缺失 → 装一份；已经装了但**版本旧了** → 按版本标记自动更新（先备份旧内容）。
        if (settings().autoInstallBook || settings().autoUpdateBook) {
            void installBundledWorldbook({
                notify: true,
                ifMissing: !!settings().autoInstallBook,
                ifOlderVersion: !!settings().autoUpdateBook,
            });
        }
        await ensureNamespace();
        syncMainInjection();
        if (!panel.hidden) render();
        void evaluateDirector();
        window.setTimeout(() => cleanupStatusEchoInChat({ notify: true }), 2500);
    });
    try {
        eventSource?.on?.(event_types.CHAT_CHANGED, () => {
            // ⚠ 这里**不要**重置 s.run：settings() 内部的 ensureChatSlice 刚刚把本聊天的游标
            //（focusBeat / beatAt / threadAt / interludeAt / redesigns）恢复到顶层，覆盖掉它就等于
            // 每次切聊天都清零节奏，下一次心跳会立刻补发支线 + 插曲（两次真实模型调用）。
            const s = settings();
            if (s.run.chatId !== chatKey()) { s.run.chatId = chatKey(); save(); }
            void ensureNamespace();
            window.setTimeout(() => { void evaluateDirector(); }, AFTER_MVU_DELAY);
            window.setTimeout(() => cleanupStatusEchoInChat({ notify: true }), 2500);
            if (!panel.hidden) render();
        });
        eventSource?.on?.(event_types.WORLDINFO_SETTINGS_UPDATED, () => { if (!panel.hidden) renderDiagnostics(); });
    } catch (error) { console.debug('[故事导演] event binding unavailable', error); }
    window.setTimeout(() => { if (!document.getElementById('story-director-bubble')) init(); }, 1500);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
else init();
