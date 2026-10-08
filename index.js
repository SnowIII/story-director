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
    EPIC, EP, emptyEpic, epicOf, epicStarted, migrateEpicKeys, epicChapters, epicMovements, epicClimax,
    epicChapterCount, epicFinished, epicHooks, epicChapter, renderEpicSection, epicFromBlock, epicAskText, userAskText,
    critiqueText,
    TONES, toneOf, toneOptions, toneDirective,
    KEY_BEAT, KEY_BEAT_DONE, KEY_CHAPTER_DONE, KEY_READY, KEY_REVIEW, KEY_REVIEW_NOTE,
    REVIEW_PASS, REVIEW_STATES, REVIEW_MAX_RETRY,
    STATUS_PENDING, STATUS_ACTIVE, STATUS_DONE, STATUS_SKIPPED, STATUS_STALLED,
    isPlainObject, unwrap, unwrapDeep, display, toNumber, truthy,
    reviewLadder, STRIKES_BEFORE_EPIC, nsHasState, beatRollbackTarget, reviewAction, REVIEW_SETUP,
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
/**
 * 插件版本 —— **只用于显示**（真正的版本号在 `manifest.json`，酒馆按它判断有没有更新）。
 * ⚠ 改 manifest 的版本号时这里也要跟着改：`probe-about` 钉住了两者一致。
 */
const VERSION = '0.27.8';

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
 * ★ 合理性审查的升级梯（见 handleBeatReview / model.js 的 `reviewLadder`）。
 *
 * 原则是用户定的（原话）：
 *   「如果正文合理性审查，返回当前主线提示词不合适，则重新生成拍；
 *     若三次在同一章节的主线收到不合适信号，才重整篇章。」
 *
 * 所以只有两级、只改两种东西：
 *   · 第 1、2 次 → **重排还没演的拍**（已演的一字不动，篇章一个字不动）；
 *   · 第 3 次（同一章累计）→ **改篇章还没写的章** + 重排剩下的拍；
 *     并且**同一章最多改一次篇章**（否则会「改完又报、报了又改」，无限改大纲）。
 *
 * ⚠ 次数**不做成设置**：3 次是原则本身。以前那个 `redesignMax` 旋钮已删，
 *   因为它能让人把梯子调成「报一次就改大纲」（太敏感）或「永远不改」。
 */

/** 注入的状态块标签：被模型抄进正文时按它做确定性剥离。 */
const STATUS_TAG = 'story_director_status';

/** 主线那一节的键名（`故事导演.主线`）。 */
const MAIN_SECTION = '主线';

/**
 * ★ MVU 里到底留哪几个字段 —— 这是**唯一**要跟世界书对齐的清单。
 *
 * 分工见 `storyNs` 上方那段说明：MVU 只放「模型要写/要看」的 token，计划住在插件里。
 *   · `TOKEN_PULL` —— **模型写**的那些（进度信号），每轮从 MVU 抄进剧情状态；
 *   · `TOKEN_PUSH` —— 我们往 MVU 写的那些（比 PULL 多两个：当前拍、幕开关、已收尾）。
 * 名字都取自 model.js 的常量，免得两处各写一遍中文字符串。
 */
const TOKEN_PULL = [
    `${MAIN_SECTION}.${KEY_BEAT_DONE}`,
    `${MAIN_SECTION}.${KEY_CHAPTER_DONE}`,
    `${MAIN_SECTION}.${KEY_READY}`,
    `${MAIN_SECTION}.${KEY_REVIEW}`,
    `${MAIN_SECTION}.${KEY_REVIEW_NOTE}`,
    `${INTERLUDE}.${IL.beatDone}`,
    `${INTERLUDE}.${IL.done}`,
    `${INTERLUDE}.${IL.ready}`,
];
// ⚠ `当前拍` **只推不拉**：换拍节奏归插件（受 minReplies 控制）。模型自己把拍号加一
//   就等于绕过刹车 —— 用户报的「推得太快」有一半是这条路（见 CHANGELOG 0.26.1）。
const TOKEN_PUSH = [
    ...TOKEN_PULL,
    `${MAIN_SECTION}.${KEY_BEAT}`,
    `${MAIN_SECTION}.${MAIN_CLOSED}`,
    `${INTERLUDE}.${IL.active}`,
];

/** 按 `a.b.c` 取值 / 写值（token 清单用点号路径，短且好读）。 */
function getPath(node, path) {
    let cur = node;
    for (const key of String(path).split('.')) {
        if (!isPlainObject(cur)) return undefined;
        cur = cur[key];
    }
    return cur === undefined ? undefined : unwrap(cur);
}
function setPath(node, path, value) {
    const keys = String(path).split('.');
    let cur = node;
    for (const key of keys.slice(0, -1)) {
        if (!isPlainObject(cur[key])) cur[key] = {};
        cur = cur[key];
    }
    cur[keys[keys.length - 1]] = value;
}

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
    /**
     * 一拍至少演多少轮才允许换拍（防连跳）。
     * ★ 0.27.2：默认从 2 提到 **3** —— 单拍至少留出三轮，给 {{user}} 真正的回应与后果展开空间。
     *   1 等于没有刹车；想更慢就继续调大。
     *   想更慢就调到 4；这是**换拍刹车**，模型自己改拍号已经不算数（见 TOKEN_PULL 的注释）。
     */
    minReplies: 3,
    /** 两次「重排剩下的拍」之间至少隔几轮（防连着重生成，烧 token 也把剧情搅乱）。 */
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
     * 一个**篇章**（一部完整的大故事）由几章组成。
     * 篇章的章表就是这个长度；写满这些章，这一部就收尾、换新的一部。
     */
    chaptersPerEpic: 4,
    /**
     * 篇章：先定一部**围绕 {{user}}** 的大故事（由若干章组成，每章自己闭环），
     * 再由主线把每一章细化成拍 —— 主线不平淡的关键。
     * autoEpic=true 时会在开第一章之前自动定篇章。
     *
     * ⚠ **篇章只由两件事动**（0.25.0 起的硬规矩，见 CHANGELOG 0.25.0）：
     *   · 正文模型在同一章里**累计三次**报「当前主线不合适」→ 改掉还没写的章（`reviewLadder`）；
     *   · 用户自己点「重新定篇章（换一部）」「按现在的情况重新校准」。
     * 原来还有一个「每开新章前自动校准」的开关（`evolveEpic`）—— 它的触发条件自相矛盾，
     * **从来没生效过**；而一旦按字面修好，就会变成「每换一章就改一次大纲」，
     * 正是「推了一下剧情篇章大纲就自己变了」。所以直接删掉，不给第三种改法。
     */
    autoEpic: true,
    /**
     * ★ **每章演完后检查一次篇章**（0.27.0，用户提的）。
     *
     * 「一章完美结束了之后，是不是应该加一个篇章检查任务呢？不像之前的任务是重新生成篇章 ——
     *   已经有完成的章节了，只是检测，看看事情现在的发展，适当调整之后的发展。」
     *
     * 所以它和「重新定篇章」「重新校准」都不一样：**先判断，默认不动**；只有真的走不通的那几章才改。
     * 时机利用**间章**那几轮（旧章刚完、新章还不该立刻衔接），不占主线的等待；不走间章时在开下一章前做。
     * 成本：**一部一次/章**。
     */
    auditEpic: true,
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
    /**
     * ★ 总开关关掉时，**顺手把自带世界书从全局挂载里摘掉**（0.27.7，用户提的）。
     *
     * 为什么：关掉总开关的意思是「别再影响我的聊天了」—— 但世界书是**酒馆**在注入，
     * 不归插件管：插件停了，那本契约还在每一轮往上下文里塞「你会收到幕后演出计划」。
     * 于是关掉之后聊天反而更别扭（模型在等一个永远不来的计划）。
     *
     * `bookMountedBySwitch` 记的是**「是这次关开关把它摘掉的」** ——
     * 只有这一种情况才在开回来时自动挂回去：你本来就没挂，或者你自己摘的，都不动它。
     */
    bookUnmountOnOff: true,
    /** 内部记账：上次关总开关时，是我们把世界书摘下来的吗？（见 bookUnmountOnOff） */
    bookMountedBySwitch: false,

    /** 运行游标（每个聊天一份切片，随聊天切换）。 */
    run: {
        chatId: '',
        /**
         * ★ **就位基准**：插件开始管这个聊天时的 AI 回复数。
         *
         * 为什么非要有它（0.24.0 的真事故）：所有「聊满 N 轮才动手」的判断原来都直接拿
         * `aiMessageCount()` 去比 —— 那是**整个聊天的历史**。于是切进任何一个老聊天
         * （几百楼），「聊满 2 轮」立刻成立 → 先烧一次神谕定篇章，再烧一次开第一章。
         * 用户报的正是这个：「一切到别的聊天先生了个总纲，造成不必要的浪费」。
         *
         * 现在一律算 `count - armedAt`：**从插件接管这个聊天的那一刻起**才数轮数。
         * 什么时候（重新）就位 —— `armedAt = 当时的回复数`：
         *   · 插件第一次见到这个聊天（切片新建，见 ensureChatSlice）；
         *   · 老存档 / 老切片还没播过基准（见 evaluateDirector）；
         *   · 用户把总开关从关拨到开（见 toggleMaster）。
         */
        armedAt: null,
        /**
         * 当前是哪种「幕」：'main' = 主线章，'interlude' = 间章。
         * ⚠ 真正的判据是 MVU 里的 `间章.进行中`（见 currentMode()，切换聊天天然正确）；
         * 这里这份只是给人看的 / 老存档兼容，不参与判断。
         */
        mode: 'main',
        /**
         * 插件**上一次聚焦**的拍号。
         * 每次采用一章新主线时重置为 1；拍号只由插件推进，模型不再自己改。
         */
        focusBeat: 0,
        /** 间章独立的拍号基准；每次采用新间章时重置为 1。 */
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
        /** 上一次生成 / 校准篇章时的回复数。 */
        epicAt: 0,
        /** 本聊天里「定篇章 / 校准」已经试过几次：超过上限就放行开章，不让它把整个插件卡住。 */
        epicTries: 0,
        /**
         * 已经作废的篇章（换新的一部时把旧的记进来，只留最近 3 部）。
         * 用途：换新的一部时把「上一部讲过的章表」当**要避开的东西**喂给神谕 ——
         * 补一次真事故：重新生成章纲出来的四章和上一版几乎一字不差。
         * @type {Array<{title: string, chapters: string[]}>}
         */
        retiredEpics: [],
        /**
         * ★ **当前这一章的身份**：真开出一章时播下（= 开章那一轮的回复数），重排剩下的拍**不动它**。
         *
         * 为什么不能拿章名当身份（0.25.0 修的真事故）：审查升级梯原来用「章名」判断「是不是同一章」——
         *   章名一变就清零（额度永远攒不满）、两章重名就**跨章累积**（不同章的各报一次也会去改篇章）。
         *   而且①级重排本来就会重新生成整章，章名随时可能被改。
         */
        chapterId: '',
        /**
         * ★ 合理性审查升级梯的记账（见 handleBeatReview 与 reviewLadder）：
         *   reviewStrikes    —— 这一章**累计**收到过几次「当前主线不合适」（攒够 3 次才允许动篇章）；
         *   reviewStrikesFor —— 上面那个计数是**哪一章**的（换章 / 用户整章重写就归零）；
         *   epicRewroteFor   —— 这一章已经动过篇章了 → 之后只重排，**同一章最多动一次篇章**；
         *   redesignAt       —— 上一次重排的轮数（节流用；回退聊天后由 repairRunCursors 兜住）。
         */
        reviewStrikes: 0,
        reviewStrikesFor: '',
        epicRewroteFor: '',
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
        /**
         * 上一次心跳时的 AI 回复数 —— 用来检测**回退**（删楼 / 回退一层）。
         * 只有「回复数变少」才可能把这一拍的进度退回去（见 syncBeatBackOnRollback）。
         */
        lastCount: 0,
        /**
         * ★ 一次性的注入备注（0.27.0，用户提的「缓插 / 先铺垫再插」）：
         *   · `setupNote` —— 正文模型报了 `缺铺垫`，它说缺哪一步；这一拍**按住**，直到补完（换拍/换章时清掉）；
         *   · `beatNote`  —— 正文模型报了 `调整`（自己按趋势改了执行方式）；回它一句边界，下一轮就清掉。
         * 两者都**不花神谕**：模型自己能消化的事，不该为它烧一次调用。
         */
        setupNote: '',
        beatNote: '',
        /** 已经为哪一章做过「篇章检查」（键 = closedChapter，换章即失效）。 */
        auditedFor: '',
        /** 上一次篇章检查的结论（面板上留个可见的记录）。 */
        lastAudit: null,
    },
    chapters: {},
    /** 已经报过一次的信息性提示（见 toastOnce）—— 免得每次刷新都弹同一句。 */
    toldOnce: {},
    /**
     * ★ **这一局的剧情状态**（每聊天一份）：`故事导演` 整棵树 —— 篇章 / 章表 / 大高潮 /
     * 主线（标题·篇章·范围·章目标·拍）/ 支线 / 插曲 / 章节史。
     *
     * 0.26.0 起**计划住在插件里**（用户定的分工）：MVU 只留「第几拍 + 各标记 + 审查结论」
     * 那几个 token，因为那些要**模型自己写**。这样换卡 / `[InitVar]` 重跑 / 某些卡每楼重置
     * 变量，最多丢一次进度信号，**不可能再弄丢一部篇章** —— 也就不存在
     * 「MVU 空了要不要恢复进去」这个问题了。
     *
     * 老存档（计划整棵住在 MVU 里）会在第一次读的时候被**搬进来**（见 importStoryFromMvu）。
     */
    story: {},
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

/** 这份切片还没播过就位基准？（老存档 / 老版本留下的切片） */
function needsArming(rt = settings().run) {
    const at = rt?.armedAt;
    return at === null || at === undefined || at === '' || !Number.isFinite(Number(at));
}

/**
 * ★ 「这个聊天从插件接管算起，聊了几轮」（见 `run.armedAt`）。
 *
 * 所有**自动开篇类**的判断都必须用它，不许直接拿 `aiMessageCount()` ——
 * 后者是整个聊天的历史，切进一个几百楼的老聊天时「聊满 2 轮」会立刻成立，
 * 于是白烧一次定篇章 + 一次开章。
 *
 * 还没播过基准（老存档）→ 回 0：等于「刚刚就位」，先别动手；
 * evaluateDirector 会顺手把基准补上，所以最多只多等一两轮。
 */
function roundsSinceArmed(rt = settings().run) {
    if (needsArming(rt)) return 0;
    return Math.max(0, aiMessageCount() - Math.round(Number(rt.armedAt)));
}

/** 播下 / 重播「就位基准」—— 等于宣布「从现在起重新数轮数」（见 `run.armedAt`）。 */
function armNow(rt = settings().run) {
    if (!isPlainObject(rt)) return;
    rt.armedAt = aiMessageCount();
}

/**
 * 每份「随聊天走」的插件状态：运行游标 + 章节史 + **命名空间镜像**（跨刷新不丢、绝不串台）。
 * 模型侧的剧情状态住在 MVU 里，这里只放插件自己的记账与备份。
 */
const CHAT_SLICE_KEYS = ['run', 'chapters', 'story'];

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
    if (!isPlainObject(s.story)) s.story = {};
}

function ensureChatSlice(s) {
    const key = chatKey();
    if (!key) return false;
    if (s.chatSliceKey === key) return false;
    if (!isPlainObject(s.chats)) s.chats = {};
    if (s.chatSliceKey) s.chats[s.chatSliceKey] = sliceFromSettings(s);
    if (!isPlainObject(s.chats[key])) {
        s.chats[key] = JSON.parse(JSON.stringify({ run: DEFAULT.run, chapters: {}, story: {} }));
        // ★ 第一次见到这个聊天 → 立刻播下「就位基准」（见 run.armedAt）：
        //   所有「聊满 N 轮才动手」都从这一刻算起，而不是拿整个聊天的历史条数。
        armNow(s.chats[key].run);
    }
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

/**
 * ★ MVU 里那棵小树（**只放模型自己要写的那几个 token**）。
 *
 * 用户定的分工（原话）：「mvu 里面有执行到第几拍的数字不就行了，我一开始的设计
 * 不就是只负责让正文变量模型返回当前拍是否执行的 token」—— 对。剧情计划（篇章 / 章表 /
 * 拍 / 支线 / 插曲 / 章节史）**住在插件里**（见 `storyNs`），MVU 只是模型回报进度的通道。
 *
 * 这个读法仍然会「当前楼层读不到就退回聊天级」：有的卡每开一楼就从聊天级基准重起变量。
 */
function mvuData() {
    const api = mvu();
    if (!api?.getMvuData) return null;
    let here = null;
    try { here = api.getMvuData({ type: 'message', message_id: 'latest' }) || null; } catch { /* ignore */ }
    if (isPlainObject(here?.stat_data?.[NS])) return here;
    let whole = null;
    try { whole = api.getMvuData({ type: 'chat' }) || null; } catch { /* ignore */ }
    if (isPlainObject(whole?.stat_data?.[NS])) {
        console.debug('[故事导演] 当前楼层的变量还是空的 —— 退回聊天级那份（见 mvuData 的说明）。');
        return whole;
    }
    return here || whole;
}

// ───────────────── 剧情状态：住在插件里 ─────────────────
//
// 0.26.0 的分工（用户定的）：
//   · **计划**（史诗 / 主线的标题·篇章·范围·章目标·拍 / 支线 / 插曲 / 章节史）→ 插件设置，
//     每聊天一份（`story`，见 CHAT_SLICE_KEYS），跨刷新不丢；
//   · **MVU**：只留「第几拍 + 各标记 + 审查结论」这几个 token，因为那些要**模型自己写**。
// 于是换卡 / InitVar 重跑 / 某些卡每楼重置变量，最多丢一次「拍落到没落」的信号，
// **不可能再弄丢一部篇章** —— 也就不存在「MVU 空了要不要恢复进去」这个问题。

/** 这一局的剧情状态（插件的，不是 MVU 的）。 */
function storyNs() {
    const s = settings();
    if (!isPlainObject(s.story)) s.story = {};
    return s.story;
}

function saveStory() {
    const s = settings();
    migrateEpicKeys(s.story);
    save();
}

/**
 * MVU 里只该剩 token —— 把计划字段清掉。
 * 老存档把计划搬进插件之后跑一次：否则变量面板与模型快照里还挂着一份**再也不更新**的旧计划。
 */
async function pruneMvuToTokens() {
    const api = mvu();
    if (!api?.replaceMvuData) return false;
    const d = mvuData();
    if (!isPlainObject(d?.stat_data)) return false;
    const ns = d.stat_data[NS];
    if (!isPlainObject(ns)) return false;
    const kept = {};
    for (const path of TOKEN_PUSH) {
        const value = getPath(ns, path);
        if (value !== undefined) setPath(kept, path, value);
    }
    if (stableJson(kept) === stableJson(ns)) return false;
    d.stat_data[NS] = kept;
    console.info('[故事导演] MVU 里那份计划已清掉（0.26.0 起它住在插件里，MVU 只留回报 token）。');
    return writeMvu(d);
}

/**
 * 老存档 / 首次升级：剧情状态原来整棵住在 MVU 里 → **搬进插件**（只搬一次）。
 * 之后 MVU 里那些计划字段不再维护（顺手清掉），插件只往 MVU 写 token。
 */
function importStoryFromMvu() {
    if (nsHasState(storyNs())) return false;
    const ns = mvuData()?.stat_data?.[NS];
    if (!nsHasState(ns)) return false;
    try {
        const s = settings();
        s.story = JSON.parse(JSON.stringify(ns));
        migrateEpicKeys(s.story);
        save();
        console.info('[故事导演] 已把这局的剧情状态从 MVU 搬进插件（0.26.0 起计划由插件保管，MVU 只留回报 token）。');
        void pruneMvuToTokens();
        return true;
    } catch (error) {
        console.debug('[故事导演] 从 MVU 搬迁剧情状态失败', error);
        return false;
    }
}

/**
 * 支线 / 插曲：**计划归插件，但「落了没」是模型回报的**。
 *
 * 所以这两个动态集合不走 TOKEN_PULL 的点号路径，单独抄一下「已落 / 状态」——
 * 标题、目标、落点那些**不抄**（那是插件与神谕定的，模型改了也不算）。
 */
function pullEntryFlags(live = null) {
    const src = (live && isPlainObject(live.stat_data) ? live.stat_data : mvuData()?.stat_data)?.[NS];
    if (!isPlainObject(src)) return false;
    const story = storyNs();
    let changed = false;
    for (const kind of ['支线', '插曲']) {
        const from = isPlainObject(src[kind]) ? src[kind] : null;
        if (!from) continue;
        const to = isPlainObject(story[kind]) ? story[kind] : (story[kind] = {});
        for (const [id, box] of Object.entries(from)) {
            if (id.startsWith('$') || !isPlainObject(box)) continue;
            if (!isPlainObject(to[id])) continue;          // 插件里没有这条 → 不管（计划归插件）
            for (const key of ['已落', '状态']) {
                if (box[key] === undefined) continue;
                if (stableJson(to[id][key]) === stableJson(box[key])) continue;
                to[id][key] = box[key];
                changed = true;
            }
        }
    }
    return changed;
}

/** 把 MVU 里模型写的 token 抄进剧情状态（模型刚回报的进度信号）。 */
function pullTokens(live = null) {
    const root = live && isPlainObject(live.stat_data) ? live.stat_data : mvuData()?.stat_data;
    const ns = root?.[NS];
    if (!isPlainObject(ns)) return false;
    const story = storyNs();
    let changed = false;
    for (const path of TOKEN_PULL) {
        const value = getPath(ns, path);
        if (value === undefined) continue;
        if (stableJson(getPath(story, path)) === stableJson(value)) continue;
        setPath(story, path, value);
        changed = true;
    }
    if (pullEntryFlags(live)) changed = true;
    if (changed) save();
    return changed;
}

/**
 * 把剧情状态里的 token 写进 MVU（模型下一轮看得到第几拍，也看得到被复位过的标记）。
 *
 * ⚠ **一样就不写**。这不是省事：我们写 MVU 会让 MVU 发一次「变量更新完」，
 * 那个事件又回头调 `ensureNamespace` —— 无条件写就变成「写 → 事件 → 又写」的回声。
 * 比较一下再写，回声在第一圈就断掉了。
 */
async function pushTokens() {
    const api = mvu();
    if (!api?.replaceMvuData) return false;
    const d = mvuData();
    if (!isPlainObject(d?.stat_data)) return false;
    if (!isPlainObject(d.stat_data[NS])) d.stat_data[NS] = {};
    const ns = d.stat_data[NS];
    const story = storyNs();
    let changed = false;
    for (const path of TOKEN_PUSH) {
        const want = getPath(story, path);
        if (want === undefined) continue;
        if (stableJson(getPath(ns, path)) === stableJson(want)) continue;
        setPath(ns, path, isPlainObject(want) || Array.isArray(want) ? JSON.parse(JSON.stringify(want)) : want);
        changed = true;
    }
    if (!changed) return false;
    return writeMvu(d);
}

/**
 * ★ 写 MVU：**两个存放位置都写**（当前楼层 + 聊天级）。
 *
 * 只写当前楼层时，这个 token 能不能活到下一楼全看 MVU 会不会把这一楼合并回聊天级 ——
 * 有的卡不会（见 `mvuData` 的说明）。两处同写之后，下一楼从哪一份起都读得到。
 * `d` 就是 `mvuData()` 给的那份（含 `stat_data`）。
 */
async function writeMvu(d) {
    const api = mvu();
    if (!api?.replaceMvuData || !isPlainObject(d?.stat_data)) return false;
    let ok = false;
    try {
        await api.replaceMvuData(d, { type: 'message', message_id: 'latest' });
        ok = true;
    } catch (error) { console.debug('[故事导演] 写入当前楼层失败', error); }
    try {
        const whole = api.getMvuData ? api.getMvuData({ type: 'chat' }) : null;
        if (isPlainObject(whole)) {
            if (!isPlainObject(whole.stat_data)) whole.stat_data = {};
            whole.stat_data[NS] = d.stat_data[NS];
            await api.replaceMvuData(whole, { type: 'chat' });
            ok = true;
        }
    } catch (error) { console.debug('[故事导演] 写入聊天级失败', error); }
    return ok;
}

/**
 * 取这一局的**根**（形状与 MVU 的 `stat_data` 一样：`root[NS]` 才是我们的命名空间）。
 *
 * `live` 传 MVU 事件回调里那份**刚被模型改过**的 token —— 顺手抄进剧情状态。
 * ⚠ 计划不再从 MVU 读 —— MVU 只提供 token（见文件上方那一大段分工说明）。
 */
function rootOf(live = null) {
    importStoryFromMvu();
    if (live && isPlainObject(live.stat_data)) pullTokens(live);
    return { [NS]: storyNs() };
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

/**
 * ★ 写剧情状态：计划住在插件里 —— 改 `story` → 存盘 → 把 token 推给 MVU。
 * 所有 `patchX` 都走它，「计划写哪、token 怎么写」只有这一处定义。
 */
async function writeStory(apply) {
    const root = { [NS]: storyNs() };
    apply(root);
    saveStory();
    await pushTokens();
    return true;
}

/** 写 `故事导演.间章.*`。⚠ `_opts` 只是兼容几十个老调用点：计划不再写 MVU（见 writeStory）。 */
async function patchInterlude(fields, _opts = {}) {
    return writeStory((root) => {
        if (!isPlainObject(root[NS])) root[NS] = {};
        if (!isPlainObject(root[NS][INTERLUDE])) root[NS][INTERLUDE] = emptyInterlude();
        Object.assign(root[NS][INTERLUDE], fields);
        if (Array.isArray(fields[IL.beats])) root[NS][INTERLUDE][IL.beats] = fields[IL.beats].slice();
    });
}

/** 同步「间章时段之外不许写间章变量」这个开关（模型只能在自己那段幕里动它）。 */
function syncInterludeWrites() {
    setInterludeWritesAllowed(currentMode() === 'interlude');
}

// ---- 史诗 / 篇章（围绕 {{user}} 的那条长线）----

/** 写 `故事导演.史诗.*`（计划住在插件里，见 writeStory）。 */
async function patchEpic(fields, _opts = {}) {
    return writeStory((root) => {
        if (!isPlainObject(root[NS])) root[NS] = {};
        if (!isPlainObject(root[NS][EPIC])) root[NS][EPIC] = emptyEpic();
        Object.assign(root[NS][EPIC], fields);
        for (const key of [EP.chapters, EP.hooks]) {
            if (Array.isArray(fields[key])) root[NS][EPIC][key] = fields[key].slice();
        }
    });
}

/** 一个篇章排几章（用户可在「设定」里改；1~12 之间夹一下，默认 4）。 */
function chaptersPerEpic() {
    const s = settings();
    return Math.max(1, Math.min(12, Math.round(toNumber(s.chaptersPerEpic, 4))));
}

/** 采用一份篇章。 */
/** 采用一份篇章。`entry` 传数字才会改「这一册写到第几章」（null = 不动，校准走这条）。 */
async function applyEpic(epic, { live = null, quiet = false, entry = null } = {}) {
    const fields = { ...epic };
    if (entry !== null && entry !== undefined) fields[EP.chapter] = Math.max(0, Math.round(Number(entry) || 0));
    else delete fields[EP.chapter];      // 校准：进度由「写完一章就 +1」维护，不要被回复里的旧数字覆盖
    await patchEpic(fields, { live });
    const s = settings();
    // ★ 0.27.8：**换新的一部时，把上一部留下的那一章从主线那一栏清掉**。
    //   为什么非清不可：主线栏里永远躺着「当前这一章」（收尾不会清掉它的拍），
    //   而「开第一章」的闸门是 `!beats.length` —— 不清的话新篇章的第一章**永远开不出来**，
    //   屏幕上还挂着上一部最后一章的标题与拍列表。
    if (entry !== null && entry !== undefined) {
        await patchMain({ ...emptyMain(), [MAIN_CLOSED]: false }, { live });
        console.info('[故事导演] 换了新的一部：主线那一栏已清空，下一次心跳会开这一部的第 1 章。');
    }
    s.run.epicAt = aiMessageCount();
    // 冷却基准**只在生成成功之后**才写：失败不该消耗节流名额（否则后面开章会被挡住）
    markGenerated(s.run, s.run.epicAt);
    s.run.epicTries = 0;                 // 成功即清零：下次还需要校准就重新给机会
    clearPending(`epic:${chatKey()}`);
    save();
    syncMainInjection();
    if (!panel?.hidden) render();
    if (!quiet) {
        const title = String(unwrap(fields[EP.title]) ?? '未命名');
        const total = epicChapterCount(fields);
        // ⚠ 提示里**不许带大高潮**（用户提的：那是剧透）。想知道/想改就去「篇章」页点开看。
        toast(entry !== null && entry > 0
            ? `篇章《${title}》已按他实际做的事重新校准（共 ${total} 章）。`
            : `篇章已定：《${title}》（共 ${total} 章）。`, 'success');
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

/** 键顺序无关的序列化（用来判断两份命名空间是否真的一样）。 */
function stableJson(value) {
    return JSON.stringify(value, (key, item) => (isPlainObject(item)
        ? Object.fromEntries(Object.keys(item).sort().map((k) => [k, item[k]]))
        : item));
}

/**
 * ★ 把「手上这一份」变量**对齐到聊天级**（内容不一样才写）。
 *
 * 为什么要对齐（0.25.1 修的真事故）：有的卡不会把当前楼层的变量更新合并回聊天级基准，
 * 而插件原来只写当前楼层 —— 聊天级基准一直是空的。于是下一楼从基准起一份空变量，
 * 插件又「读不到篇章」→ 再定一部 → 再丢…… 用户看到的就是
 * 「刚生成好一个篇章，推进一步又重新生成了」。
 *
 * `writeMvu` 负责让每次写入都落两处；这个函数负责在**读**的时候把已经偏掉的对齐回来
 * （老聊天只要开一次插件就修好了）。两边一样时不写。
 */
async function syncNsToChat(live = null) {
    const api = mvu();
    if (!api?.getMvuData || !api?.replaceMvuData) return false;
    try {
        const source = (live && isPlainObject(live.stat_data)) ? live.stat_data : mvuData()?.stat_data;
        const ns = source?.[NS];
        if (!isPlainObject(ns)) return false;
        const whole = api.getMvuData({ type: 'chat' });
        if (!isPlainObject(whole)) return false;
        if (stableJson(whole.stat_data?.[NS]) === stableJson(ns)) return false;
        if (!isPlainObject(whole.stat_data)) whole.stat_data = {};
        whole.stat_data[NS] = ns;
        await api.replaceMvuData(whole, { type: 'chat' });
        console.debug('[故事导演] 聊天级变量已对齐（有的卡不会自己把楼层更新合并回去）。');
        return true;
    } catch (error) {
        console.debug('[故事导演] 对齐聊天级变量失败', error);
        return false;
    }
}

/**
 * 剧情状态自愈：保证 `story` 这棵树的结构完整（老存档缺字段就补齐）。
 *
 * ⚠ 0.26.0 起这里**不再往 MVU 写计划** —— 计划住在插件里（见 story 的说明），
 *   MVU 只拿 token。所以这个函数只做两件事：
 *   · 第一次读时把老存档（计划整棵在 MVU 里）**搬进来**；
 *   · 补齐结构，然后把 token 推给 MVU（模型那一轮才知道第几拍、以及我们复位过的标记）。
 */
async function ensureNamespace({ notify = false, live = null } = {}) {
    const api = mvu();
    // ★ **先看有没有回退**（删楼 / 回退一层），而且必须在**任何写 MVU 之前**：
    //   否则我们会先把手里的旧进度推回去，把「快照里那个更早的进度」覆盖掉，就再也退不回来了
    //   （真踩过：先 pushTokens 再检查，快照已经被我们改成新值）。
    syncBeatBackOnRollback(aiMessageCount());
    if (!live && !api?.replaceMvuData && !api?.getMvuData) {
        if (notify) toast('MVU 未加载，无法初始化变量。', 'warning');
        return false;
    }
    // ★ 顺手把聊天级那一份对齐（见 syncNsToChat）：有的卡不会自己把楼层更新合并回去。
    void syncNsToChat(live);
    importStoryFromMvu();
    if (live) pullTokens(live);
    const ns = storyNs();
    let changed = false;

    if (!isPlainObject(ns[MAIN_SECTION])) { ns[MAIN_SECTION] = emptyMain(); changed = true; }
    else {
        const main = ns[MAIN_SECTION];
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
    // 篇章：一部完整的大故事（由章表里的若干章组成）。老存档里没有就补齐。
    if (!isPlainObject(ns[EPIC])) { ns[EPIC] = emptyEpic(); changed = true; }
    else {
        const box = ns[EPIC];
        // ① 先把**旧键名**真的改掉（总纲→篇章、走向→章内容、清掉已废弃的当前进程/赌注）。
        //    ⚠ 必须排在「补空字段」之前：先补出来的空 `章内容: []` 会让迁移误判成"已经有内容"。
        //    也不能只在读取时兼容 —— 否则变量面板上一直写着旧名字，而变量快照又把它喂回模型（自己喂自己）。
        const migration = migrateEpicKeys(ns);
        if (migration.changed) {
            changed = true;
            const bits = [];
            if (migration.renamedWhat?.length) bits.push(migration.renamedWhat.join('、'));
            if (migration.dropped.length) bits.push(`清掉已废弃的 ${migration.dropped.join('、')}`);
            if (bits.length) console.info(`[故事导演] 老存档的字段名已迁移：${bits.join('；')}`);
        }
        // ② 再补缺、再归一化
        for (const [key, value] of Object.entries(emptyEpic())) {
            if (!(key in box)) { box[key] = value; changed = true; }
        }
        for (const key of [EP.chapters, EP.hooks]) {
            if (!Array.isArray(box[key])) { box[key] = splitBeats(box[key]).slice(0, 24); changed = true; }
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

    if (!changed) { void pushTokens(); return true; }
    void pushTokens();          // 结构补齐后，token 也要让 MVU 那边跟上
    if (notify) toast('故事导演 的剧情状态已就绪。', 'success');
    render();
    return true;
}

/** 写 `故事导演.主线.*`（计划住在插件里，见 writeStory）。 */
async function patchMain(fields, _opts = {}) {
    return writeStory((root) => {
        if (!isPlainObject(root[NS])) root[NS] = {};
        if (!isPlainObject(root[NS][MAIN_SECTION])) root[NS][MAIN_SECTION] = emptyMain();
        Object.assign(root[NS][MAIN_SECTION], fields);
        if (Array.isArray(fields[MAIN_BEATS])) {
            root[NS][MAIN_SECTION][MAIN_BEATS] = fields[MAIN_BEATS].slice();
        }
    });
}

/** 写 `故事导演.<kind>.<id>`（整份对象合并）。 */
async function patchEntry(kind, id, fields, _opts = {}) {
    return writeStory((root) => {
        if (!isPlainObject(root[NS])) root[NS] = {};
        if (!isPlainObject(root[NS][kind])) root[NS][kind] = {};
        const box = root[NS][kind];
        box[id] = isPlainObject(box[id]) ? { ...box[id], ...fields } : { ...fields };
    });
}

/** 直接删一条支线/插曲（AI 不写命令时插件自己收尾用）。 */
async function dropEntry(kind, id, _opts = {}) {
    return writeStory((root) => {
        const box = isPlainObject(root[NS]) && isPlainObject(root[NS][kind]) ? root[NS][kind] : null;
        if (box) delete box[id];
    });
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

        // ★ 这一章写完了 → **篇章进度 +1**（只算主线章；间章走另一个函数，不计入）。
        //   进度是**这一册自己的**：写满章表长度，这一部就收尾、换新的一部。
        const epicBox = isPlainObject(target[NS][EPIC]) ? target[NS][EPIC] : null;
        if (epicBox) {
            const done = Math.max(0, Math.round(toNumber(epicBox[EP.chapter], 0))) + 1;
            epicBox[EP.chapter] = done;
        }
    };
    await writeStory(apply);
    return true;
}

// 阶段五：世界书

const bundledWorldbookUrl = () => new URL('worldbook/story-director.json', import.meta.url).href;
const bundledIconUrl = () => new URL('icon.svg', import.meta.url).href;
/** 作者头像（256×256 的方形小图，见「关于」页）。原图 4 MB，仓库里放的是裁好的小图。 */
const bundledAvatarUrl = () => new URL('avatar.jpg', import.meta.url).href;

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
/**
 * ★ **只报一次**的信息性提示（按 key 记在设置里）。
 *
 * 为什么要它（用户提的）：「已装好世界书 / 已挂载到全局世界书」这类提示每刷新一次就弹一次，
 * 但事情只发生过一次 —— 那是噪音，不是新闻。key 里带上版本号之类的标识，
 * 所以「真的变了」时它还会再报一次。
 */
function toastOnce(key, message, type = 'info') {
    const s = settings();
    if (!isPlainObject(s.toldOnce)) s.toldOnce = {};
    if (s.toldOnce[key]) return false;
    s.toldOnce[key] = Date.now();
    save();
    toast(message, type);
    return true;
}

async function installBundledWorldbook({ notify = true, mount = null, ifMissing = true, ifOlderVersion = false } = {}) {
    if (!(await ensureWorldListLoaded())) {
        if (notify) toast('酒馆的世界书列表还没加载出来——稍等一下再试，或点「刷新列表」。', 'warning');
        return 'unknown';
    }
    const exists = world_names.includes(PLUGIN_WORLD);

    if (exists && ifMissing && !ifOlderVersion) {
        if (notify) toastOnce(`book:exists:${PLUGIN_WORLD}`, `酒馆里已经有世界书「${PLUGIN_WORLD}」了，不用重新安装。`, 'info');
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
            toastOnce(
                `book:updated:${bundled}`,
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
        toastOnce(
            `book:installed:${String(data.srVersion || '')}`,
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
            mainLines = renderMainSection(main, {
                maxBeats: BEAT_MAX, root, banUserAction: ban, focusStale: s.run.focusStale,
                // ★ 0.27.0：模型自己报的「缺铺垫」与「微调」各回它一句（只出现一轮 / 补完为止）。
                setupNote: s.run.setupNote || '',
                beatNote: s.run.beatNote || '',
            }).lines;
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
function focusedStateBlock(task, { replacingEpic = false } = {}) {
    const s = settings();
    const root = rootOf();
    const lines = [];
    const isChapter = task === 'chapter';

    // ── 篇章：这一册是什么故事、写了几章、**这一章该是什么**、还没兑现的伏笔 ──
    const epic = epicOf(root);
    if (epicStarted(epic)) {
        const title = String(unwrap(epic[EP.title]) ?? '').trim();
        const line = String(unwrap(epic[EP.line]) ?? '').trim();
        const ledger = String(unwrap(epic[EP.ledger]) ?? '').trim();
        const hooks = epicHooks(epic);
        const chapters = epicChapters(epic);
        const written = epicChapter(epic);
        const climax = epicClimax(epic);

        // ★ 0.27.8（用户提的）：**已归档的篇章不再作为「这一册的章内容」参与组装**。
        //   「归档」的判据是它已经在上一部名单里（演完了就会被记进去，见 archiveFinishedEpic）。
        //   这里只留一句极短的交代 —— 足够让模型知道「上一部收场了、正在定新的一部」，
        //   而不是继续拿那张章表往下推。想避开旧剧情的重复，由 antiRepeatBlock 负责。
        if (!replacingEpic && epicIsArchived(epic)) {
            lines.push(`【篇章】上一部${title ? `《${title}》` : ''}已经**演义完了**（章表已写满）—— 不要照它的章表继续排。`);
            if (ledger) lines.push(`既成事实：${ledger}`);
            lines.push('');
        } else {
        // ★★ 换新的一部时**绝不能把旧章表当"这一册的章内容"发过去**（补事故）：
        //    以前不管什么任务都把整张章表发下去，于是「重新生成章纲」拿到的就是
        //    「这是你这一册的四章」+「再给我排一次」—— 模型最省力的做法就是把它重抄一遍。
        //    真事故：重新生成出来的四章和上一版几乎一字不差。
        //    现在旧章表改由「防重复」块以**要避开的东西**的身份出现（见 antiRepeatBlock）。
        if (replacingEpic) {
            lines.push(`【篇章】本次是**换新的一部**：上一部${title ? `《${title}》` : ''}已经作废`
                + '（它写过的几章在下面的「防重复」里，是**要避开**的东西，不是要你填的表格）。');
            lines.push('在争什么 / 章表 / 大高潮 请**重新定**，不要照着上一部重写。');
            lines.push('');
            // 旧章表不进这里 —— 但「既成事实」仍要给：新的一部得从现在的处境出发
            if (ledger) lines.push(`既成事实：${ledger}`);
            if (hooks.length) lines.push(`**还没兑现的伏笔**（要埋就得与它们同源，不要另起炉灶）：${hooks.join('；')}`);
            lines.push('');
            // ⚠ 必须和函数正常出口一样**拼成字符串**再返回：collectContextBlocks 是把它当**一整块**塞进去的，
            //   返回数组会被 join(',') 拼成一行（踩过：三条之间冒出逗号）。
            return `=== 当前 ${NS} 状态（已按本次任务裁剪：只给相关的那些）===\n${lines.join('\n')}`;
        }

        lines.push(`【篇章】${title ? `《${title}》` : ''}${chapters.length ? `　共 ${chapters.length} 章，已写到第 ${written} 章` : ''}`);
        if (line) lines.push(`在争什么：${line}`);
        if (climax) lines.push(`大高潮：${climax}`);
        if (chapters.length) {
            // 写章节时**必须标明「这一章」**：神谕要细化的就是 ▶ 那一条，别去写别的章
            lines.push(`章内容（一章一段，${isChapter ? '**你要细化的只有 ▶ 那一条**' : '整册的样子'}）：`);
            for (let i = 0; i < chapters.length; i++) {
                const mark = i + 1 <= written ? '✔' : (i + 1 === written + 1 ? '▶' : '·');
                lines.push(`　${mark} 第 ${i + 1} 章：${chapters[i]}`);
            }
            if (isChapter && written + 1 > chapters.length) lines.push('　（章表已经写完了 —— 这一册该收尾了。）');
        }
        if (hooks.length) lines.push(`**还没兑现的伏笔**（要埋就得与它们同源，不要另起炉灶）：${hooks.join('；')}`);
        if (ledger) lines.push(`既成事实：${ledger}`);
        lines.push('');
        }
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

async function collectContextBlocks(task = 'chapter', taskOpts = {}) {
    const s = settings();
    const blocks = [];

    // ① 我们自己的世界书里**面向剧情**的条目。
    //   ⚠ 0.21.0 起，这本世界书只剩**变量机制**的条目（`[mvu_update]` 变量契约 / 快照 / 输出格式、
    //     `[InitVar]` 初始化）。它们全是**写给叙事者的**（「你不需要自己设计剧情走向，照计划演就行」），
    //     把它当「设计规则来源」喂给篇章设计师，等于一边说「你是设计师」一边说「你不用设计」。
    //     所以这里按标签过滤掉它们：今天过滤完是空的 → 整块不发；以后真加了剧情条目也照样能收到。
    //     设计规则本来就在设计提示词里（`DESIGN_BOTH` / `DESIGN_ARC` / `DESIGN_BEATS` / `DESIGN_SIDE`，
    //     按层发），单一来源，不必靠世界书转发。
    try {
        const ours = await readOurWorldbookEntries();
        const plot = ours.filter((entry) => !/\[mvu_update\]|\[InitVar\]/i.test(String(entry?.comment ?? entry?.name ?? '')));
        const digest = worldbookDigest(plot);
        if (digest) blocks.push(`=== 本插件自带世界书「${PLUGIN_WORLD}」里面向剧情的条目 ===\n${capText(digest, 24000)}`);
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
        const focused = focusedStateBlock(task, taskOpts);
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

/**
 * 已走过的章 + 已用过的标题：喂给神谕做「不要重复」的硬约束。
 *
 * ★ 换新的一部篇章时（`task === 'epic'`），这里还要带上**上一部讲过的章表** ——
 *   这是补一次真事故：用户点「重新生成章纲」，出来的四章和上一版几乎一字不差。
 *   原因之一就是旧章表被当成「你这一册的章内容」发下去了（模型当然照着抄），
 *   而防重复块里**只有章名标题、没有内容**，模型根本不知道"这套因果已经写过了"。
 *   现在旧章表以「**要避开**的东西」的身份出现在这里。
 */
function antiRepeatBlock(task = '') {
    const s = settings();
    const root = rootOf();
    const history = completedMainTitles(root);
    const titles = takenTitles(root);
    const lines = [];
    if (history.length) lines.push(`已经走过的章（不要重演，也不要换个说法再来一遍）：${history.join('、')}`);
    if (titles.length) lines.push(`已经用过的标题（新的标题不要与它们重复或近似）：${titles.join('、')}`);
    if (task === 'epic') {
        const retired = Array.isArray(s.run.retiredEpics) ? s.run.retiredEpics : [];
        for (const old of retired.slice(-2)) {
            const chapters = Array.isArray(old?.chapters) ? old.chapters : [];
            if (!chapters.length) continue;
            lines.push(`=== 上一部篇章《${String(old?.title ?? '').trim() || '（未命名）'}》已经讲过的（**新的一部不许是它的换皮**）===`);
            chapters.forEach((text, i) => lines.push(`　第 ${i + 1} 章：${text}`));
            lines.push('新的一部**必须换一套因果**：起因不同、推动的人不同、代价不同、落点不同；');
            lines.push('连「推进形状」也不能一样（例：如果上一部是「有人接连施压 → 把他逼到绝境 → 用把柄摊牌 → 妥协、失去栖身之所」，这一部就不许再来一遍）。');
        }
    }
    return lines.length ? `=== 防重复 ===\n${lines.join('\n')}` : '';
}

/**
 * 把一部**已经结束**的篇章记进归档名单。
 *
 * 两个调用时机，语义不同（`why`）：
 *   · `finished` —— 章表写满了（这一部**演义完了**）。0.27.8：**在最后一章收尾的那一刻就归档**，
 *     不再等到「新的一部生成成功」才记 —— 否则新篇章生成失败几次，这一部就永远赖在注入里。
 *   · `replaced` —— 被手动/自动换掉（还没写完就不演了）。
 *
 * 归档之后：① 它只作为「**要避开的东西**」进防重复块；② 在「篇章」页的归档区可见；
 * ③ 不再作为「这一册的章内容」参与提示词组装（见 focusedStateBlock）。
 *
 * 幂等：同一部（标题 + 章表都一样）只记一次，重试不会把它堆成好几条。只留最近 5 部。
 */
function rememberRetiredEpic(epic, { why = 'replaced' } = {}) {
    const s = settings();
    const chapters = epicChapters(epic).slice(0, 24);
    const entry = {
        title: String(unwrap(epic?.[EP.title]) ?? '').trim(),
        chapters,
        climax: String(unwrap(epic?.[EP.climax]) ?? '').trim(),
        ledger: String(unwrap(epic?.[EP.ledger]) ?? '').trim(),
        hooks: epicHooks(epic).slice(0, 12),
        written: epicChapter(epic),
        why,
        at: new Date().toISOString(),
    };
    if (!entry.chapters.length) return false;
    const list = Array.isArray(s.run.retiredEpics) ? s.run.retiredEpics : [];
    const same = (a) => JSON.stringify(a?.chapters) === JSON.stringify(entry.chapters) && String(a?.title ?? '') === entry.title;
    if (list.some(same)) return false;
    s.run.retiredEpics = [...list, entry].slice(-5);
    save();
    console.info(`[故事导演] 已归档篇章《${entry.title || '未命名'}》（${why === 'finished' ? '演义完了' : '被换掉'}，共 ${chapters.length} 章）。`);
    return true;
}

/**
 * ★ 0.27.8：这一部**写完了**就立刻归档。
 *
 * 为什么不等「新的一部生成成功」再归档（用户报的那个 bug 的关键）：
 * 完结的篇章如果一直留在盒子里，它就会一直参与提示词组装；而换新篇章的生成**可能失败**
 * （网络 / 解析不出区块），失败时钉子摘不掉 —— 于是「一部演完之后永远不开下一部」。
 */
function archiveFinishedEpic(live = null) {
    const epic = epicOf(rootOf(live));
    if (!epicStarted(epic) || !epicFinished(epic)) return false;
    return rememberRetiredEpic(epic, { why: 'finished' });
}

/** 这一部是不是已经归档过了（归档了就不再当「这一册的章内容」发下去）。 */
function epicIsArchived(epic) {
    const list = Array.isArray(settings().run.retiredEpics) ? settings().run.retiredEpics : [];
    const title = String(unwrap(epic?.[EP.title]) ?? '').trim();
    const chapters = epicChapters(epic);
    return list.some((item) => String(item?.title ?? '') === title && JSON.stringify(item?.chapters) === JSON.stringify(chapters.slice(0, 24)));
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
    '- **不许安排 {{user}} 的行为**（最重要）：不写他做什么、说什么、想什么、决定什么，也不写「等他…之后再…」把剧情挂在他身上 ——',
    '  他的行为只由他自己决定；剧情只靠**世界这边**推进：别人做了什么、环境怎么变、什么消息传到了。',
    '- **每一拍的主语都不是 {{user}}**：写「谁做了什么 → 局面变成什么样」；要让他参与，就把局面摆到他面前，然后停手。',
    '- **不许无中生有**：上下文里出现过的角色、地点、关系、财产、差事都是既成事实 —— 不要凭空增加，也不要改既有角色的属性；',
    '  确实需要新元素时，明说它是**新出现**的，并交代它为什么在这里。',
    '- **不许掀掉 {{user}} 正奔向的东西**：他在往某个方向推（期待某场戏、正在促成某件事）时，后面的章要**沿着它走**；',
    '  不许用突发变故（天降灾变、第三方插手、被人抢先一步）把它当众作废 —— 尤其不许写「**就在…即将…之际，突然…**」，',
    '  那正是取消读者正在等的场面的写法；变局要与它**并存、或在之后**。',
    '- **不许用巧合「救场」**：别为了让角色脱困，就降下一个刚好解围的意外 —— 结果不好也是该有的走向，**不要替角色偷偷改掉它**。',
    '- **以角色卡与世界书为准**，不要替它们另立规则；只设计**走向**，不写台词、不写露骨描写。',
    '- **不要制式化**：连着两章的**场景形状**不许重复（反例：「遇见一个新的人 → 他交代一件事 → 去那个地方办掉」）。',
    '  自问：**这一章和上一章，除了换名字，还有什么不一样？** 答不上来就重想。',
    '',
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

/**
 * ★ 设计规则 —— **只发给故事神谕**，不进正文；而且**按层拆开**，各层只拿自己那一段。
 *
 * 这些内容原来挂在世界书的 `[mvu_plot]` 常驻条目里，于是**每轮都注入正文模型**（6,279 字/轮）。
 * 但它们本质是「**怎么设计**」的知识：三条线的编排、拍的落法、伏笔的埋法……
 * 正文模型不需要这些 —— 它只需要「这一章演什么」（那由插件自己的注入块给出）。
 * 原条目全文留档在 `model/design-rules.md`。
 *
 * ⚠ **为什么是四块而不是一块**（这一条是补返工）：
 *   一开始图省事，把整块挂到全部 5 个设计提示词上。但「篇章设计师」与「章节设计师」
 *   是**两次独立调用、两份不同提示词**，它们的知识层不一样 ——
 *   篇章排的是「这一部由几章组成、每一章是什么」，**根本不排拍**；
 *   给它读「一拍是一个场景内的一个转折」就是层级串味，还会把它拉进细节里。
 *
 *   所以按层切：
 *     · `DESIGN_BOTH`  —— 两层都成立（呼吸感、人物优先、与其它模块的关系）
 *     · `DESIGN_ARC`   —— **只发篇章**：三条线各自的分工、伏笔在大故事里的接续作用
 *       （0.22.0 起篇章要排章表，所以这里的措辞也改成「一章要能独立成立」而不是「不许写成章纲」）
 *     · `DESIGN_BEATS` —— **发章与支线**：一拍怎么落、伏笔具体怎么埋
 *     · `DESIGN_SIDE`  —— **只发支线**：支线服务主线的四种用法与份量纪律
 */

/**
 * ★ **写提示词的纪律**（0.22.3 补，别再犯）：
 *
 * 用户的评价是「不要一直做加法，宁庸勿滥」。这个文件里的提示词一度被我一版一版地堆到
 * DESIGN_ARC 59 行 / 2251 字、篇章与章各一次调用 8800+ 字 —— 而**堆料会让模型更不听话**，
 * 不是更听话。四条纪律：
 *
 *   ① **一个概念只在一层说一次**：跨层重复的删掉，只在真正需要它的那层留；
 *   ② **只留判据，删掉解释**：像「站不住就是承重梁用错了料」这种"为什么"是写给人看的，
 *      提示词里只留能判定的那一句；理由搬到代码注释（注释不花 token）；
 *   ③ **负面清单只留最典型的 1~2 条**，不要罗列变体；
 *   ④ **同族规则合并**：反制式化 / 换皮 / 形状重复 / 小东西承重 → 一条，带两个判据。
 *
 * 体积由回归 `probe-prompt-budget` 守着（撞上限时**先删再加**，不要上调预算）。
 */

/** 通用层：只要在设计就成立，篇章与章节都发。 */
const DESIGN_BOTH = [
    '===== 设计通则 =====',
    '## 呼吸感与人物优先',
    '- 一直绷紧会让人麻木：大转折**之前**先给平静的日常铺一拍，转折**之后**留一拍余波。',
    '- **设计与人物冲突时先照顾人物**（可以让设计变形，不要让人物崩掉）；配角也要有连续的动机与生活。',
    '## 与其它模块的关系',
    '- 冲突时以**角色卡与世界书**里的既有设定为先；别的模块（数据库推进、别的扩展、卡片剧本）当作**已有约束**去适配。',
    '- 玩家明确做过的事永远优先：设计跟着调整，不要逼他回到计划上。',
    '',
];

/** 篇章层：**只发给篇章设计**。这里不许出现「拍」怎么写 —— 那是章节层的事。 */
const DESIGN_ARC = [
    '===== 篇章层的设计规则 =====',
    '## 层级与分量',
    '篇章 ⊃ 章 = 主线 ⊃ 拍。每层装的东西不一样，别把小的往大的那层塞：',
    '- **篇章**：一段处境 / 关系 / 大势怎么变 —— 他要**什么**（去处、位置、这段关系能不能继续），',
    '  谁**挡着**（一个有同样理由的人、一桩旧账、体制），代价落在**他与别人的关系**上。',
    '- **章**：一件**落定**的事（差事接下了、旧账翻出来了）。　- **拍**：一个**转折**（有人当着他的面把话说破了）。',
    '- ⚠ **大轴不许架在一件小东西上**（物件、身体特征、气味、一句没头没尾的话）。',
    '  它们是正文里的伏笔与引子，最多当**某一章**的起因或**某一拍**的证据；',
    '  不许连着几章围着它转，也不许一部接一部都靠它。判据：**拿掉它，这一部还站得住吗？**',
    '',
    '## 章表：一段 = 一章，每章自己闭环',
    '判据：**把这一章单独拿出来，它是不是一个完整的小故事？**（有起因、有自己的冲突、有**自己落定的结果**）',
    '- 「推进了一点、什么也没落定」= 半章，不算一章。',
    '- **章与章不许一个形状**：连着几章都「有人搞事 → 他应对」就是制式化；换章就要换着力点。',
    '- 后一章从前面留下的局面里长出来；**不许**在章表里写「第一拍/第二拍」—— 拍是章节层细化的事。',
    '',
    '## 换新的一部时：换一套因果，不要换皮',
    '- **换一个在争的东西**：起因、推动的人、代价、落点都要换。上一部留下的既成事实是**起点**，不是骨架。',
    '- 连着两部用同一个形状（例：有人接连施压 → 逼到绝境 → 摊牌 → 妥协）就是套模板。',
    '- 判据：把新排的几章和上一部摊开对照 —— **除了换几个名字，还有没有区别？**',
    '',
    '## 伏笔（这一部能跨章接下去的绳子）',
    '- 交 **3~6 个**，每个都**具体到能被复述**；想清楚**大概在哪一章响**；不要为了凑伏笔凭空加新设定。',
    '- 与章表的分工：章表写**每一章会怎么变**，伏笔是**让这个变看起来早就埋在眼前**。',
    '',
];

/** 章节层：一拍一级的知识。**发章与支线**（它们都要交「拍」）。 */
const DESIGN_BEATS = [
    '===== 章节层的设计规则 =====',
    '## 拍怎么落',
    '- 一拍 = **一个场景内的一个转折**：谁在场、气氛怎么变、什么被打破了、谁注意到了。',
    '- 拍与拍要有**因果**：这一拍能发生，是因为上一拍留下了什么（一个痕迹、一句话、一个决定）。',
    '- 变化要**看得见**（多看了一眼、说话短了、开始撒谎），不要靠旁白宣布「她的心开始动摇了」。',
    '- 别每拍一个节奏：有的拍是对话、有的拍是一个动作、有的拍是一段沉默。',
    '## 伏笔怎么埋',
    '- **具体到可以被复述**；**一次埋一到两个就够**；要让**别人**注意到（他有没有注意由他自己决定）。',
    '- **必须顺手埋**：长在当前场景本来就会发生的事里；没有可埋的就不埋，不要凭空造新设定。',
    '- **准备兑现，不要埋完就解释** —— 让它在后面自己响。',
    '## 别让一章被一件小东西扛着',
    '- 小东西当**起因或证据**可以；**不许整章围着它转**，也不许换章了还在同一个着力点上。',
    '',
];

/** 支线层：**只发给支线设计**。 */
const DESIGN_SIDE = [
    '===== 支线层的设计规则 =====',
    '## 支线干什么用',
    '它存在的意义永远是**服务主线**，一条选一种就够：',
    '① **给动机**（让某个人物愿意）；② **给线索**（让某个秘密先露一点）；',
    '③ **给压力**（让处境变紧）；④ **给位移**（让两个人先熟起来 / 先有嫌隙）。',
    '- **它是配菜**：绝不能盖过主线当前那一拍；与主线冲突时永远先照顾主线。',
    '- **不能越过主线当前的进度**：主线还没到那一步，支线也不能替它发生。',
    '- **开销要小**：只写一个落点，一两拍就收，不要写成第二个主线；接不上了就写「已收尾」，别硬凑。',
    '',
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
        '规则优先级：用户在本插件里明确提出来的要求（优先满足）> 本提示词里的设计规则 > 角色卡自带设定（只作可选参考）；卡与世界书里已有的设定是**既成事实**，只能沿用、不能改写。',
        '你不写正文，只交一份给叙事者照做的演出计划。',
        '',
        ...COMMON_RULES,
        '',
    ];

    if (tone) lines.push('===== 基调（本故事是这一型，章节设计要贴合它）=====', tone, '===== 基调结束 =====', '');

    // ── 篇章：这是第几章 / 共几章 / **这一章的章内容**（你要细化的就是它）──
    if (hasEpic) {
        const title = String(unwrap(epic[EP.title]) ?? '').trim();
        const line = String(unwrap(epic[EP.line]) ?? '').trim();
        const ledger = String(unwrap(epic[EP.ledger]) ?? '').trim();
        const chapters = epicChapters(epic);
        const written = epicChapter(epic);
        const slot = written + 1;                       // 这一章是章表里的第几条
        const mine = chapters[slot - 1] ?? '';
        const climax = epicClimax(epic);
        const hooks = epicHooks(epic);
        const isClimaxChapter = climax && new RegExp(`第\\s*${slot}\\s*章`).test(climax);
        lines.push(
            `你要设计的是**这一部篇章里的第 ${slot} 章**${chapters.length ? `（共 ${chapters.length} 章）` : ''}：`,
            `${title ? `《${title}》` : ''}${line ? `　在争什么：${line}` : ''}`,
        );
        if (chapters.length) {
            lines.push(`这部篇章的**章内容**（一章一段 —— 你只管 ▶ 那一条，别的章不要动）：`);
            for (let i = 0; i < chapters.length; i++) {
                const mark = i + 1 <= written ? '✔' : (i + 1 === slot ? '▶' : '·');
                lines.push(`　${mark} 第 ${i + 1} 章：${chapters[i]}`);
            }
        }
        if (climax) lines.push(`这部篇章的**大高潮**：${climax}`);
        if (hooks.length) lines.push(`还没兑现的伏笔（这一章最多兑现一个，也可以只是继续吊着）：${hooks.join('；')}`);
        if (ledger) lines.push(`既成事实（**不可撤销**）：${ledger}`);
        lines.push(
            '',
            mine
                ? `⚠ **▶ 那一条就是这一章的定位** —— 把它细化成拍（不是另起一章，也不是把整册排一遍）：`
                : '⚠ 章表里没有对应的那一条（可能刚被换过）—— 顺着上一条的收尾自然接出这一章：',
            mine ? `　「${mine}」` : '',
            '⚠ **细化不是逐字翻译**：章内容只说"这一章要在整体里完成什么"，怎么发生、谁先动、从哪里切入，由你按当前处境设计。',
            '',
            '⚠ **这一章自己必须是一个闭环的小故事**：起 → 承 → **转（小高潮：最要紧的那一下真的发生）** → 合。',
            '　· 走完它，世界上要有一件事**真的落定**（成了/砸了/摊牌了/东西到手了），不能只是"推进了一点"；',
            '　· 最后几拍必须落到「合」上，结束时局面要有个明确的落点，不能停在半空；',
            '　· 它得**为整部大故事服务**（推进那个贯通的东西），不是随手一段插曲。',
            isClimaxChapter
                ? '　· ★ **这一章就是这一部的大高潮那一章**：全册攒的东西在这里一起兑现 —— 这一章的小高潮就是这部大故事的最高点。'
                : (climax ? `　· ⚠ **别在这一章里把大高潮用掉**（那是 ${climax}）—— 该攒的还得攒。` : '　· ⚠ **别在这一章里把整部大故事的高潮用掉** —— 该攒的还得攒。'),
            '',
            '⚠ **为整部大故事埋伏笔**：这一章至少留**一个**能在后文回收的细节，但**埋法必须自然** ——',
            '　顺手长在当前场景本来就会发生的事里；没有可埋的就不埋，**不许凭空加新角色 / 新地点 / 新势力**，也不要当场解释它。',
            '',
            '⚠ 这一章也必须是**主线**：「又赶了一程路 / 又过了一天」那是**间章**的料。',
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
        '⚠ **这一章必须「有戏」**（主线与间章的分界）：至少要有一件**实质推进**的事 ——',
        '　往上走（变强了、挣到了、被认可了）/ 往下沉（付了代价、输了、被算计了）/ 关系挪了一格 / 悬念揭开一点，任何一种都够。',
        '　赶路、逛街、「又过了一天」这类**日常流水账是间章的料**；轻松段落只能是拍与拍之间的呼吸，不能整章都是。',
        '',
        '⚠ **这一章必须有一个「矛盾」**（辩证意义上的：**两样不能同时满足的东西**；缺了它就只是「发生了些事」）：',
        '- 形态：**想要 vs 挡着** / **两难**（两个都要，只能选一个）/ **身份冲突** / **两个都在理**（最耐看）。',
        '- **不是「坏人对付他」**：不必有恶意，对立方只是**要的东西不一样** ——',
        '  要的是「两个不能同时满足的东西」，不是「又一个来找麻烦的人」。',
        '- **每一条拍都要服务于它**：自问**这条拍是在加压，还是在放掉压力？** 一条都不加压，这一章就散了。',
        '- 章内走一遍 **正 → 反 → 合**：提出（矛盾亮相）→ 激化（代价变具体、退路被堵上）→ 转化（小高潮）→ 新状态（新局面）。',
        '- **不要在章内解决长线那个大矛盾**，只处理它在**这一章**的那一层。',
        '- 两种相反的失败都要避：**太弱**（只是「有点不顺」，没有真正对立的东西）、**太强**（一上来就你死我活，后面没余地）。',
        '',
        '⚠ **小高潮**：这一章的拍要拧成一条自己的弧线，**最要紧的那一下真的发生**（摊牌、比赛到关键一局、成了或砸了），',
        '　之后**留一拍收尾**（别人的察觉、关系的位移、接下来要面对什么）。「一直在铺垫、什么都没落地」不算一章。',
        '',
        '- 章目标写成**矛盾的走向**（局面从什么样变成什么样，例：「那位客商原本够不着他 ↔ 现在能单独见到他了」）；',
        '  不要写成「他查到 / 决定 / 阻止了什么」—— 达成与否看**世界这边的状态**，不看 {{user}} 做了什么。',
        '- 整章推进：让**别人**动起来（示好、试探、瞒着、交换、催逼）、让**事件**发生（来客、传话、差事、意外、误会），用**伏笔**维持张力。',
        `- 整体节奏：${intensity.label} —— ${intensity.directive}`,
        '- 范围写清这一章**不碰**什么（别把后面几章的东西提前用掉）；新章的开头要接得住上一章的结尾。',
        '',
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
        '',
        ...DESIGN_BOTH,
        ...DESIGN_BEATS,
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
        '你的唯一任务：设计一段**间章** —— 夹在两条主线之间的一段日常，负责**润滑、填空**，并把与主线有关的信息递出来。',
        '规则优先级：用户在本插件里明确提出来的要求（优先满足）> 本提示词里的设计规则 > 角色卡自带设定（只作可选参考）；卡与世界书里已有的设定是**既成事实**，只能沿用、不能改写。',
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
        '一段间章的要求（**它是两条主线之间的一条缝**）：',
        '- **人就在身边**：写**刚收尾那一章里的这批人** —— {{user}} 身边的角色、他待的地方、他所属的队伍 / 家 / 铺子。作用是**润滑与填空**：让上一章的余波落地，再平移到下一章的开场。',
        '- **⚠ 不要另开一条世界线**：不跳到与主角团无关的远方城市、不写陌生人视角、不写「世界各地的平行空镜」（远方教授在归档、边境军需官在骂人 —— 那是设定集，不是间章）。',
        '- **一定要带一点与主线有关的信息**（这是它与「随便一段日常」的区别）：至少一个画面递出**真的会往下用**的东西 —— 上一章那件事的余波、一个与主线有关的决定 / 消息 / 察觉，或下一章会用到的一根线。可以含蓄、不必点破，但**不能与主线无关**。',
        '- **它不推进主线**：没有冲突升级、没有关键转折、没有新角色登场。',
        '- **不要当场兑现**那根线：埋下就好，不要解释、不要点破。',
        `- 给 ${budget} 个左右的**画面**（**宁少勿多**，2~3 个通常够了）：每个都能独立成一个小场景，顺序只是建议。`,
        '- **它们不是「必须完成的拍」**：叙事者可以只挑其中几个、也可以在任何一个之后收尾 —— 每个画面要自成小段落，不要写成非走完不可的锁链。',
        '- **写的是「别人在过日子」**：谁在忙什么、谁跟谁拌了嘴、谁送来了什么 —— 但都是**身边这批人**。不要把 {{user}} 写进拍里。',
        '- **场合要小**：一间铺子、一顿饭、一场雨、一次赶集 —— 就在他日常走动的范围里。',
        `- 整体节奏：${(INTENSITIES[s.intensity] || INTENSITIES.normal).label}。`,
        '',
        '按下面格式输出，标签原样照写，且**只输出一个区块**：',
        '',
        '<StoryInterludeChapter>',
        '标题: 4~10 字的短标题（例如「雨后的集市」）',
        '场合: 这一段发生在哪 / 什么时间（一句话，**就在他日常走动的范围里**）',
        '拍:',
        '1. 第一个画面（身边这批人的日常，顺带递出一点与主线有关的信息）……',
        '2. 第二个画面……',
        `（共 ${budget} 个左右，不必更多）`,
        '</StoryInterludeChapter>',
        '',
        ...DESIGN_BOTH,
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
    const perEpic = chaptersPerEpic();
    const lines = [
        '你是「故事导演」的**篇章设计师**，为一个正在进行的角色扮演服务。',
        mode === 'establish'
            ? '你的唯一任务：**为这个故事定下一部「篇章」**（一部完整的大故事）—— 它由若干「章」组成，每一章自己也是一个完整的小故事。之后每一章都由主线细化成「拍」。'
            : (mode === 'audit'
                // ★ 0.27.0：章末的**检查**任务（用户提的）——「只是检测，看看事情现在的发展，适当调整之后的发展」。
                //   与「重新校准」最大的区别：**默认不动**。成立就一字不改地抄回来。
                ? '你的唯一任务：**检查这一部篇章还成不成立** —— 一章刚刚演完，{{user}} 未必按剧本走（可能早就偏离、甚至反着来）。'
                    + '你要判断的是：**往后还没写的那几章，在「已经发生的这些事」之后还走得通吗？**'
                : '你的唯一任务：**按 {{user}} 实际做了什么，重新校准这一部篇章**（只改**还没写**的那几章）。他不是按剧本走的，你要跟着他改。'),
        '规则优先级：用户在本插件里明确提出来的要求（优先满足）> 本提示词里的设计规则 > 角色卡自带设定（只作可选参考）；卡与世界书里已有的设定是**既成事实**，只能沿用、不能改写。',
        '你交的是一份**篇章**：这一部大故事在争什么、**由几章组成、每一章是什么**、大高潮落在哪一章。不写正文、不写台词。',
        '',
        ...(mode === 'establish' ? [
            '⚠ **这是「新的一部」**：上面「防重复」里列的是**上一部已经讲过的章表** —— 要避开，不是照着填。',
            '　换一个「在争的东西」、换一套因果：**除了换几个名字还有区别吗？**',
            '',
        ] : mode === 'audit' ? [
            '⚠ **这是一次「检查」，不是重写。默认什么都不改。**',
            '　· **先判断**：往后那几章，按现在这个局面（{{user}} 实际做了什么、哪些人还在、什么已经不可逆）还走得通吗？',
            '　· **走得通 → 一字不改地照抄回来**（标题、章内容、大高潮、伏笔、既成事实全部原样），最后写一句 `检查: 照旧`。',
            '　· **只有真的走不通的那几章**才动它，而且要**小改**：换成**同一批人、同一处地方能自然发生的等价安排**；',
            '　　**不许引入新的灾变 / 机关 / 更大的事件**，也不许降下一个刚好解围的巧合。',
            '　· **已经写过的章一个字都不许动**（那是既成事实）；**标题也不许改**；能少改就少改，`检查:` 里一句话说清改了什么、为什么。',
            '　· ⚠ 常见病：{{user}} **已经明确**不按原计划走了，可后面的章还写着「靠他出手才成事」—— 这种才必须改'
            + '（他**只是还没走到**那一步不算，那是还没演）。',
            '',
        ] : [
            '⚠ **还是同一部，标题不要改**：上面给的标题就是这一部的名字，已经写过的章挂在它下面。',
            '',
        ]),
        '两条必须同时守住的原则：',
        '1. **主角是 {{user}}**：写「围绕他发生了什么事、他身边的人怎么变」；与他无关的势力动向只作背景。',
        '2. **绝不替他行动**：写「世界这边会怎么压过来」，不写「他会怎么做」。他中途走出剧本是常态，篇章要留出这种余地。',
        '',
        ...COMMON_RULES,
        '',
        '对「不平淡」的硬要求（这是这一层存在的理由）：',
        '- **不许把日常流水账当主线**：赶路、逛街、吃饭这些是「间章」的素材。',
        // ★ 这条是补反馈的：以前写「必须付出代价 + 必须不可逆」，于是每章被逼着往更黑升级。
        '- **有进展就够，不必每章都出事**：合格的推进是 —— **往上走**（变强了、挣到了、被认可了、拿到位置了）、',
        '  **往下沉**（付了代价、输了、被算计了）、**关系挪了一格**、**一个悬念被揭开一点**：任何一种都算。',
        '  不要把「有人付出代价 / 不可逆」当每章的门槛 —— 那样连着几章只能靠越来越黑来升级。',
        '- **要有「势」**：每一章结束时局面与开始时**不同**（更接近目标或更难），不是转一圈回到原点。',
        '  ⚠ 是「不同」，**不是**「必须更险」—— 稳步登高同样是「势」。',
        '',
        '⚠ **基调别往一个方向滑（这一层最容易被带偏的地方）。**',
        '- **黑暗与光明都要有位置**：反派、阴谋、背叛、险境**可以出现**，但不是默认走向；',
        '  「一步步积攒 → 稳步变强 → 在大场面兑现」**同样成立** —— 赢了比赛、被当众认可，与「失去了什么」一样是高潮。',
        '- **威胁与阻力要服务于这条线**，而不是把线本身换成一场围猎。',
        '',
        '⚠ **章表（你这一层的主产出）**：',
        `- **排满 ${perEpic} 章**，一章一段，写清**这一章要完成什么**；每一章得是**能独立成立的小故事**。`,
        '- **一段只写一章**：不要写「第一拍/第二拍」，也不要用「起承转合」当章名 —— 那是章内部的形状。',
        '',
        '⚠ **这一部是一个「有归宿」的完整大故事，不是一串越来越大的事件。**',
        '- **先定下那个贯通的矛盾**：这一部从头到尾在争什么？每一章都在它上面加一层新的压力或代价。',
        '- **必须收束到一个具体结果**：事情解决了 / 没能解决但付出去了代价 / 他变成了不一样的人。',
        '  **最后一章就该是那个结果**，而不是「更大的事又要来了」。「险境」要写怎么出来。',
        '- **讲完就该换新的一部**：别为了永远写下去而故意不收束。',
        '',
        '⚠ **两级高潮：你定「大高潮」落在第几章、是哪一场；每一章自己还有一个小高潮。**',
        '- 说清它落在**章表里的第几章**、**是哪一场**（例：「第 3 章 · 武道会决赛那场」），它通常在**靠后**、但不必是最后一章。',
        '- **之前要有「攒」**（长本事、攒人望、解决挡路的小麻烦），**之后留一章收束**。',
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
        if (history.length) lines.push(`这个故事已经走过的章：${history.join(' → ')}（新的一部篇章要接得上它们）。`);
        if (last) lines.push(`当前正在演的章：「${last}」——这一部新篇章可以从它之后开始，也可以把它当成开场。`);
        if (chapter > 0) lines.push(`这部篇章从**接下来那一章**开始排；**章表第 1 条就该是「马上要发生的事」**。`);
        lines.push(`请从**现在的处境**出发：读最近对话，看他是谁、他身边有谁、他手里有什么、什么东西正在逼近他。然后排满 ${perEpic} 章。`);
    } else {
        // `audit`（章末检查）与 `evolve`（重新校准）共用这段事实交代 —— 两者都要看「实际走过的路」。
        lines.push(mode === 'audit'
            ? '这一部已经演完的章、以及**每一章实际达成的目标**（审查这次的判断依据）：'
            : '本次是**重新校准**，请按下面这些事实改写篇章：');
        if (last) lines.push(`最近一章：「${last}」`);
        if (history.length) lines.push(`走过的章：${history.join(' → ')}`);
        const chapterGoals = completedChapterGoals(rootOf());
        if (chapterGoals.length) lines.push(`每一章实际达成的目标（**这是这一部真正走过的路，以它为准**）：${chapterGoals.join('；')}`);
        if (diverged) lines.push(`⚠ 偏离说明（正文模型的回报）：${diverged}`);
        lines.push(
            '',
            '⚠ **先做一次自检，再改**（这一步不能跳过）：',
            '- 拿上面「每一章实际达成的目标」回头看：**这张章表往后还走得通吗？** 如果实际剧情已经把后面某几章架空了',
            '  （该发生的事发生不了了、该出现的人不在了、代价已经被付掉了），就**改掉那几章**，不要硬圆回去。',
            '- 判据只有一条：**下一章还能从当前处境里自然长出来吗？** 长不出来就是章表要改。',
            '- ★ **「他还没做」≠「不成立」**：只看**已经写进正文的事**；他没做、还没出手只是**还没演** —— 不要据此提前作废后面的章。',
            '',
            mode === 'audit' ? '检查的原则（**默认不动，能少改就少改**）：' : '校准的原则（**大故事不丢，路线可以改**）：',
            '- 已经发生的事**不可撤销**：把它们全部并入「既成事实」，后面的一切建立在上面；',
            '- 他做过的事、他表过的态，就是这一部现在的走向 —— 不要假装没发生，也不要拉他回去；',
            mode === 'audit'
                ? '- ★ **走得通就一字不改地照抄**（这是最正常的结果）；只有真的走不通的那几章才动它，**章数不变**；'
                : '- 如果他的做法让原来那几章不成立了，就**换一条通往同一个终局的路**（保留他在乎的东西与要付的代价，改中间的路径）；',
            mode === 'audit'
                ? '- ★ 要改就**小改**：换成**同一批人、同一处地方能自然发生的等价安排**，**不许引入新的灾变 / 机关 / 更大的事件**。'
                : '- 如果他走出了一个完全没想到的方向，就**顺着他的方向重新想这部大故事的去处与终局** —— 那可能比原来的更好；',
            '- ★ **只改还没写的那几章**：已经写过的章要**原样保留**（它们已经演掉了），章表的总章数不要变；',
            '- 大高潮如果落在已经写过的章上，就把它往前挪到**还没写的某一章**（一部大故事的高潮不能已经过去）。',
        );
    }

    lines.push(
        '',
        '按下面格式输出，标签原样照写，且**只输出一个区块**：',
        '',
        '<StoryEpic>',
        '标题: 这部篇章的名字（6~14 字，例如「商路上的三封密信」）',
        '篇章: 两三句话说清这部大故事是什么、**在争什么**、他在其中的位置、以及为什么这事躲不掉',
        `章内容: 这一部由 ${perEpic} 章组成，一章一段 —— 写清**每一章要完成什么**`,
        '1. （第 1 章：从现在的处境起手。发生了什么事、局面变成什么样 —— 一章自己就是一个完整的小故事）',
        '2. （第 2 章：接住上一章留下的局面，往前推一段；这一章自己的小高潮是什么）',
        '3. （…每一章都这么写。**不要写「起承转合」当标题**，写内容）',
        `（共 ${perEpic} 条；每一章都要有一个自己落定的结果，不为后面的章留半截）`,
        '大高潮: 落在第几章、是哪一场（例如「第 3 章 · 武道会决赛那场」；这一场要让前面攒的东西全部兑现）',
        '伏笔: 三到六个还没兑现的细节，用「；」分开（要具体到能被复述）',
        '既成事实: 已经发生、不可撤销的事（用「；」分开；第一次定篇章时写现在的处境）',
        '</StoryEpic>',
        // ★ 检查任务要的结论：写在区块**外面**单独一行，插件只拿它给你一句可见的回执。
        ...(mode === 'audit' ? [
            '',
            '然后在区块**外面**单独写一行结论（插件会把它念给用户听）：',
            '检查: 照旧 ／ 或 检查: 第 3 章起改成了……，因为……',
        ] : []),
        '',
        '⚠ 章内容写的是**世界的动作**，不是{{user}}的动作：',
        '好例子：「使团的密信被人劫走，他的差事变成了别人的把柄」',
        '坏例子：「他决定暗中调查密信的去向」← 这是替他做决定',
        '⚠ 也**不要**把每一章都写成「一次比一次更惨的打击」：登高型的故事',
        '  （攒起来 → 登上高处 → 在大场面兑现）同样是对的写法，就看这个角色与当前处境该走哪条路。',
        '',
        ...DESIGN_BOTH,
        ...DESIGN_ARC,
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
        '',
        ...DESIGN_BOTH,
        ...DESIGN_BEATS,
        ...DESIGN_SIDE,
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
        '',
        ...DESIGN_BOTH,
    ].join('\n');
}

async function buildUserPrompt(task, userText = '', taskOpts = {}) {
    const blocks = await collectContextBlocks(task, taskOpts);
    const ask = String(userText || '').trim();
    // ★ 钉住的用户要求（若已钉）—— 每轮都带上，这样插件自己触发的重生成也不会把它丢掉。
    const pinned = pinnedAskText(task);
    if (pinned) blocks.push(`=== 用户钉住的要求（**每一轮都要满足**，与其它规则冲突时以它为准）===\n${pinned}`);
    if (ask) blocks.push(`=== 用户的额外要求（优先满足）===\n${ask}`);
    // ★ 朱批（用户对上一版的不满）放在用户输入的**最后**：最靠近尾注，模型最容易照它动。
    //   它由弹窗的「对上一版的朱批」那一栏经 taskOpts 传进来（只影响这一次重生成）。
    if (taskOpts.critique) blocks.push(String(taskOpts.critique));
    const anti = antiRepeatBlock(task);
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

/**
 * ★ 中断生成（0.27.6，用户提的「点下这个按钮，可以中断这次请求」）。
 *
 * 怎么做才是**真的**中断：神谕的 `api.run(messages, opts)` 收 `opts.signal`，
 * 一路传给底层的 fetch（见 story-oracle 的 soCallModel）——所以我们持一个 AbortController，
 * abort 掉发出的那个请求，而不是「等它跑完再假装没看见」（那样照样烧 token）。
 *
 * 三道保险，缺一不可：
 *   · `genCtl`      —— 交给 api.run 的 signal（真正掐断网络请求）；
 *   · `genId`       —— 每次生成一个新号；结果回来时号对不上就**作废**（中断后被新的一次顶掉的情形）；
 *   · `genAborted`  —— 用户主动取消的标记：调用方据此**不记失败**（否则会白吃 90 秒退避，还弹一句「生成失败」）。
 */
let genCtl = null;
let genId = 0;
let genAborted = false;
/** 当前在生成什么（给前端那行动画用，例如「章节」「篇章检查」）。 */
let genLabel = '';
/** 这次生成开始的时间戳 + 已收到的字数（流式时能看到它在动）。 */
let genStartedAt = 0;
let genChars = 0;
/** 每秒刷新一次「生成中」那行（秒数得会走，不然看着像卡死）。 */
let genTicker = null;

/** 用户主动中断的结果标记：与「失败（null）」严格分开，免得被当成失败记进退避。 */
const ORACLE_CANCELLED = Symbol('oracle-cancelled');

/**
 * 刚刚是不是**用户主动中断**的？
 *
 * 中断是用户的选择，不是错误 —— 但生成函数只能返回 true/false，调用方看到 false 就会
 * 弹「开章失败」、或者在「当前」页记一条「上一次开章失败」。所以留一个短时间窗，
 * 让那些提示自己让开（窗口外仍按真失败处理，不会把真问题吞掉）。
 */
let genAbortedAt = 0;
function justAborted(ms = 10000) {
    return genAborted && genAbortedAt > 0 && Date.now() - genAbortedAt < ms;
}

/** 开始一次生成：顺带做看门狗检查（超时就当上一次已经死了）。 */
function beginGenerate(label = '剧情') {
    if (storyGenerating) {
        const hung = storyGeneratingSince && Date.now() - storyGeneratingSince > GENERATE_WATCHDOG;
        if (!hung) return false;
        console.warn(`[故事导演] 上一次生成已经挂了 ${Math.round((Date.now() - storyGeneratingSince) / 1000)} 秒，判定为死掉，放开闸门重试。`);
        storyGenerating = false;
        storyGeneratingSince = 0;
    }
    storyGenerating = true;
    storyGeneratingSince = Date.now();
    genId++;
    genAborted = false;
    genLabel = String(label || '剧情');
    genStartedAt = Date.now();
    genChars = 0;
    try { genCtl = new AbortController(); } catch { genCtl = null; }
    if (genTicker) { clearInterval(genTicker); genTicker = null; }
    genTicker = setInterval(() => { renderBusyBar(); }, 1000);
    renderBusyBar();
    return true;
}

function endGenerate() {
    storyGenerating = false;
    storyGeneratingSince = 0;
    if (genTicker) { clearInterval(genTicker); genTicker = null; }
    genCtl = null;
    genLabel = '';
    genStartedAt = 0;
    genChars = 0;
    renderBusyBar();
}

/**
 * 用户点了「中断」：掐断请求 + 立刻放开闸门（不等它 reject，用户可以马上重来）。
 * ⚠ 不要在这里推进 genId —— 保留它，让刚才那次回来的结果能被认出「还是它」而作废。
 */
function abortGenerate() {
    if (!storyGenerating) { toast('现在没有正在进行的生成。', 'info'); return; }
    const label = genLabel || '剧情';
    genAborted = true;
    genAbortedAt = Date.now();
    try { genCtl?.abort(); } catch { /* 已经结束 */ }
    // 立刻放开闸门：底层 fetch 的 reject 不一定立刻回来，用户不该干等
    if (genTicker) { clearInterval(genTicker); genTicker = null; }
    storyGenerating = false;
    storyGeneratingSince = 0;
    genCtl = null;
    genLabel = '';
    genStartedAt = 0;
    genChars = 0;
    console.info(`[故事导演] 用户中断了「${label}」这次生成。`);
    toast(`已中断「${label}」这次生成。`, 'info');
    renderBusyBar();
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
async function askOracle({ task = 'chapter', userText = '', regenerate = false, rejected = null, keep = 0, remaining = 0, quiet = true, ephemeralSystem = '', taskOpts = {} } = {}) {
    const api = oracleApi();
    if (typeof api?.run !== 'function') {
        if (!quiet) toast('没有可用的模型连接——需要启用「故事神谕」扩展。也可以在主线上直接手写。', 'warning');
        return null;
    }
    const system = ephemeralSystem || (task === 'thread' ? buildThreadSystemPrompt()
        : task === 'side' ? buildInterludeSystemPrompt()
            : task === 'interlude' ? buildInterludeChapterSystemPrompt({ rejected })
                : buildChapterSystemPrompt({ regenerate, rejected, keep, remaining: Math.max(0, Math.round(toNumber(remaining, 0))) }));
    const user = await buildUserPrompt(task, userText, taskOpts);
    // ⚠ **绝不往神谕窗口里写东西**（这一条是补事故）。
    //   这里以前用 api.appendReply() 把「导演请求全文」和「模型原始回复」追加进神谕的对话里 ——
    //   后果有两个，都很难绷：
    //     ① 神谕窗口里会冒出一大段**正文**（模型偶尔不按 <StoryChapters> 输出而写成散文，也会被原样贴进去）；
    //     ② 那两条是 assistant 消息、还会 persistConvo() 存进聊天，等于把导演的提示词污染进神谕自己的历史。
    //   神谕的 api.run() 是**裸调用**（只带我们给的这两条消息、不带它的对话），所以想不留痕根本不用它提供机制 ——
    //   不发 appendReply 就够了。真要排查，看控制台与面板「诊断」页（生成闸门 / 世界书 / 实际注入的引导全文）。
    if (!quiet) console.debug(`[故事导演] 本次生成（${task}）的提示词与原始回复不写入神谕窗口；需要排查见面板「诊断」页。`);
    // ★ 0.27.6：把中断信号交下去（真掐断请求），并顺手接住流式进度让前端那行会动。
    const myId = genId;
    const ctl = genCtl;
    let result;
    try {
        result = await api.run([
            { role: 'system', content: system },
            { role: 'user', content: user },
        ], {
            signal: ctl?.signal,
            onDelta: (full) => { genChars = String(full || '').length; },
        });
    } catch (error) {
        if (ctl?.signal?.aborted || genAborted || myId !== genId) {
            console.info('[故事导演] 这次生成被中断（用户取消），结果不再采用。');
            return ORACLE_CANCELLED;
        }
        throw error;   // 真失败：仍按原来的路子交给调用方（toast + 退避）
    }
    // ⚠ 必须同时判 `genAborted`：万一底层**不理会** signal（老版本神谕 / 非 fetch 路径），
    //   迟到的结果照样会 resolve —— 只比 genId 拦不住它（中断并不推进 genId）。
    if (genAborted || myId !== genId) {
        console.info('[故事导演] 这次生成的结果已作废（用户中断 / 期间被新的一次生成取代）。');
        return ORACLE_CANCELLED;
    }
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
    // ★ **只有真的开出一章**（played === 0）才播「这一章」的基准：
    //   重排剩下的拍（played > 0）只是改后面的内容，不该把这一章的时钟与审查额度一起重置 ——
    //   以前这里无条件写，于是①级重排会把 `redesigns` 清零（升级梯永远升不上去）、
    //   把 `chapterOpenedAt` 推到当轮（余波 / 支线 warmup 的时钟被重排搅乱）。
    if (played === 0) {
        rt.chapterOpenedAt = rt.beatAt;
        // ★ 0.27.3：整章重来时把「同一拍卡住」的旧提醒也清掉（它指的是上一章那一拍）。
        rt.focusStale = '';
        rt.setupNote = '';
        rt.beatNote = '';
        // 支线／插曲的节奏基准一起播在开章这一刻：这一个间隔之内只推主线，
        // 满了一个间隔才开始考虑往里面插配菜（挂机/狂点都不会提前）。
        rt.threadAt = rt.beatAt;
        rt.interludeAt = rt.beatAt;
        // 新的一章 = 审查额度重新算（见 handleBeatReview：计数按「章」累计）
        rt.chapterId = `c${rt.beatAt}`;
        rt.reviewStrikes = 0;
        rt.reviewStrikesFor = rt.chapterId;
        rt.epicRewroteFor = '';
    }
    if (!rt.chapterId) rt.chapterId = `c${rt.beatAt}`;      // 老存档兜底：至少有个身份
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
    // ★ 0.27.3：每段新间章都从第 1 个画面重新算 —— 绝不允许沿用上一段（或主线）的拍号；
    //   顺手清掉主线留下的那两条一次性备注，免得在间章注入里冒出来。
    rt.focusInterlude = 1;
    rt.focusStale = '';
    rt.setupNote = '';
    rt.beatNote = '';
    rt.beatAt = aiMessageCount();
    rt.interludeAt = rt.beatAt;
    rt.lastInterlude = String(chapter?.[IL.title] ?? '').trim();
    // ⚠ 不在这里动审查额度：章的身份与额度由 applyChapter 在**真开出下一章**时统一重置
    //   （进间章只是主线收着，回主线时才会开新章）。
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
    if (!beginGenerate('间章')) return false;
    if (!force && isBackingOff(key)) return false;
    if (quiet) toast('正在请故事神谕设计一段间章…');
    const origin = chatKey();
    try {
        const raw = await askOracle({ task: 'interlude', rejected, quiet, userText });
        if (raw === ORACLE_CANCELLED) return false;          // 用户中断：不记失败、不弹错
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
 * 两个生成弹窗**共用**的尾部提示 —— 避免同一句话在两处一字不差地抄一遍。
 *
 * 弹窗是一次只出现一个的，所以它们各自必须自解释；但「这句话本身」只该有一个出处：
 *   · `pinHint(scope)` —— 「记住它」= 钉住这次填的要求，之后**插件自己触发**的重生成也不会丢；
 *     括号里那句是各自的情形（篇章跟到换一部、章节换章就失效），所以由调用方给；
 *   · `CRITIQUE_HINT` —— 朱批是**一次性的**，想长期生效就写进「要求」再按「记住它」。
 */
function pinHint(scope) {
    return `💡 <b>「记住它」</b>= 以后每次重生成（${scope}）都会带上这些要求，不会被覆盖。`;
}
const CRITIQUE_HINT = '✍️ <b>朱批只批这一版</b>：想让某条要求往后一直生效，就写在上面「要求」里再按「记住它」。';

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
    // ★ 朱批只在「确实有上一版可批」时出现：没有旧章表时这一栏没有意义，
    //   空摆一栏反而让人以为非填不可。
    const canCritique = epicStarted(epicOf(rootOf())) && epicChapterCount(epicOf(rootOf())) > 0;
    body.innerHTML = `
        <p class="sd-dialog-note">
            <b>篇章 = 一部完整的大故事</b>（有自己的大高潮与终局），由若干「章」组成；
            <b>每一章自己也是一个完整的小故事</b>，之后再交给主线细化成拍。<br>
            所以神谕在这里要交的是：<b>在争什么 + 章表（每一章是什么）+ 大高潮落在哪一章</b>。
            你只需要说清<b>你想要什么样的故事</b>，章节它会自己排。
        </p>
        ${pinnedEpic ? `<p class="sd-dialog-pin">📌 <b>已钉住的要求</b>（每轮都会带上，不会被重生成覆盖）：<br>${esc(pinnedEpic)}</p>` : ''}
        <label class="sd-dialog-field">
            <span>你对这条篇章的要求 / 倾向<b>（留空 = 让它自己按角色卡与当前剧情判断）</b></span>
            <textarea data-field="ask" rows="6" placeholder="例如：&#10;· 我想要一条关于「旧账被人翻出来」的线，别搞世界危机&#10;· 主角身边的人至少有一个会背叛，但不要太早&#10;· 结局别是简单的胜利，留一点没解决的东西&#10;· 少写打斗，多写人情与试探">${esc(pinnedEpic)}</textarea>
        </label>
        ${canCritique ? `<label class="sd-dialog-field">
            <span>朱批 —— 上一版章表<b>哪里不行</b><b>（只这一次生效；不写 = 没批过）</b></span>
            <textarea data-field="critique" rows="3" placeholder="例如：&#10;· 跟上一版几乎一样，只换了说法&#10;· 太像世界危机了，我要的是人情账&#10;· 大高潮落得太早，后面几章撑不住"></textarea>
        </label>` : ''}
        <div class="sd-dialog-row">
            <label class="sd-dialog-field"><span>基调（这条线是什么型的故事）</span>
                <select data-field="tone">
                    ${toneOptions().map((item) => `<option value="${esc(item.value)}" ${toneOf(s.tone) === item.value ? 'selected' : ''}>${esc(item.label)}</option>`).join('')}
                </select>
            </label>
        </div>
        <p class="sd-dialog-hint">当前基调：${esc(currentTone)}　·　${rebuilding ? '本次是<b>重新定篇章</b>（换一部）' : '本次是<b>按现在的情况重新校准</b>（长线不丢，路线可改）'}<br>
        ${pinHint('包括审查打回、自动换章')}<br>
        ${CRITIQUE_HINT}</p>
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
    // ★ 朱批：只批这一次，**不进钉住**（它是「上一版哪里不行」，不是长期要求）。
    const critique = String(picked.fields?.critique || '').trim();
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
    void generateEpic({ quiet: false, force: true, mode, entry, diverged, userText, critique: critiqueText(critique, 'epic') });
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
    // ★ 朱批只在「这一章已经有上一版拍列表」时出现 —— 没有旧拍可批时这一栏没有意义。
    const canCritique = beatsOf(mainState()).length > 0;
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
        ${canCritique ? `<label class="sd-dialog-field">
            <span>朱批 —— 上一版拍列表<b>哪里不行</b><b>（只这一次生效；不写 = 没批过）</b></span>
            <textarea data-field="critique" rows="3" placeholder="例如：&#10;· 跟上一版几乎一样，只换了地点和人名&#10;· 第 2 拍就摊牌了，太快，我要慢慢试&#10;· 全是打斗，我要的是人情和试探"></textarea>
        </label>` : ''}
        <label class="sd-dialog-field"><span>这一章几拍（共 3~6 拍）</span>
            <input data-field="beats" type="number" min="3" max="6" step="1" value="${esc(String(settings().beatTarget))}">
        </label>
        <p class="sd-dialog-hint">${regenerate ? '本次是<b>重新生成本章</b>（整章推倒重写）' : '本次是<b>设计下一章</b>'}　·　只想改后面几拍就用「主线」页的「只重排剩下的拍」。<br>
        ${pinHint('包括正文模型把这一章打回、重排剩下的拍')}换章后自动失效。<br>
        ${CRITIQUE_HINT}</p>
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
    // ★ 朱批：只批这一次，**不进钉住**。
    const critique = String(picked.fields?.critique || '').trim();
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
    void generateChapter({ quiet: false, regenerate, restart: regenerate, force: true, userText: userAskText(ask, 'chapter'), critique: critiqueText(critique, 'chapter') });
    return true;
}

/**
 * 生成 / 校准篇章。
 *
 * ⚠ `entry` 的语义在 0.22.0 变了：以前是「这份篇章校准到总第几章」（进度是全局的），
 *   现在**进度是这一册自己的**（`史诗.更新到第几章` = 这一册写到第几章了）：
 *     · `establish`（定一部**新的**）→ 进度**归零**，章表第 1 条就是"接下来马上要发生的事"；
 *     · `evolve`（按玩家实际做的校准）→ **进度不动**，只改还没写的那几章。
 */
async function generateEpic({ quiet = true, userText = '', force = false, mode = 'establish', diverged = '', entry = 0, critique = '' } = {}) {
    if (!mvu()?.getMvuData) {
        if (!quiet) toast('MVU 未加载：先确认酒馆助手与 MVU 装好了、这个聊天有变量。', 'warning');
        return false;
    }
    const key = `epic:${chatKey()}`;
    if (!beginGenerate(mode === 'audit' ? '篇章检查' : '篇章')) return false;
    if (!force && isBackingOff(key)) return false;
    if (quiet) toast(mode === 'establish' ? '正在请故事神谕定下一部篇章（一部完整的大故事）…' : '正在按他实际做的事重新校准篇章…');
    const origin = chatKey();
    // establish = 换新的一部 → 进度归零；evolve = 校准 → 不动进度
    const progress = mode === 'establish' ? 0 : null;
    // ★ 换新的一部之前，先把**旧的这一部**记进「上一部」名单：
    //   ① 它会被当成「要避开的东西」进防重复块（不然新的一部就是它的换皮）；
    //   ② 同时告诉上下文构造器：**别再拿旧章表当"这一册的章内容"发下去**。
    if (mode === 'establish') {
        const outgoing = epicOf(rootOf());
        if (epicStarted(outgoing)) rememberRetiredEpic(outgoing);
    }
    try {
        const raw = await askOracle({
            task: 'epic',
            taskOpts: { replacingEpic: mode === 'establish', critique },
            ephemeralSystem: buildEpicSystemPrompt({
                mode,
                diverged,
                tone: toneDirective(settings().tone),
                chapter: mode === 'establish' ? 0 : Math.max(0, Math.round(toNumber(entry, 0))),
            }),
            quiet,
            userText,
        });
        if (raw === ORACLE_CANCELLED) return false;          // 用户中断：不记失败、不弹错
        if (raw === null) { clearFailed(key); return false; }
        if (origin && chatKey() !== origin) {
            clearFailed(key);
            console.info('[故事导演] 生成期间切换了聊天，这份篇章（属于旧聊天）没有落盘。');
            return false;
        }
        const blocks = parseBlocks(raw, 'StoryEpic');
        const epic = blocks.length ? epicFromBlock(blocks[blocks.length - 1], { chapter: progress }) : null;
        // ★ 校准（evolve）与检查（audit）**都不许换名字**：这一部还叫这个名字 —— 已经写过的章挂在
        //   它下面，中途改名就是用户看到的「大纲自己变了」。要换名字只有两条路：
        //   ① 这一部写完了自动开新的一部（establish）；② 用户手动点「重新定篇章（换一部）」。
        if (epic && (mode === 'evolve' || mode === 'audit')) {
            const keepTitle = String(unwrap(epicOf(rootOf())[EP.title]) ?? '').trim();
            if (keepTitle) epic[EP.title] = keepTitle;
        }
        if (!epic || !epicStarted(epic)) {
            console.info('[故事导演] 神谕没有返回可用的 <StoryEpic> 区块，原始回复：\n' + raw);
            toast('没解析到 <StoryEpic> 区块，原始回复已打印到控制台。', 'warning');
            markFailed(key);
            return false;
        }
        // ★ 检查（audit）：比对章表，把结论**念给用户听**（默认「照旧」才是正常结果）。
        if (mode === 'audit') {
            const before = epicChapters(epicOf(rootOf()));
            const after = epicChapters(epic);
            const changed = stableJson(before) !== stableJson(after);
            const verdict = String((raw.match(/检查[:：]\s*([^\n]+)/) || [])[1] ?? '').trim();
            const run = settings().run;
            run.lastAudit = {
                at: aiMessageCount(),
                章: String(unwrap(epicOf(rootOf())[EP.chapter]) ?? ''),
                结果: changed ? 'adjusted' : 'unchanged',
                说明: verdict.slice(0, 200),
            };
            save();
            toast(changed
                ? `篇章检查：往后几章已按实际发展调整${verdict ? ` —— ${verdict}` : '。'}`
                : `篇章检查：这一部往后几章还成立，没动它${verdict ? `（${verdict}）` : '。'}`,
                'info');
            console.info(`[故事导演] 篇章检查结果：${changed ? '有调整' : '照旧'}${verdict ? `｜${verdict}` : ''}`);
        }
        await applyEpic(epic, { quiet: false, entry: progress });
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
async function generateChapter({ quiet = true, regenerate = false, rejected = null, userText = '', force = false, keep = undefined, restart = false, critique = '' } = {}) {
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
    if (!beginGenerate(regenerate ? '重写这一章' : '下一章')) return false;
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
            // ★ 朱批只影响这一次重生成（不进钉住、不落盘）。
            taskOpts: { critique },
        });
        if (raw === ORACLE_CANCELLED) return false;          // 用户中断：不记失败、不弹错
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
    if (!beginGenerate('支线')) return false;
    const key = `thread:${chatKey()}`;
    if (!force && isBackingOff(key)) return false;
    if (quiet) toast('正在请故事神谕设计一条支线…');
    const origin = chatKey();
    try {
        const raw = await askOracle({ task: 'thread', quiet, userText });
        if (raw === ORACLE_CANCELLED) return false;          // 用户中断：不记失败、不弹错
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
    if (!beginGenerate('插曲')) return false;
    const key = `interlude:${chatKey()}`;
    if (!force && isBackingOff(key)) return false;
    if (quiet) toast('正在请故事神谕设计一条插曲…');
    const origin = chatKey();
    try {
        // ⚠ 必须用 task:'side'（小插曲）。'interlude' 现在是**间章**那条通道，
        //    用错会让不占幕的小插曲生成出一整章的数据结构。
        const raw = await askOracle({ task: 'side', quiet, userText });
        if (raw === ORACLE_CANCELLED) return false;          // 用户中断：不记失败、不弹错
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
 * 把「活变量」里那份审查结论也复位。
 *
 * 为什么：同一个 MVU 事件里，`rootOf(live)` 会被读好几次，而 `live` 是**事件带来的快照** ——
 * 我们只写 `story`（与 MVU 存储）的话，后面几次读又会把旧结论（`调整` / `缺铺垫` / `驳回`）
 * 从这份快照里拉回来，本轮就会反复处理同一个信号。抹掉它，两边当轮就一致了。
 */
function clearReviewInLive(live) {
    const ns = live?.stat_data?.[NS];
    if (!isPlainObject(ns) || !isPlainObject(ns[MAIN_SECTION])) return;
    ns[MAIN_SECTION][KEY_REVIEW] = REVIEW_PASS;
    ns[MAIN_SECTION][KEY_REVIEW_NOTE] = '';
}

/**
 * 这一章的身份（审查额度按它统计）。
 * 优先用 `run.chapterId`（真开章时播下、重排不动）；老存档没有就退回章名（只为兼容）。
 */
function currentChapterId(live = null) {
    const rt = settings().run;
    if (rt.chapterId) return String(rt.chapterId);
    const title = String(unwrap(mainState(live)[MAIN_TITLE]) ?? '').trim();
    return `title:${title}`;
}

/**
 * 处理「正文模型说这一拍站不住」的回报。返回 true 表示本轮已经重新设计，自动推进让位。
 *
 * ★ **升级梯就是用户定的那条原则**（见 `reviewLadder`）：
 *   正文说「当前主线不合适」→ **只重新设计还没演的拍**（已演的一字不动，篇章不动）；
 *   **同一章累计第 3 次**仍然不合适 → 才允许**改篇章**（只改还没写的章）+ 重建这一章。
 *
 * 两条容易被写坏的：
 *   · 计数**按章累计**（不要求连续）；只在真开新章 / 用户整章重写时归零（见 applyChapter）；
 *   · **同一章最多动一次篇章**（`epicRewroteFor`）—— 否则会「改篇章 → 又报一次 → 又改篇章」，
 *     也就是用户看到的「大纲自己变了」。
 *
 * 节流：两次重排之间至少隔 `redesignGap` 轮（否则模型连着报两次就把调用全烧在这上面）。
 */
async function handleBeatReview({ live = null } = {}) {
    const s = settings();
    // ★ 总开关关着 = 「只手动生成与采用」（见 DEFAULT.autoDirector 的说明）——
    //   审查上的重排同样是**插件自己调模型**，必须一起停。
    //   ⚠ 以前这里只看 autoRedesign，总闸关了它照样在重排 —— 做总开关时顺手审计出来的漏网之鱼。
    if (!s.autoDirector || !s.autoRedesign) return false;
    const main = mainState(live);
    const state = reviewStateOf(main);
    const chapterId = currentChapterId(live);
    // 新的章 → 审查额度重新算（由 chapterId 判定，不看章名 —— 章名会变、也会重名）
    if (s.run.reviewStrikesFor !== chapterId) {
        s.run.reviewStrikesFor = chapterId;
        s.run.reviewStrikes = 0;
        s.run.epicRewroteFor = '';
        s.run.setupNote = '';       // 换章了：上一章按着的那一拍作废
        s.run.beatNote = '';
    }
    if (state === REVIEW_PASS) {
        // ⚠ **不清零审查额度**：原则是「同一章累计三次」，中间夹一次通过不该把前两次抹掉
        //   （以前这里一通过就清零，于是永远攒不满 3 次 —— 梯子形同虚设）。
        //   只把节流基准清掉，让下一次信号不必等。
        // ★ 顺手把「上一轮给过的微调回执」收掉 —— 它只该出现一轮（0.27.0）。
        if (s.run.beatNote) { s.run.beatNote = ''; save(); }
        if (s.run.redesignAt) { s.run.redesignAt = 0; save(); }
        return false;
    }

    // ★ **模型自己能消化的事，不花神谕**（0.27.0：用户给正文模型的自由裁量权）：
    //   `调整`   = 它已经按当前趋势把这一拍的**执行方式**改了（目的不变）→ 回它一句边界，继续推进；
    //   `缺铺垫` = 这一步还缺一个来由 → **把这一拍按住**，并在下一轮注入里要求它先补上（用户提的「缓插」）。
    //   两者都**不动计划、不计入打回阶梯**（阶梯只数 `驳回`）。
    const action = reviewAction(state);
    if (action.kind === 'lite') {
        const note = reviewNoteOf(main);
        await patchMain({ [KEY_REVIEW]: REVIEW_PASS, [KEY_REVIEW_NOTE]: '' }, { live });
        clearReviewInLive(live);
        if (action.note === 'setup') {
            s.run.setupNote = note || '这一步还缺一个来由（谁为什么会这么做 / 局面为什么会突然变成这样）';
            s.run.beatNote = '';
            save();
            toast('正文模型报「这一拍还缺一步铺垫」—— 先按住它，让它补完再演。', 'info');
            console.info(`[故事导演] 缺铺垫：这一拍按住，要求下一轮先补 —— ${s.run.setupNote}`);
        } else {
            s.run.setupNote = '';
            s.run.beatNote = note ? `你改成了：${note}` : '你按当前趋势调整了这一拍的执行';
            save();
            toast('正文模型按当前趋势微调了这一拍的执行（不重排、不花神谕）。', 'info');
            console.info(`[故事导演] 微调：${s.run.beatNote}`);
        }
        if (!panel?.hidden) render();
        return action.hold;         // 缺铺垫：本轮就停在这儿（把这一拍按住）
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
    clearReviewInLive(live);

    // ★ 判定交给纯函数（model.js 的 reviewLadder）—— 这条原则必须能被离线测。
    const verdict = reviewLadder({
        strikes: s.run.reviewStrikes,
        epicRewritten: s.run.epicRewroteFor === chapterId,
    });
    const played = Math.max(0, currentBeat(main) - 1);
    const why = `${state}」${note ? `：${note}` : ''}`;
    s.run.reviewStrikes = verdict.nextStrikes;
    s.run.redesignAt = count;
    save();

    if (verdict.action === 'retry') {
        // ★ **只重新设计还没演的拍** —— 已演的一字不动，篇章也一个字不动。
        //   第 2 次起把措辞加硬（换一套推进方式），因为「同一个毛病再来一次」说明上一版换汤不换药。
        const harder = verdict.attempt >= 2;
        toast(`正文模型报「${why}——正按当前情况重排剩下的拍（第 ${verdict.attempt}/${STRIKES_BEFORE_EPIC} 次，已演的 ${played} 拍不动）。`, harder ? 'warning' : 'info');
        console.info(`[故事导演] 审查重排（${verdict.reason}）：重设计《${String(unwrap(main[MAIN_TITLE]) ?? '当前章')}》剩下的拍，保留已演的 ${played} 拍。`
            + (harder ? '第 2 次起要求换一套推进方式。' : ''));
        void generateChapter({
            quiet: true, regenerate: true, force: true, keep: played,
            rejected: {
                state,
                note,
                scrap: harder,
                badBeats: harder ? beatsOf(main).slice(played) : undefined,
                reason: harder
                    ? `这一章的**剩余部分**反复立不住（第 ${verdict.attempt} 次）：${note || state}。`
                        + '请**换一套推进方式**：不要沿用原来剩下的那几拍的地点、人物组合与事件顺序，'
                        + '换一条在当前处境下真正走得通的路 —— 但这一章要服务的长线目标不能丢。'
                    : undefined,
            },
        });
        return true;
    }

    // ★ 第 3 次（同一章累计）仍然不合适 → 才允许**改篇章**：只改还没写的那几章，然后重建这一章。
    //   ⚠ 同一章最多动一次（见 reviewLadder 的 ②）—— 记在 epicRewroteFor 上。
    s.run.epicRewroteFor = chapterId;
    save();
    toast(`同一章第 ${verdict.attempt} 次报「${why}」——判断为**这一部往后几章的方向立不住**，正在请神谕改掉还没写的那几章，然后重排剩下的拍。`, 'warning');
    console.info(`[故事导演] 升级：${verdict.reason} → 改篇章未写的章（只这一次），再重排《${String(unwrap(main[MAIN_TITLE]) ?? '当前章')}》剩下的拍。`);
    void (async () => {
        const ok = await generateEpic({
            quiet: true, force: true, mode: 'evolve', entry: null,
            diverged: `这一部篇章往后那几章在实际演出里**同一章连着 ${verdict.attempt} 次**立不住（正文模型报「${state}」${note ? `：${note}` : ''}）。`
                + '请**只改还没写的那几章**：换一条通往同一个终局、但当前处境下真正走得通的路；'
                + '如果某几章的设定本身不可行，就换掉那几章。**已经写过的章不要动，标题也不要改**（这一部还叫这个名字）。',
        });
        if (!ok) {
            // 篇章没改成也不该把故事卡死：照样重排这一章（带着失败原因）
            toast('篇章没能改成功 —— 仍然会重排这一章剩下的拍（它只是配料）。', 'warning');
        }
        void generateChapter({
            // ★ 同样保留已演过的拍：篇章换了方向，也只是「剩下的怎么走」要重新想。
            quiet: true, regenerate: true, force: true, keep: played,
            rejected: {
                state, note, scrap: true,
                badBeats: beatsOf(main).slice(played),
                reason: '长线往后几章的方向已经被判定立不住，篇章刚刚改过。'
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
    const rounds = roundsSinceArmed(rt);
    if (!s.enabled) return { key: 'plugin-off', text: '插件已停用（扩展列表里重新启用）' };
    if (!mvu()) return { key: 'no-mvu', text: 'MVU 没加载：先确认酒馆助手与 MVU 装好了' };
    // ⚠ 0.26.0 起剧情状态住在插件里，所以「有没有变量」要看 **MVU 那棵树在不在**
    //   （它是模型回报进度、也是插件写 token 的地方），不能拿插件里的 story 判断。
    if (!isPlainObject((live && live.stat_data) || mvuData()?.stat_data)) return { key: 'no-namespace', text: '这个聊天还没有 MVU 变量：先和角色聊一句' };
    if (!s.autoDirector) return { key: 'director-off', text: '「总开关」是关着的 —— 点面板顶上的 ⏻ 打开，或点下面的「设计下一章」手动开' };
    if (typeof oracleApi()?.run !== 'function') {
        return { key: 'no-oracle', text: '读不到「故事神谕」的模型连接 —— 确认故事神谕已安装并启用（版本要 1.21 以上，且它的 Hook API 没被关掉）' };
    }
    if (s.autoEpic && !epicStarted(epicOf(rootOf(live))) && Math.round(toNumber(rt.epicTries, 0)) < 3 && rounds >= 2) {
        return { key: 'epic-pending', text: '正在定篇章（定篇章完成或失败 3 次之后就会开第一章）' };
    }
    if (!s.autoChapter) return { key: 'chapter-off', text: '「自动换章」是关着的 —— 打开它，或点下面的「设计下一章」' };
    if (rounds < 3) {
        return {
            key: 'too-few-rounds',
            text: `这个聊天从插件接管算起才 ${rounds} 轮 AI 回复，聊满 3 轮才会自动开第一章（在此之前不会调模型花钱）`,
        };
    }
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
    // 用户主动中断的那一次不算「开章失败」（否则「当前」页会留一条误导的记录）。
    if (!ok && justAborted()) return;
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
        // 变量树在不在（剧情状态本身住在插件里，见 ensureNamespace 上方那段说明）
        if (!isPlainObject((live && live.stat_data) || mvuData()?.stat_data)) return;

        const key = chatKey();
        if (s.run.chatId !== key) {
            s.run = JSON.parse(JSON.stringify(DEFAULT.run));
            s.run.chatId = key;
            // ★ 顺手把引用接回去：`applySliceToSettings` 是**同一个对象**（不是克隆），
            //   上面这行克隆会把切片与前台的联系打断 —— 不接回去，本次会话推进的游标
            //   （beatAt / threadAt / armedAt …）就只活在前台，一刷新被旧切片盖掉。
            if (isPlainObject(s.chats)) s.chats[key] = { run: s.run, chapters: s.chapters };
            save();
        }

        // ★ 就位基准（见 run.armedAt）：老存档 / 老版本留下的切片还没播过，就**现在**播 ——
        //   等于「从这一刻起开始数轮数」，所以升级后不会因为历史几百楼而立刻开篇。
        //   ⚠ 只在**没播过**时播：每轮都重播的话，`count - armedAt` 永远是 0，插件就再也不动手了。
        if (needsArming(s.run)) { armNow(s.run); save(); }

        // ★ 回退聊天（重新生成 / 删楼 / 换 swipe）会让回复数变少，把「按回复数记账」的游标修回来。
        //   必须放在**任何冷却判断之前** —— 否则冷却会因为差值为负而永久卡死。
        if (repairRunCursors(s.run, aiMessageCount())) save();
        // ★ 回退一层（删楼）时，把这一拍的进度也退回去 —— 见 syncBeatBackOnRollback。
        if (syncBeatBackOnRollback(aiMessageCount())) save();

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

            // ★ **篇章检查**（0.27.0，用户提的）：旧章刚演完、新章还不该立刻衔接 —— 正好趁间章这几轮，
            //   静默做一次「往后还没写的那几章，在已经发生的这些事之后还成立吗」。
            //   结果只有两种：照旧（不动）或只改没写的章；下一章回到主线时就已经用上新章表了。
            if (s.autoEpic && s.auditEpic && !epicFinished(epicOf(rootOf(live)))
                && epicChapter(epicOf(rootOf(live))) > 0
                && rt.closedChapter && rt.auditedFor !== rt.closedChapter
                && !isPending(`epic:${chatKey()}`) && !blockedByCooldown(s, count, rt)
                && typeof oracleApi()?.run === 'function') {
                rt.auditedFor = rt.closedChapter;
                markPending(`epic:${chatKey()}`);
                markGenerated(rt, count);
                save();
                console.info('[故事导演] 趁间章做一次篇章检查（只判断，默认不改）。');
                void generateEpic({
                    quiet: true, force: true, mode: 'audit', entry: null,
                    diverged: '这一部已经演完的章见上；请判断**往后还没写的那几章**在现在这个局面下还成不成立。'
                        + '注意：他「还没做」的事**不等于不成立**（那只是还没演）—— 不要据此提前作废后面的章；'
                        + '也不要给他正奔向的方向塞一个突发变故（解围的巧合、天降灾变、第三方插手）把它掀掉。',
                });
                return;
            }

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
            const pendingEpic = isPending(`epic:${chatKey()}`);
            const tries = Math.round(toNumber(rt.epicTries, 0));
            const canTryEpic = !pendingEpic && tries < EPIC_GIVE_UP;

            // ① **这一册写完了**（章表里的章都写过了）→ 换一部新的篇章。
            //    ⚠ 这是新模型的关键一环：篇章是**有始有终**的一册，不是无限延长的一条线。
            //
            //    ★ 0.27.8 修了用户报的「一部演完之后一直不生成下一部」：
            //     这里原来还要求 `beats.length === 0`（「场子空着」）—— 但那个条件**永远不成立**：
            //     章收尾并不会清掉主线那一栏的拍（`applyChapter` 总是覆盖成「当前这一章」），
            //     所以第一部演完之后，这个闸门**一次都没开过**。
            //     真正该看的只有一件事：**上一章已经收尾**（rt.closedChapter 记着）且章表写满了。
            if (epicFinished(epic) && rt.closedChapter) {
                archiveFinishedEpic(live);          // 先归档（失败也不影响下一轮）
                if (canTryEpic) {
                    rt.epicTries = tries + 1;
                    markPending(`epic:${chatKey()}`);
                    save();
                    toast(`《${String(unwrap(epic[EP.title]) ?? '这一部')}》这一部已经写完 ${epicChapter(epic)} 章 —— 正在请故事神谕定下一部篇章。`, 'info');
                    // 换新的一部：进度归零（entry 由 generateEpic 按 establish 处理）
                    void generateEpic({ quiet: true, force: true, mode: 'establish', entry: 0 });
                    return;
                }
            }
            // ② **这里原来还有一条「每开新章前自动校准篇章」** —— 删了（0.25.0）。
            //   它的条件是 `!epicFinished && !章内容[更新到第几章]`，而 `epicFinished` 就是
            //   `更新到第几章 >= 章表长度` —— 两个条件**自相矛盾，从来没生效过**。
            //   更要紧的是：按字面修好它就等于「每换一章改一次大纲」，正是用户报的
            //   「推了一下剧情篇章大纲就自己变了」。篇章现在只由两件事动：
            //   审查三连击（见 handleBeatReview）与本人在「篇章」页手动点。
            // ③ 还没定篇章：这是万事的前提，**不该被生成冷却卡住**（卡住就等于整个插件不动）
            //   ⚠ 「聊满 2 轮」算的是 `count - armedAt`（就位基准），不是整个聊天的历史条数 ——
            //     否则切进一个几百楼的老聊天时它立刻成立，一进去就烧一次神谕（用户报的就是这个）。
            if (!epicStarted(epic) && canTryEpic && roundsSinceArmed(rt) >= 2) {
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
            void generateChapter({ quiet: true, force: true, restart: true }).then((ok) => noteAttempt(ok));
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
        if (s.autoBeat && beat <= total && truthy(main[KEY_BEAT_DONE])) {
            const at = Math.round(toNumber(rt.beatAt, 0));
            if (!at || count - at >= minReplies) {
                const focus = Math.max(1, Math.round(toNumber(rt.focusBeat, 0)) || beat);
                const next = Math.min(total + 1, Math.max(beat, focus + 1));
                rt.focusBeat = next;
                rt.beatAt = count;
                rt.focusBeatSince = count;          // 换拍了：同一拍的「连着演了几轮」重新计时
                rt.focusStale = '';
                rt.setupNote = '';                  // 这一拍落了 → 之前按着它的铺垫要求完成使命
                rt.beatNote = '';
                save();
                await patchMain({ [KEY_BEAT]: next, [KEY_BEAT_DONE]: false }, { live });
                toast(next > total
                    ? `第 ${Math.min(focus, total)} 拍已落地，本章拍已演完。`
                    : `第 ${Math.min(focus, next - 1)} 拍已落地，进入第 ${next} 拍。`, 'success');
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
            // ★ 0.27.8：**就在这一刻**判断这一部是不是演完了 —— 演完了就立刻归档。
            //   不等「新篇章生成成功」再归档：生成可能失败，失败时它就会一直赖在注入里
            //   （用户报的「一部演完之后一直不生成下一部」里，有一半是这个原因）。
            if (archiveFinishedEpic(live)) {
                toast(`《${String(unwrap(epicOf(rootOf(live))[EP.title]) ?? '这一部')}》这一部已经演义完了，已归档。`, 'success');
            }
            syncInterludeWrites();
            const useInterlude = s.autoInterludeChapter;
            // ★ 不走间章时（`autoInterludeChapter` 关着）：**开下一章之前**先把篇章检查做掉 ——
            //   否则新章已经按旧计划开出来了，检查就白做了。（走间章时在间章那几轮里静默做，见上面。）
            if (!useInterlude && s.autoEpic && s.auditEpic && epicChapter(epicOf(rootOf(live))) > 0
                && !epicFinished(epicOf(rootOf(live))) && rt.auditedFor !== mainKey) {
                rt.auditedFor = mainKey;
                save();
                console.info('[故事导演] 本章收尾：开下一章之前先做一次篇章检查（只判断，默认不改）。');
                await generateEpic({
                    quiet: true, force: true, mode: 'audit', entry: null,
                    diverged: '这一部已经演完的章见上；请判断**往后还没写的那几章**在现在这个局面下还成不成立。'
                        + '注意：他「还没做」的事**不等于不成立**（那只是还没演）—— 不要据此提前作废后面的章。',
                });
            }
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
async function ensureClosingChapter({ interlude = true, live = null } = {}) {
    if (closingChapterTask) return closingChapterTask;
    closingChapterTask = (async () => {
        if (interlude) {
            return await generateInterludeChapter({ quiet: true, force: true });
        }
        // ★ 0.27.8：**先判断这一部是不是演完了**。
        //   用户报的「一部演完之后一直不生成下一部」有两条路都会走到这里：
        //     ① 章收尾（不走间章时）；
        //     ② **从间章回主线**（默认走的就是这条：章收尾 → 间章 → 回主线 → 开下一章）。
        //   而这里原来**无脑开下一章** —— 于是在一个已经写满章表的篇章底下又开了一章，
        //   换篇章的闸门（在心跳里、要求 epicFinished）虽然成立，却永远轮不到它先执行。
        //   所以这里必须先换新的一部；新篇章的第一章由下一次心跳按常规开出来。
        const outgoing = epicOf(rootOf(live));
        if (epicFinished(outgoing)) {
            archiveFinishedEpic(live);           // 演完了 → 立刻归档（不再参与注入）
            console.info(`[故事导演] 上一部《${String(unwrap(outgoing[EP.title]) ?? '')}》章表已写满 —— 改为请神谕定下一部篇章。`);
            return await generateEpic({ quiet: true, force: true, mode: 'establish', entry: 0 });
        }
        // ★ 0.27.3：这里开的是**新的一章**（上一章已经记进章节史了）→ 必须整章重来（restart）。
        //   以前不传 keep，于是走「保住已演过的拍」那条默认路径：新章会把上一章演过的拍当成自己的，
        //   拍号从 4 续到 5 —— 用户看到的「只生成了三拍，却说第四拍已落地、进入第五拍」就是这么来的。
        return await generateChapter({ quiet: true, force: true, restart: true });
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
    await writeStory(apply);
    return true;
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
 * ★ **回退一层时，把这一拍的进度也退回去**（用户提的）。
 *
 * 「把最新回复删掉、回退一层，那这一拍已经落了的标识能回退吗？重新生成的时候，重新注入这一拍。」
 *  — 标识（`本拍已落` 等）**会自动退**：它们住在每楼的变量快照里，删掉那一楼就没了；
 *    但 `当前拍` 是插件自己的数字（只推不拉），不跟着退 → 「标识说没落、数字说已落」，
 *    重新生成就会去注入**下一拍**。所以这里按快照把它退回来，两者才一致。
 *
 * 触发条件只有「回复数变少」；退回目标由纯函数 `beatRollbackTarget` 判定（见它的注释）。
 */
function syncBeatBackOnRollback(count) {
    const rt = settings().run;
    const target = beatRollbackTarget({
        count,
        lastCount: rt.lastCount,
        mine: getPath(storyNs(), `${MAIN_SECTION}.${KEY_BEAT}`),
        snapshot: getPath(mvuData()?.stat_data?.[NS], `${MAIN_SECTION}.${KEY_BEAT}`),
    });
    rt.lastCount = count;
    if (target === null) return false;
    const story = storyNs();
    story[MAIN_SECTION][KEY_BEAT] = target;
    // 聚焦游标也得跟着退：它比 `当前拍` 大一点就会「跳拍」（next = max(beat, focus+1)）。
    if (Math.round(toNumber(rt.focusBeat, 0)) > target) rt.focusBeat = target;
    rt.beatAt = 0;                       // 回退后允许立刻重新落拍 —— 用户就是要重来这一拍
    rt.focusBeatSince = count;
    rt.focusStale = '';
    save();
    // 聊天级那一份刚才可能还留着「已落」的进度 —— 对齐一下，否则下一楼从它继承，又跳回去了。
    void syncNsToChat();
    console.info(`[故事导演] 检测到回退：这一拍退回第 ${target} 拍（按 MVU 那一楼快照里的进度），`
        + '重新生成会重新注入它。');
    return true;
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

const TABS = [['now', '当前'], ['epic', '篇章'], ['main', '主线'], ['side', '支线/插曲'], ['set', '设定'], ['about', '关于']];

/**
 * 「关于」页：头像 + 作者 + 版本 + 出处。
 * 刻意做得**简洁**（用户的要求）：不放说明文档（那些在 README 与「设定」页里）。
 */
function renderAboutTab() {
    const host = panel?.querySelector('.sd-about-tab');
    if (!host) return;
    const m = (() => { try { return new URL('manifest.json', import.meta.url).href; } catch { return ''; } })();
    const version = VERSION;
    host.innerHTML = `
        <div class="sd-card sd-about">
            <img class="sd-about-avatar" src="${esc(bundledAvatarUrl())}" alt="喵辉夜" title="喵辉夜">
            <p class="sd-about-name">喵辉夜</p>
            <p class="sd-about-sub">Discord：<b>喵辉夜</b></p>
            <p class="sd-about-note">「故事导演」的作者。有问题、想提要求，Discord 上找我。</p>
        </div>
        <div class="sd-card">
            <div class="sd-card-head"><span class="sd-card-title">这个插件</span><span class="sd-chip">v${esc(version || '?')}</span></div>
            <p class="sd-note">让故事**自己往下走**：自动定篇章、开章、按拍推进，间隙用间章 / 支线 / 插曲填上。<br>
            设计规则与提示词全文都在仓库里（<code>model/</code>），改了什么、为什么改，更新记录里都写了。</p>
            <div class="sd-row">
                <a class="sd-btn sd-about-link" href="https://github.com/SnowIII/story-director" target="_blank" rel="noreferrer">GitHub 仓库</a>
                <a class="sd-btn sd-about-link" href="${esc(m)}" target="_blank" rel="noreferrer">manifest.json</a>
            </div>
            <p class="sd-note sd-dim">代码部分 <b>100% AI 生成</b> —— 不成熟的作者及其产品会带来一定的风险。<br>
            底座与致谢：故事神谕 Story Oracle · 酒馆助手 JS-Slash-Runner · MagVarUpdate（MVU） · ST-Prompt-Template。</p>
        </div>`;
}


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
    if (!s.autoDirector) return '总开关是关着的（面板顶上那个 ⏻）：不会自己调模型；注入与手动按钮照常。';
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
        // ★ 这里的「几轮」也要从就位基准算起 —— 用全聊天历史会让提示说「下一次心跳就开第一章」，
        //   而实际上插件刚接管这个聊天、还想再看两轮。
        const rounds = roundsSinceArmed(rt);
        bits.push(rounds < 3 ? `从接管算起再聊 ${3 - rounds} 轮开第一章` : '下一次心跳就开第一章');
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
    // 审查升级梯的记账（只在真被报过「不合适」时显示，见 handleBeatReview / reviewLadder）
    const chapterId = currentChapterId();
    const strikes = settings().run.reviewStrikesFor === chapterId ? Math.round(toNumber(settings().run.reviewStrikes, 0)) : 0;
    const epicRewrote = settings().run.epicRewroteFor === chapterId;
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
            <div class="sd-row">
                <button type="button" class="sd-btn sd-regen-interlude" title="换一批日常素材（当前这段作废）">换一段间章</button>
                <button type="button" class="sd-btn sd-end-interlude" title="现在收掉间章，接着开主线的新一章">现在回主线</button>
                <button type="button" class="sd-btn sd-next-ilbeat" title="模型忘了写「这个画面演过了」时，手动推进一个">手动推进一个画面</button>
            </div>` : `
            ${arc ? `<p class="sd-sub">${esc(arc)}</p>` : ''}
            ${goal ? `<p class="sd-line"><b>章目标</b>${esc(goal)}</p>` : ''}
            ${scope ? `<p class="sd-line sd-dim"><b>范围</b>${esc(scope)}</p>` : ''}
            <ul class="sd-beats">${beatRows}</ul>
            <div class="sd-row">
                <button type="button" class="sd-btn sd-generate-chapter" title="${title ? '按当前处境重写整章的拍（拍号会回到第 1 拍）' : '按当前处境设计下一章的拍列表'}">${title ? '重新生成本章' : '设计下一章'}</button>
                <button type="button" class="sd-btn sd-force-open" title="跳过等待，现在就定篇章 + 开第一章">立刻开篇</button>
                <button type="button" class="sd-btn sd-next-beat" title="正文模型忘了写「本拍已落」时，手动把它推进一拍">手动推进一拍</button>
                <button type="button" class="sd-btn sd-finish-chapter" title="这一章演够了：标成收尾，之后自动换章或进间章">本章收尾</button>
                <button type="button" class="sd-btn sd-start-interlude" title="主线收尾后的间隙演一段日常（不要求跑完）">开一段间章</button>
            </div>`}
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
                ${statusChip(!!s.autoDirector, s.autoDirector ? '总开关：开' : '总开关：关')}
                ${statusChip(!!mvu(), mvu() ? 'MVU 就绪' : 'MVU 未加载')}
                ${statusChip(typeof oracleApi()?.run === 'function', typeof oracleApi()?.run === 'function' ? '神谕可用' : '神谕不可用')}
                ${statusChip(isGlobalBookEnabled(PLUGIN_WORLD), isGlobalBookEnabled(PLUGIN_WORLD) ? '世界书已挂载' : '世界书未挂载')}
                ${strikes > 0 ? statusChip(false, `这一章第 ${strikes}/${STRIKES_BEFORE_EPIC} 次被报不合适${epicRewrote ? '（已改过篇章）' : ''}`) : ''}
            </div>
            ${history.length ? `<p class="sd-note">已经走过的章：${esc(history.join(' → '))}</p>` : ''}
            <p class="sd-note sd-pacing">${esc(pacingHint())}</p>
            <div class="sd-row">
                <button type="button" class="sd-btn sd-toggle-director">${s.autoDirector ? '关掉总开关' : '打开总开关'}</button>
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
    host.querySelector('.sd-toggle-director')?.addEventListener('click', () => { toggleMaster(); });
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
    if (currentMode() === 'interlude') {
        renderInterludeTab(host);
        return;
    }
    const s = settings();
    const main = mainState();
    const beats = beatsOf(main);
    host.innerHTML = `
        <div class="sd-main-progress" aria-label="当前拍进度">
            <span class="sd-main-progress-label">当前拍</span>
            <strong>${beats.length ? Math.min(currentBeat(main), beats.length) : '—'}</strong>
            <span class="sd-main-progress-total">/ ${beats.length || '—'}</span>
        </div>
        <div class="sd-card">
            <div class="sd-card-head"><span class="sd-card-title">主线（一章一拍地演）</span></div>
            <label class="sd-field"><span>章标题</span><input name="main-title" value="${esc(String(unwrap(main[MAIN_TITLE]) ?? ''))}"></label>
            <label class="sd-field"><span>分卷（这一章属于哪一部）</span><input name="main-arc" value="${esc(String(unwrap(main[MAIN_ARC]) ?? ''))}"></label>
            <label class="sd-field"><span>章目标（写成矛盾的走向：局面从什么样变成什么样）</span><textarea name="main-goal" rows="2">${esc(String(unwrap(main[MAIN_GOAL]) ?? ''))}</textarea></label>
            <label class="sd-field"><span>范围（不写什么）</span><textarea name="main-scope" rows="2">${esc(String(unwrap(main[MAIN_SCOPE]) ?? ''))}</textarea></label>
            <label class="sd-field"><span>拍（一行一拍，<code>1. …</code> 起头）</span><textarea name="main-beats" rows="8">${esc(beats.map((text, index) => `${index + 1}. ${text}`).join('\n'))}</textarea></label>
            <div class="sd-row">
                <button type="button" class="sd-btn sd-save-main">保存这一章</button>
                <button type="button" class="sd-btn sd-generate-chapter" title="按当前处境重写整章的拍 —— 拍号会回到第 1 拍">重新生成本章</button>
                <button type="button" class="sd-btn sd-regen-rest" title="不动已经演过的拍，只把第 ${currentBeat(main)} 拍起的剩余内容重新设计">只重排剩下的拍</button>
            </div>
            <p class="sd-note">⚠ <b>重新生成本章</b>会把拍号退回第 1 拍（整章重演）；只想改后面几拍就用<b>只重排剩下的拍</b>。</p>
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
    host.querySelector('[name="chapters-per-epic"]')?.addEventListener('change', (event) => {
        settings().chaptersPerEpic = Math.max(1, Math.min(12, Math.round(toNumber(event.target.value, 4))));
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
            <label class="sd-switch"><input name="auto-director" type="checkbox"> <b>总开关</b>（面板顶上的 ⏻，关掉＝只手动生成与采用，插件不再自己调模型）</label>
            <label class="sd-switch"><input name="auto-beat" type="checkbox"> 自动换拍（当前拍落了就进入下一拍）</label>
            <label class="sd-switch"><input name="auto-chapter" type="checkbox"> 自动换章（章目标达成后请神谕开下一章）</label>
            <label class="sd-switch"><input name="auto-thread" type="checkbox"> 自动续支线</label>
            <label class="sd-switch"><input name="auto-interlude" type="checkbox"> 自动加插曲（不占幕的随机小段）</label>
            <label class="sd-switch"><input name="auto-interlude-chapter" type="checkbox"> <b>主线收尾后自动开「间章」</b>（间隙演日常，不让场子空着）</label>
            <label class="sd-switch"><input name="auto-redesign" type="checkbox"> 拍站不住时重新设计（正文模型报「调整 / 驳回」）</label>
            <p class="sd-sub">审查的升级梯：**重排剩下的拍** → 仍然报错就**废掉整章重建** → 再报错就**重设篇章这一段**。</p>
            <div class="sd-row">
                <label class="sd-field"><span>两次自动重排之间至少隔几轮（节流）</span><input name="redesign-gap" type="number" min="0" max="30" step="1"></label>
            </div>
            <div class="sd-row">
                <label class="sd-field"><span>每多少轮加一条支线</span><input name="thread-every" type="number" min="1" max="200" step="1"></label>
                <label class="sd-field"><span>每多少轮加一条插曲</span><input name="interlude-every" type="number" min="1" max="200" step="1"></label>
                <label class="sd-field"><span>一拍至少演几轮才允许换拍（<b>想慢就调大</b>；1 = 不刹车）</span><input name="min-replies" type="number" min="0" max="20" step="1"></label>
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
            <p class="sd-note"><b>总开关</b>关掉后，插件不再自己调模型，但注入与变量回报照常 —— 你可以只在需要时点按钮。
            每次自动生成都是一次真实的模型调用，节奏调太密会费 token。<br>
            一轮 = 一条 AI 回复（不看墙钟）；「任意两次生成的最小间隔」跨线生效。下一次什么时候能生成，看「当前」页的导演状态。</p>
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
            <label class="sd-switch"><input name="auto-epic" type="checkbox"> <b>自动定篇章</b>（先有一部完整的大故事，再开第一章）</label>
            <label class="sd-switch"><input name="audit-epic" type="checkbox"> <b>每章演完后检查一次篇章</b>（趁间章做，只判断、默认不改；一部一次/章）</label>
            <label class="sd-field"><span>一个篇章写几章（1~12；写满这一部就收尾、换新的一部）</span><input name="chapters-per-epic" type="number" min="1" max="12" step="1" value="${esc(String(chaptersPerEpic()))}"></label>
            <p class="sd-note">章数决定这一部多大：4 章左右最稳（太短撑不起大高潮，太长会松散）。定篇章花一次调用。<br>
            <b>篇章不会自己变</b>：只有正文模型**在同一章里累计三次**报「当前主线不合适」，或者你在「篇章」页手动点，才会改到它。</p>
            <label class="sd-field"><span>世界书档位（影响这本世界书在酒馆里的注入）</span><select name="book-mode">
                ${Object.entries(BOOK_MODES).map(([key, item]) => `<option value="${key}">${esc(item.label)}</option>`).join('')}
            </select></label>
            <label class="sd-switch"><input name="auto-install-book" type="checkbox"> 缺失时自动安装自带世界书</label>
            <label class="sd-switch"><input name="auto-update-book" type="checkbox"> <b>内容有更新时自动重装</b>（按版本标记比对；<b>旧内容会先备份</b>）</label>
            <p class="sd-note">规则与变量契约都在自带世界书里，我们改了它就会升版本号 —— 开着这项就不用每次手点「安装／重装」。
            更新前会把酒馆里那份**原样备份**成「${esc(PLUGIN_WORLD)}（更新前备份 …）」，你可以随时对照或删掉。</p>
            <label class="sd-switch"><input name="auto-mount-book" type="checkbox"> 安装后挂到全局世界书</label>
            <label class="sd-switch"><input name="book-unmount-on-off" type="checkbox"> <b>关总开关时顺手摘掉全局挂载</b>（开回来时自动挂回去）</label>
            <p class="sd-note">世界书是**酒馆**在注入的，不归插件管：总开关关掉后，那本契约还会每轮塞「你会收到幕后演出计划」，
            模型于是在等一份不会来的计划。开着这项就在关掉时一并摘掉 —— 只摘**我们挂的那一次**，
            你本来没挂、或你自己摘的，开回来时不会擅自挂上。</p>
            <div class="sd-row">
                <button type="button" class="sd-btn sd-install-book">安装／重装自带世界书</button>
                <button type="button" class="sd-btn sd-mount-book">挂载到全局世界书</button>
                <button type="button" class="sd-btn sd-refresh-book">刷新列表</button>
            </div>
            <p class="sd-note"><b>老存档的字段名</b>：0.21.1 之前长线那一句在变量里叫「总纲」，现在叫「篇章」。
            插件会自动迁移（两个存放位置都过一遍）；要是变量面板上还写着「总纲」，点一下右下角这个按钮。</p>
            <div class="sd-row"><button type="button" class="sd-btn sd-migrate-keys">把老字段名「总纲」改成「篇章」</button></div>
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
            // ★ 总开关**只有一条实现**（见 setMaster）：面板顶上的 ⏻ 与这里的勾是同一个开关，
            //   连「顺手摘挂世界书」也必须一起走，否则两条路的行为会不一致。
            if (key === 'autoDirector') { setMaster(node.checked); return; }
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
    bind('audit-epic', 'auditEpic');
    bind('transcript-limit', 'transcriptLimit', 'value');
    bind('auto-install-book', 'autoInstallBook');
    bind('auto-update-book', 'autoUpdateBook');
    bind('auto-mount-book', 'autoMountBook');
    bind('book-unmount-on-off', 'bookUnmountOnOff');
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
    host.querySelector('.sd-migrate-keys')?.addEventListener('click', () => {
        void migrateLegacyKeysBothScopes({ notify: true });
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
    // 0.27.3：旧存档可能还记着已删除的「间章」页签，统一回到主线页；间章内容会在这里替换主线。
    if (s.tab === 'interlude') {
        s.tab = 'main';
        save();
    }
    panel.querySelectorAll('.sd-tab').forEach((button) => {
        button.classList.toggle('is-active', button.dataset.tab === s.tab);
    });
    panel.querySelectorAll('.sd-page').forEach((page) => {
        page.hidden = page.dataset.tab !== s.tab;
    });
    if (s.tab === 'now') renderNowTab();
    if (s.tab === 'epic') renderEpicTab();
    if (s.tab === 'main') renderMainTab();
    if (s.tab === 'side') renderSideTab();
    if (s.tab === 'set') renderSetTab();
    if (s.tab === 'about') renderAboutTab();
}

/**
 * ★ **总开关**（0.24.0）：一键让插件停止「自己调模型」。
 *
 * 为什么要有它：插件是**全局**的 —— 切到别的聊天它照样会按自己的判断动手。用户报的
 * 「一切到别的聊天先生了个总纲，造成不必要的浪费」就是这么来的。
 * 「设定」页里其实一直有「自动导演」这个总闸，但它藏在最深处，面板上连个一眼可见的入口都没有，
 * 等发现烧钱了再去翻设置已经晚了。
 *
 * 语义（与 `DEFAULT.autoDirector` 一致）：**关 = 只手动生成与采用**，
 * 插件不自己定篇章 / 开章 / 换拍 / 补支线 / 补插曲 / 审查重排；
 * **注入照常**（那不需要调模型，关掉反而会让正文模型失去引导）。
 *
 * ⚠ 与它配套的是「就位基准」（`run.armedAt`）：从关拨到开时会**重新就位** ——
 *   否则在一个已经聊了几百楼的聊天里打开它，第一轮心跳就会立刻烧一次生成。
 */
function toggleMaster(force) {
    setMaster(force === undefined ? !settings().autoDirector : !!force);
}

/**
 * 总开关的**唯一实现**（面板顶上的 ⏻ 与「设定」页那个勾都走它）：
 * 改字段 → 重新就位 → 顺手摘挂世界书 → 存盘 → 同步注入 → 重画。
 */
function setMaster(want, { notify = true } = {}) {
    const s = settings();
    const next = !!want;
    if (!!s.autoDirector === next) return false;
    s.autoDirector = next;
    // ★ 拨到「开」＝**重新就位**（见 run.armedAt）：否则在一个已经聊了几百轮的聊天里
    //   打开它，第一轮心跳就会立刻烧一次生成。
    if (next) armNow(s.run);
    // ★ 0.27.7：关掉时顺手把自带世界书从全局挂载里摘掉，开回来时再挂回去（用户提的）。
    const bookNote = syncBookWithMaster(next);
    save();
    syncMainInjection();
    render();
    if (notify) {
        toast(next
            ? `总开关已打开：插件会自己推进剧情（定篇章 / 开章 / 换拍 / 支线 / 插曲）。${bookNote}`
            : `总开关已关闭：不再自己调模型（不再花钱）；注入与手动按钮照常。${bookNote}`,
        next ? 'success' : 'info');
    }
    return true;
}

/**
 * ★ 总开关 ↔ 自带世界书的全局挂载（0.27.7，用户提的）。
 *
 * 用户的原话：「再点那个关插件的总开关后，会自动取消世界书的全局挂载，开启再自动挂回来」。
 *
 * 为什么这件事非做不可：**世界书是酒馆在注入的，不归插件管**。
 * 插件停了，那本契约还挂在全局、每一轮都往上下文里塞「你会收到故事导演的幕后演出计划」——
 * 于是关掉之后聊天反而更别扭：模型在等一份永远不会来的计划。
 *
 * ⚠ 「开回来时挂回去」只做**我们摘掉的那一次**（`bookMountedBySwitch` 记账）：
 *   本来就没挂（用户不需要它）或用户自己摘的，都不该被我们偷偷挂上。
 *
 * @returns {string} 给 toast 补的一句说明（没动世界书时是空串）
 */
function syncBookWithMaster(on) {
    const s = settings();
    if (s.bookUnmountOnOff === false) return '';       // 用户把这条自动行为关了
    try {
        if (!on) {
            if (!isGlobalBookEnabled(PLUGIN_WORLD)) { s.bookMountedBySwitch = false; return ''; }
            setGlobalBook(PLUGIN_WORLD, false);
            s.bookMountedBySwitch = true;
            console.info(`[故事导演] 总开关关闭：顺手把世界书「${PLUGIN_WORLD}」从全局挂载摘掉了（开回来时会挂回）。`);
            return `世界书「${PLUGIN_WORLD}」已从全局挂载摘掉（开回来会自动挂上）。`;
        }
        if (!s.bookMountedBySwitch) return '';          // 不是我们摘的 → 不擅自挂
        setGlobalBook(PLUGIN_WORLD, true);
        s.bookMountedBySwitch = false;
        console.info(`[故事导演] 总开关打开：把世界书「${PLUGIN_WORLD}」挂回全局。`);
        return `世界书「${PLUGIN_WORLD}」已挂回全局。`;
    } catch (error) {
        console.debug('[故事导演] 随总开关摘挂世界书失败', error);
        return '';
    }
}

/**
 * 「正在生成」那一条（0.27.6，用户提的）。
 *
 * 为什么放在**总开关那一条**里：它是 sticky、且切到哪个页签都在 —— 生成可能要几十秒，
 * 用户切到别的页去填个设定，回来还得能一眼看见「它还在跑」，并且随时能掐掉。
 *
 * 显示三件事：**在生成什么**（篇章检查 / 下一章 / 间章…）、**已等了多少秒**（会自己走，
 * 否则静止的文字看着像卡死）、以及流式时**已收到多少字**（真的在动）。
 */
function renderBusyBar() {
    const host = panel?.querySelector('.sd-busybar');
    if (!host) return;
    if (!storyGenerating) {
        host.hidden = true;
        host.innerHTML = '';
        return;
    }
    const secs = Math.max(0, Math.round((Date.now() - (genStartedAt || Date.now())) / 1000));
    const chars = genChars > 0 ? `<span class="sd-busy-meta">· 已收 ${genChars} 字</span>` : '';
    host.hidden = false;
    host.innerHTML = `
        <span class="sd-busy-spin" aria-hidden="true"></span>
        <span class="sd-busy-text">正在生成<b>${esc(genLabel || '剧情')}</b>…</span>
        <span class="sd-busy-meta">${secs}s</span>
        ${chars}
        <button type="button" class="sd-btn sd-busy-stop" title="掐断这次模型请求（已经发出的请求会被中止，不等它跑完）">中断</button>`;
    host.querySelector('.sd-busy-stop')?.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        abortGenerate();
    });
}

/** 画总开关那一条（在面板最上面，切到哪个页都看得见）。 */
function renderPower() {
    const host = panel?.querySelector('.sd-powerbar');
    if (!host) return;
    const on = !!settings().autoDirector;
    host.classList.toggle('is-off', !on);
    host.innerHTML = `
        <button type="button" class="sd-power" aria-pressed="${on ? 'true' : 'false'}"
            title="${on ? '点一下 = 关掉总开关：插件不再自己调模型' : '点一下 = 打开总开关：插件会自己推进剧情'}">
            <span class="sd-power-dot">⏻</span>
            <span class="sd-power-label">总开关 · ${on ? '开' : '关'}</span>
        </button>
        <span class="sd-power-hint">${on
            ? '它正在自己推进：定篇章 / 开章 / 换拍 / 支线 / 插曲。不想让它烧，就点左边关掉。'
            : '已关：不会自己调模型（不花钱）。注入与手动按钮照常 —— 点左边重新打开。'}</span>`;
    host.querySelector('.sd-power')?.addEventListener('click', () => { toggleMaster(); });
    renderBusyBar();
}

function render() {
    if (!panel) return;
    renderPower();
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
    if (!window.confirm('清空这个故事的主线、支线与插曲？故事状态会被重置（角色卡自己的变量不受影响）。')) return;
    await patchMain({ ...emptyMain() });
    const s = settings();
    s.chapters = {};
    s.story = {};                    // 计划整个清掉（0.26.0 起它住在插件里）
    s.run = JSON.parse(JSON.stringify(DEFAULT.run));
    s.run.chatId = chatKey();
    save();
    // MVU 那边只留 token 骨架：把它也复位，免得模型看到上一局留下的「本拍已落」
    const api = mvu();
    const d = mvuData();
    if (api?.replaceMvuData && isPlainObject(d?.stat_data)) {
        d.stat_data[NS] = {};
        try { await writeMvu(d); } catch { /* ignore */ }
    }
    await pushTokens();
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
        // ⚠ `justAborted()` 只用来「压掉失败提示 / 不再往下走」，**绝不能当进门闸** ——
        //   用户掐掉之后立刻再点一次「立刻开篇」是完全正常的操作（探针抓到过这个 bug）。
        if (!ok) {
            if (justAborted()) return;
            toast('篇章没做成 —— 但可以照样开章（它只是配料）。', 'warning');
        }
    }
    if (epicStarted(epicOf(rootOf()))) {
        await patchMain({ [MAIN_CLOSED]: false }, {});
    }
    // ★ 0.27.3：「立刻开篇」是**从第一拍开始**的入口，同样必须整章重来（别继承上一章的拍号）。
    const opened = await generateChapter({ quiet: false, force: true, restart: true });
    if (!opened && justAborted()) return;   // 用户中断：不记失败、不弹错
    noteAttempt(opened, opened ? '' : '见控制台日志');
    if (!opened) toast('开章失败 —— 控制台里有 [故事导演] 的原始回复，发给我看看。', 'error');
    syncMainInjection();
    if (!panel?.hidden) render();
}

/**
 * 把老存档的旧字段名改掉。
 *   · `史诗.总纲`   → `史诗.篇章`    （0.21.1）
 *   · `史诗.走向`   → `史诗.章内容`  （0.22.0：阶段思维 → 章表）
 *   · 清掉已废弃的 `史诗.当前进程` / `史诗.赌注`
 *
 * 0.26.0 起计划住在**插件里**（`story`），所以真正要修的是那一份；
 * MVU 那边顺手也过一遍（老版本留下的计划字段可能还赖在变量里，清干净免得模型看到过期货）。
 *
 * @returns {Promise<{story: object|null, message: object|null, chat: object|null, changed: boolean}>}
 */
async function migrateLegacyKeysBothScopes({ notify = false } = {}) {
    const api = mvu();
    const report = { story: null, message: null, chat: null, pace: null, changed: false };
    // ③′ 换拍刹车：0.27.2 默认 `minReplies = 3`。旧存档里常见 1 或 2，
    //    光改默认值影响不到他们。用版本标记而不是旧的布尔标记，确保 0.27.1 已迁移过的存档也能升级一次。
    {
        const s = settings();
        if (!s.paceFixed || s.paceFixedVersion !== '0.27.2') {
            s.paceFixed = true;
            s.paceFixedVersion = '0.27.2';
            if (Math.round(toNumber(s.minReplies, 1)) <= 2) {
                const from = Math.round(toNumber(s.minReplies, 1));
                s.minReplies = 3;
                report.pace = { from, to: 3 };
                report.changed = true;
                console.info('[故事导演] 换拍刹车已调到「一拍至少演 3 轮」（想更慢就去设定页调大）。');
            }
            save();
        }
    }
    // ① 插件侧的计划（真正在用的那一份）
    try {
        const r = migrateEpicKeys(storyNs());
        report.story = r;
        if (r.changed) { save(); report.changed = true; }
    } catch (error) {
        console.debug('[故事导演] 迁移插件侧字段名失败', error);
    }
    // ② MVU 里可能残留的老字段（0.26.0 之前的存档）
    if (typeof api?.getMvuData === 'function' && typeof api?.replaceMvuData === 'function') {
        for (const [label, opts] of [['message', { type: 'message', message_id: 'latest' }], ['chat', { type: 'chat' }]]) {
            try {
                const d = api.getMvuData(opts);
                const ns = d?.stat_data?.[NS];
                if (!isPlainObject(ns)) continue;
                const r = migrateEpicKeys(ns);
                if (!r.changed) { report[label] = r; continue; }
                await api.replaceMvuData(d, opts);
                report[label] = r;
                report.changed = true;
            } catch (error) {
                console.debug(`[故事导演] 迁移「${label}」作用域的字段名失败`, error);
            }
        }
    }
    if (report.changed) {
        syncMainInjection();
        if (panel && !panel.hidden) render();
    }
    if (notify) {
        const done = Object.entries(report)
            .filter(([k, v]) => !['changed'].includes(k) && v?.changed)
            .map(([k, v]) => `${k === 'message' ? '当前楼层' : k === 'chat' ? '聊天级' : '插件里'}${v.renamed ? '（总纲 → 篇章）' : '（清掉旧键）'}`);
        toast(done.length
            ? `老字段名已迁移：${done.join('；')}。`
            : '没有需要迁移的旧字段 —— 已经是「篇章」了。', done.length ? 'success' : 'info');
        console.info('[故事导演] 字段名迁移结果', report);
    }
    return report;
}

/**
 * 排查用入口：`window.__storyDirector.why()` 会告诉你**现在为什么还没有开篇 / 卡在哪**。
 * 只读，不改任何状态 —— 面版里的说明与它是同一份逻辑。
 * `migrate()` 是唯一的写操作：把老存档的 `总纲` 改成 `篇章`（两个存放位置都过一遍）。
 */
function exposeDiagnostics() {
    try {
        window.__storyDirector = {
            version: () => VERSION,
            why: () => firstChapterBlocker(),
            oracle: () => oracleCompatReport(),
            forceOpen: () => forceOpenStory(),   // 排查用：立刻走一遍「定篇章 + 开章」全路径
            migrate: () => migrateLegacyKeysBothScopes({ notify: true }),   // 老存档字段名迁移（见 0.21.1/0.21.2）
            // ★ 0.27.6：中断这次生成（面板上那个「中断」按钮走的就是它）+ 查一下现在在生成什么。
            abort: () => { abortGenerate(); return true; },
            generating: () => ({ 生成中: storyGenerating, 在生成什么: genLabel, 已等秒数: genStartedAt ? Math.round((Date.now() - genStartedAt) / 1000) : 0, 已收字数: genChars, 支持中断: typeof genCtl?.abort === 'function' }),
            // ★ 0.27.7：总开关（面板 ⏻ 与设定页那个勾是同一个）。排查「世界书为什么被摘了」用它。
            master: (want) => setMaster(!!want),
            book: () => ({
                已全局挂载: isGlobalBookEnabled(PLUGIN_WORLD),
                是我们随总开关摘的: !!settings().bookMountedBySwitch,
                随总开关摘挂: settings().bookUnmountOnOff !== false,
            }),
            epicKeys: () => {
                const box = epicOf(rootOf()) ?? {};
                return { 内存里读到的键: Object.keys(box), 说明: '「篇章」是新名字；「总纲」是旧名字（只读兼容用，不该再出现在变量里）' };
            },
            state: () => {
                const main = mainState();
                const chapter = interludeChapterOf(rootOf());
                return {
                    mode: currentMode(),
                    拍数: beatsOf(main).length,
                    当前拍: currentBeat(main),
                    章名: String(unwrap(main[MAIN_TITLE]) ?? '').trim(),
                    章目标达成: truthy(main[KEY_CHAPTER_DONE]),
                    可进下一章: truthy(main[KEY_READY]),
                    已收尾: truthy(main[MAIN_CLOSED]),
                    间章进行中: truthy(chapter[IL.active]),
                    // ⚠ 这两个键改动名之后**不能再叫同一个名字**（同名会互相覆盖）：
                    //   史诗的**名字** vs 史诗**校准到第几章**，分开写清。
                    篇章名: epicStarted(epicOf(rootOf())) ? String(unwrap(epicOf(rootOf())[EP.title]) ?? '') : '',
                    这一部共几章: epicChapterCount(epicOf(rootOf())),
                    这一部已写几章: epicChapter(epicOf(rootOf())),
                    这一部写完没有: epicFinished(epicOf(rootOf())),
                    大高潮: epicClimax(epicOf(rootOf())),
                    // ★ 0.26.0：计划住在插件里（`story`），MVU 只留 token —— 这里把两边都摊开。
                    //   「插件的」出现 有没有:false，说明这一局还没内容（会从 MVU 搬，或重新定）。
                    插件里的剧情状态: {
                        有没有: nsHasState(settings().story),
                        篇章名: String(unwrap((settings().story?.[EPIC] || {})[EP.title]) ?? ''),
                        拍数: beatsOf(mainOf({ [NS]: settings().story || {} })).length,
                    },
                    MVU里的token: Object.fromEntries(TOKEN_PUSH.map((p) => [p, getPath({ [NS]: mvuData()?.stat_data?.[NS] || {} }, `${NS}.${p}`)])),
                    // ★ 0.27.0：给正文模型的自由裁量权 + 篇章检查，都在这儿看得见。
                    待补的铺垫: settings().run.setupNote || '',
                    上一轮的微调回执: settings().run.beatNote || '',
                    篇章检查: settings().run.lastAudit || null,
                    定篇章已试: Math.round(toNumber(settings().run.epicTries, 0)),
                    // ★ 审查升级梯的记账（用户报「大纲自己变了」时，先看这三个数）：
                    //   同一章累计 3 次「不合适」才会去改篇章，而且**同一章最多改一次**。
                    审查: {
                        这一章的身份: currentChapterId(),
                        这一章收到的不合适次数: Math.round(toNumber(settings().run.reviewStrikes, 0)),
                        这一章已经改过篇章: settings().run.epicRewroteFor === currentChapterId(),
                        需要几次才改篇章: STRIKES_BEFORE_EPIC,
                        两次重排至少隔几轮: Math.round(toNumber(settings().redesignGap, 3)),
                    },
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

/**
 * 间章界面 —— 它**住在「主线」页里**（0.27.3）：页签只剩一个「主线」，
 * 进间章时这一页整块换成间章内容，主线编辑区收起来。这样用户只有一个地方要看，
 * 也不会再误以为「间章和主线是两条在同时推进的线」。
 */
function renderInterludeTab(host = panel?.querySelector('.sd-main-tab')) {
    if (!host) return;
    const chapter = interludeChapterOf(rootOf());
    const beats = interludeBeatsOf(chapter);
    const beat = interludeBeat(chapter);
    const history = completedMainTitles(rootOf());
    const title = String(unwrap(chapter[IL.title]) ?? '').trim();
    const scene = String(unwrap(chapter[IL.scene]) ?? '').trim();
    const note = String(unwrap(chapter[IL.note]) ?? '').trim();
    const playedAll = beats.length > 0 && beat > beats.length;

    host.innerHTML = `
        <div class="sd-main-progress" aria-label="当前日常画面进度">
            <span class="sd-main-progress-label">当前画面</span>
            <strong>${beats.length ? Math.min(beat, beats.length) : '—'}</strong>
            <span class="sd-main-progress-total">/ ${beats.length || '—'}</span>
        </div>
        <div class="sd-card sd-card-main">
            <div class="sd-card-head">
                <span class="sd-card-title">间章${title ? ` · ${esc(title)}` : ''}</span>
                <span class="sd-chip is-busy">进行中</span>
            </div>
            <p class="sd-note">间章是**与主线互斥**的另一种幕：主线收尾后的间隙交给它，演日常、顺手埋伏笔。
            与主线最大的区别是**它不要求跑完** —— 下面的日常画面只是素材，谁都可以跳过；写到合适的地方就收，随时回主线。</p>
            ${scene ? `<p class="sd-sub">场合：${esc(scene)}</p>` : ''}
            <label class="sd-field"><span>标题</span><input name="il-title" value="${esc(String(unwrap(chapter[IL.title]) ?? ''))}"></label>
            <label class="sd-field"><span>场合</span><input name="il-scene" value="${esc(String(unwrap(chapter[IL.scene]) ?? ''))}"></label>
            <label class="sd-field"><span>日常画面（一行一个，可写 <code>1. …</code>）</span><textarea name="il-beats" rows="5">${esc(beats.map((text, index) => `${index + 1}. ${text}`).join('\n'))}</textarea></label>
            ${playedAll || note ? `<p class="sd-note">${playedAll ? '素材都演过了，可以回主线了。' : ''}${note ? `${playedAll ? '　' : ''}顺手埋的线：${esc(note)}` : ''}</p>` : ''}
            <div class="sd-row">
                <button type="button" class="sd-btn sd-save-interlude">保存这段间章</button>
                <button type="button" class="sd-btn sd-next-ilbeat">手动推进一个画面</button>
                <button type="button" class="sd-btn sd-end-interlude">现在回主线</button>
                <button type="button" class="sd-btn sd-regen-interlude">换一段间章</button>
            </div>
        </div>
        ${history.length ? `<div class="sd-card"><div class="sd-card-head"><span class="sd-card-title">走过的章</span></div><p class="sd-note">${esc(history.join(' → '))}</p></div>` : ''}`;

    host.querySelector('.sd-save-interlude')?.addEventListener('click', () => { void saveInterludeFromForm(); });
    host.querySelector('.sd-next-ilbeat')?.addEventListener('click', () => { void manualAdvanceInterludeBeat(); });
    host.querySelector('.sd-end-interlude')?.addEventListener('click', () => { void endInterludeNow(); });
    host.querySelector('.sd-regen-interlude')?.addEventListener('click', () => { void generateInterludeChapter({ quiet: false, force: true }); });
}

/** 保存间章手改（标题 / 场合 / 日常画面）。 */
async function saveInterludeFromForm() {
    const host = panel?.querySelector('.sd-main-tab');
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

/**
 * 「已完结的篇章（归档）」折叠块 —— 0.27.8（用户提的：归档的篇章「仅在特定页面显示」）。
 *
 * 归档的篇章**不再参与提示词注入**（见 focusedStateBlock / antiRepeatBlock），
 * 想看它演过什么、大高潮落在哪、留下了哪些既成事实，就在这里看。
 * ⚠ 大高潮默认折起来并标「会剧透」——与「篇章」页其它地方同一条纪律。
 */
function archivedEpicSection() {
    const list = Array.isArray(settings().run.retiredEpics) ? settings().run.retiredEpics : [];
    if (!list.length) return '';
    const items = list.slice().reverse().map((item) => {
        const title = String(item?.title ?? '').trim() || '（未命名）';
        const chapters = Array.isArray(item?.chapters) ? item.chapters : [];
        const hooks = Array.isArray(item?.hooks) ? item.hooks : [];
        const why = item?.why === 'finished' ? '演义完了' : '被换掉';
        const when = (() => {
            const t = Date.parse(String(item?.at ?? ''));
            return Number.isFinite(t) ? new Date(t).toLocaleDateString() : '';
        })();
        const climax = String(item?.climax ?? '').trim();
        const ledger = String(item?.ledger ?? '').trim();
        return `<div class="sd-item">
            <div class="sd-item-head">
                <b>《${esc(title)}》</b>
                <span class="sd-chip">${esc(why)}${item?.written ? ` · 写了 ${esc(String(item.written))} 章` : ''}</span>
                ${when ? `<span class="sd-chip">${esc(when)}</span>` : ''}
            </div>
            ${ledger ? `<p class="sd-line"><b>既成事实</b>${esc(ledger)}</p>` : ''}
            ${hooks.length ? `<p class="sd-line sd-dim"><b>伏笔</b>${esc(hooks.join('；'))}</p>` : ''}
            ${(chapters.length || climax) ? `<details class="sd-fold sd-spoiler">
                <summary>章表 / 大高潮（${chapters.length} 章${climax ? ' · 大高潮已定' : ''}）· 点开看内容<b>（会剧透）</b></summary>
                <div class="sd-fold-body">
                    ${climax ? `<p class="sd-line"><b>大高潮</b>${esc(climax)}</p>` : ''}
                    <ol class="sd-beats">${chapters.map((text) => `<li class="sd-beat">${esc(String(text))}</li>`).join('')}</ol>
                </div>
            </details>` : ''}
        </div>`;
    }).join('');
    return `<details class="sd-fold">
        <summary>已完结的篇章（归档 · ${list.length} 部）</summary>
        <div class="sd-fold-body">
            <p class="sd-note">这些篇章**已经收场**，不再参与提示词注入 —— 只在这里留档（也用来让新的篇章避开它们的套路）。</p>
            ${items}
        </div>
    </details>`;
}

function renderEpicTab() {
    const host = panel?.querySelector('.sd-epic-tab');
    if (!host) return;
    const s = settings();
    const epic = epicOf(rootOf());
    const started = epicStarted(epic);
    const chapters = epicChapters(epic);
    const hooks = epicHooks(epic);
    const climax = epicClimax(epic);
    const written = epicChapter(epic);
    const total = chapters.length;
    const done = epicFinished(epic);

    host.innerHTML = `
        <div class="sd-card ${started ? 'sd-card-main' : ''}">
            <div class="sd-card-head">
                <span class="sd-card-title">篇章（一部完整的大故事）</span>
                <span class="sd-chip">${started ? (done ? `✔ 这一部 ${total} 章已写完` : `已写 ${written} / 共 ${total} 章`) : '还没有篇章'}</span>
            </div>
            <label class="sd-field"><span>基调（决定这部大故事是什么型的故事；由你选，不由模型判断）</span><select name="tone">
                ${toneOptions().map((item) => `<option value="${esc(item.value)}" ${toneOf(s.tone) === item.value ? 'selected' : ''}>${esc(item.label)}</option>`).join('')}
            </select></label>
            <p class="sd-note"><b>基调</b>是给篇章与每一章的最高优先级创作方针；换完要点一次「重新定篇章（换一部）」才生效。
            这里的<b>章表 / 大高潮 / 伏笔</b>都可以手改 —— 每行一章，<b>✔ 已写 · ▶ 正在写 · · 还没写</b>。</p>
            ${started ? `
                <label class="sd-field"><span>标题</span><input name="epic-title" value="${esc(String(unwrap(epic[EP.title]) ?? ''))}"></label>
                <label class="sd-field"><span>篇章（两三句，说清在争什么）</span><textarea name="epic-line" rows="3">${esc(String(unwrap(epic[EP.line]) ?? ''))}</textarea></label>
                <label class="sd-field"><span>章内容（<b>一章一行</b>：这一章要完成什么。✔ = 已写、▶ = 正在写、· = 还没写）</span>${total ? `<span class="sd-epic-progress">${done ? '这一部已经写完 —— 点「重新定篇章（换一部）」开新的一部' : `下一章是第 ${written + 1} 章`}</span>` : ''}<textarea name="epic-chapters" rows="${Math.max(4, total + 1)}">${esc(chapters.map((text, i) => `${i + 1}. ${text}`).join('\n'))}</textarea></label>
                <details class="sd-fold sd-spoiler">
                    <summary>大高潮（${climax ? '已定' : '还没定'}）· 点开看内容<b>（会剧透）</b></summary>
                    <label class="sd-field"><span>落在第几章、是哪一场</span><input name="epic-climax" value="${esc(climax)}" placeholder="例如：第 3 章 · 武道会决赛那场"></label>
                </details>
                <label class="sd-field"><span>伏笔（用「；」分开）</span><textarea name="epic-hooks" rows="2">${esc(hooks.join('；'))}</textarea></label>
                <label class="sd-field"><span>既成事实（不可撤销）</span><textarea name="epic-ledger" rows="2">${esc(String(unwrap(epic[EP.ledger]) ?? ''))}</textarea></label>
                <div class="sd-row">
                    <button type="button" class="sd-btn sd-save-epic">保存篇章</button>
                    <button type="button" class="sd-btn sd-evolve-epic">按现在的情况重新校准</button>
                    <button type="button" class="sd-btn sd-rebuild-epic">重新定篇章（换一部）</button>
                </div>
                ${done ? '<p class="sd-note">✔ 这一部的章表已经全部写完 —— 下一章开始时会自动请神谕<b>定下一部篇章</b>（也可以现在点「重新定篇章」）。</p>' : ''}` : `
                <div class="sd-row">
                    <button type="button" class="sd-btn sd-rebuild-epic">现在定一部篇章</button>
                </div>
                <p class="sd-note">${s.autoEpic ? '自动：聊满 2 轮、还没有拍列表时，会自动定篇章，然后才开第一章。' : '自动定篇章是关着的：只在「设定」页打开，或点上面的按钮。'}</p>`}
        </div>
        ${archivedEpicSection()}`;

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
        void openEpicDialog({ mode: 'evolve', entry: written });
    });
    host.querySelector('.sd-rebuild-epic')?.addEventListener('click', () => {
        void openEpicDialog({ mode: 'establish', entry: 0 });
    });
}

/** 保存篇章手改。 */
async function saveEpicFromForm() {
    const host = panel?.querySelector('.sd-epic-tab');
    if (!host) return;
    const chapters = splitBeats(host.querySelector('[name="epic-chapters"]')?.value || '');
    const hooks = String(host.querySelector('[name="epic-hooks"]')?.value || '')
        .split(/[；;\n]/).map((text) => text.trim()).filter(Boolean);
    await patchEpic({
        [EP.title]: String(host.querySelector('[name="epic-title"]')?.value || '').trim(),
        [EP.line]: String(host.querySelector('[name="epic-line"]')?.value || '').trim(),
        [EP.chapters]: chapters,
        [EP.climax]: String(host.querySelector('[name="epic-climax"]')?.value || '').trim(),
        [EP.hooks]: hooks,
        [EP.ledger]: String(host.querySelector('[name="epic-ledger"]')?.value || '').trim(),
        [EP.updated]: new Date().toISOString(),
    });
    syncMainInjection();
    render();
    toast(`篇章已保存（章表 ${chapters.length} 章）。`, 'success');
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
            <button type="button" class="sd-close" title="关闭">✕</button>
        </div>
        <nav class="sd-tabs" aria-label="故事导演页面">
            ${TABS.map(([key, label]) => `<button type="button" class="sd-tab" data-tab="${key}">${esc(label)}</button>`).join('')}
        </nav>
        <div class="sd-body">
            <div class="sd-powerbar"></div>
            <div class="sd-busybar" hidden></div>
            <section class="sd-page sd-now-tab" data-tab="now"></section>
            <section class="sd-page sd-epic-tab" data-tab="epic" hidden></section>
            <section class="sd-page sd-main-tab" data-tab="main" hidden></section>
            <section class="sd-page sd-side-tab" data-tab="side" hidden></section>
            <section class="sd-page sd-set-tab" data-tab="set" hidden></section>
            <section class="sd-page sd-about-tab" data-tab="about" hidden></section>
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
        // ★ 老存档的旧字段名（`史诗.总纲`）改掉 —— 两个存放位置都过一遍（见 0.21.1 的事故说明）。
        void migrateLegacyKeysBothScopes();
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
