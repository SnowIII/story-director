/**
 * 故事导演 · 纯逻辑层
 *
 * 这里只放**不碰 DOM、不碰酒馆 API** 的纯函数：类型判断、拍解析、区块解析、
 * 注入文案渲染、MVU 命令的解析与套用。index.js 负责所有副作用（事件、面板、模型调用）。
 *
 * 结构对应世界书「故事导演」里 [mvu_update] 故事导演变量规则 的定义：
 *   stat_data.故事导演.主线      —— 一条按章推进的线（章 → 拍）
 *   stat_data.故事导演.支线.<id> —— 并行的短支线（一条一拍）
 *   stat_data.故事导演.插曲.<id> —— 幕间小段（一条一拍）
 */

export const NS = '故事导演';

/** MVU 路径前缀。 */
export const PATH = {
  main: `${NS}.主线`,
  /** 与主线互斥的「间章」（一段日常的幕）。 */
  interlude: `${NS}.间章`,
  threads: `${NS}.支线`,
  interludes: `${NS}.插曲`,
};

/** 主线/支线的状态机取值。插曲只有 待演 / 已演。 */
export const STATUS_PENDING = '待演';
export const STATUS_ACTIVE = '进行中';
export const STATUS_DONE = '已完成';
export const STATUS_SKIPPED = '已跳过';
export const STATUS_STALLED = '已收尾';
export const THREAD_STATUSES = [STATUS_PENDING, STATUS_ACTIVE, STATUS_DONE, STATUS_SKIPPED, STATUS_STALLED];

/** 主线里的几个开关字段（AI 写、插件读）。 */
export const KEY_BEAT = '当前拍';
export const KEY_BEAT_DONE = '本拍已落';
export const KEY_CHAPTER_DONE = '章目标达成';
export const KEY_READY = '可进下一章';
export const KEY_REVIEW = '合理性审查';
export const KEY_REVIEW_NOTE = '审查说明';
export const REVIEW_PASS = '通过';
export const REVIEW_ADJUST = '调整';
export const REVIEW_REJECT = '驳回';
export const REVIEW_STATES = [REVIEW_PASS, REVIEW_ADJUST, REVIEW_REJECT];
/** 同一个位置连续被退回几次就停手，免得两个模型互相顶牛。 */
export const REVIEW_MAX_RETRY = 3;

/** 支线字段名（世界书与插件共享的契约）。 */
export const THREAD_FIELDS = {
  title: '标题',
  status: '状态',
  goal: '目标',
  entry: '切入',
  land: '落点',
  due: '时限',
  started: '开始',
  ended: '结束',
  done: '已落',
  note: '备注',
};

export const MAIN_TITLE = '标题';
export const MAIN_ARC = '篇章';
export const MAIN_SCOPE = '范围';
export const MAIN_GOAL = '章目标';
export const MAIN_BEATS = '拍';
export const MAIN_STARTED = '开始';
export const MAIN_ENDED = '结束';
/** 主线这一章是否已经收尾（收尾后进入「间章」时段）。插件写，正文模型只读。 */
export const MAIN_CLOSED = '已收尾';

/**
 * 「史诗」（总纲）—— 围绕 **{{user}}** 的那条长线，跨越**很多章**。
 *
 * 为什么需要它：只按章续写时，模型只能就着眼前写，很容易写出「跟着商队走来走去」这种平铺直叙。
 * 有了总纲，每一章都是这条长线的一拍：章与章之间有「势」，长度上去了才有史诗感。
 *
 * 两条必须同时成立的原则（缺一条就会走偏）：
 *   · **{{user}} 是主角**：总纲写的是「围绕他发生了什么事、他被卷进什么里面、他身边这些人怎么变」。
 *     与他无关的势力动向只作背景与压力，不要喧宾夺主。
 *   · **但不替他行动**：总纲规划的是**世界这边会怎么压过来**，不是「他会怎么做」。
 *     他中途走出剧本是常态 —— 所以总纲要留出「他会不按套路来」的余地，
 *     并且每一个新章开始之前都要按「他实际做了什么」重新校准。
 */
export const EPIC = '史诗';
export const EP = {
  title: '标题',
  line: '总纲',
  movements: '走向',
  hooks: '伏笔',
  ledger: '既成事实',
  stage: '当前进程',
  chapter: '更新到第几章',
  updated: '更新',
};
/** 总纲的进程（英雄之旅的骨架；主角是 {{user}}，所以这套打在他身上）。 */
export const EPIC_STAGES = ['启程', '试炼', '至暗', '转折', '终局'];

/**
 * 基调（tone）：由**用户在下拉里选**，不由模型判断。
 * 基调决定这条长线是什么「型」的故事 —— 冒险有大事件与险境，日常有日常的张力，
 * 推理有谜面与揭破……同一个骨架在不同基调下的内容完全不同。
 *
 * 每条 tone 会作为**最上位的创作方针**塞进总纲提示词（以及章节提示词）。
 * `auto` = 不设基调，沿用世界的自然走向。
 */
export const TONES = {
  auto: {
    label: '自动（按角色卡与当前剧情自己判断）',
    directive: '',
  },
  epic: {
    label: '奇幻 / 异世界 · 冒险史诗',
    directive: [
      '本故事的基调是**冒险史诗**：世界比他的日常大得多，他会被卷进一场超出自己身份的事。',
      '冲突的规模可以很大：国与国、势力与势力、古老的东西醒过来、一整个地方的安危压在他这一路上。',
      '一章的典型形状：**出发 / 接住 → 遭遇人与异象 → 发现事情不对（阴谋的一角）→ 陷进去、付出代价 → 突围或反转 → 得到什么，同时失去什么**。',
      '大场面要写，但**落点永远是人**：谁死了、谁叛了、谁欠了谁、他开始怕什么。',
      '「得到」必须伴随「失去」：拿到东西的同时丢了点什么（同伴、名声、退路、某个人的信任）。',
    ].join('\n'),
  },
  life: {
    label: '都市 / 日常 · 生活中的暗流',
    directive: [
      '本故事的基调是**生活里的暗流**：没有拯救世界，但**一样要有真正在推进的矛盾**——',
      '矛盾来自人：钱、工作、房子、家里的事、旧账、面子、谁欠了谁、谁瞒了谁。',
      '**允许并欢迎轻喜剧调味**：误会、错位、逞强、被当场拆穿、越想圆越乱 —— 但笑点来自局势，不靠谁变蠢。',
      '**「日常」不等于「没有冲突」**：它只是把规模放小、放到人身上。**绝不要写成没有张力的流水账**——',
      '吃饭、买菜、上班各写一遍，却没有一件事在往哪儿去。',
      '一章的典型形状：**一个寻常日子 → 一个不对劲的细节 → 有人瞒着或扛着 → 小事被摊开 → 关系或处境挪了一格**。',
      '代价是软的但真实：疏远、误会、被比较、被瞒着、被当成外人、机会错过、欠下一笔还不上的情。',
    ].join('\n'),
  },
};
export function toneOf(value) {
  const key = String(value ?? '').trim();
  return Object.hasOwn(TONES, key) ? key : 'auto';
}

export function toneOptions() {
  return Object.entries(TONES).map(([value, item]) => ({ value, label: item.label }));
}

/** 基调方针文本（空串 = 不设基调）。 */
export function toneDirective(value) {
  const tone = TONES[toneOf(value)];
  return String(tone?.directive ?? '').trim();
}

export function emptyEpic() {
  return {
    [EP.title]: '',
    [EP.line]: '',
    [EP.movements]: [],
    [EP.hooks]: [],
    [EP.ledger]: '',
    [EP.stage]: '',
    [EP.chapter]: 0,
    [EP.updated]: '',
  };
}

export function epicOf(root) {
  const ns = isPlainObject(root?.[NS]) ? root[NS] : null;
  const box = ns && isPlainObject(ns[EPIC]) ? ns[EPIC] : null;
  return box ? { ...emptyEpic(), ...box } : emptyEpic();
}

/** 史诗是否已经有内容（决定要不要自动生成总纲）。 */
export function epicStarted(epic) {
  return !!String(unwrap(epic?.[EP.line]) ?? '').trim() || !!String(unwrap(epic?.[EP.title]) ?? '').trim();
}

/**
 * 史诗的「走向」能排到哪一步：总纲是一条有序的长线，每走完一章就前进一小段。
 * 排在后面的走向是**远期许诺**，只用来判断「势」朝哪边去，不要提前兑现。
 */
export function epicMovements(epic) {
  const raw = unwrap(epic?.[EP.movements]);
  if (Array.isArray(raw)) {
    return raw
      .map((item) => (isPlainObject(item) ? String(unwrap(item.value ?? item.内容 ?? item.text ?? '')) : String(unwrap(item) ?? '')))
      .map((text) => text.trim())
      .filter(Boolean);
  }
  return splitBeats(raw);
}

export function epicHooks(epic) {
  const raw = unwrap(epic?.[EP.hooks]);
  if (Array.isArray(raw)) {
    return raw.map((item) => String(unwrap(isPlainObject(item) ? (item.value ?? item.内容) : item) ?? '').trim()).filter(Boolean);
  }
  return splitBeats(raw);
}

/** 总纲更新到第几章了（用来判断要不要在开新章前重新校准）。 */
export function epicChapter(epic) {
  return Math.max(0, Math.round(toNumber(epic?.[EP.chapter], 0)));
}

/**
 * 把总纲渲染成注入块开头的那一节。
 * 位置很关键：**排在当前这一章的前面**，这样叙事者先看到「大势」，再看「这一章怎么走」。
 */
export function renderEpicSection(epic, { movementCap = 10, banUserAction = true } = {}) {
  const lines = [];
  if (!epicStarted(epic)) return { lines, started: false };
  const title = String(unwrap(epic[EP.title]) ?? '').trim();
  const line = String(unwrap(epic[EP.line]) ?? '').trim();
  const stage = String(unwrap(epic[EP.stage]) ?? '').trim();
  const ledger = String(unwrap(epic[EP.ledger]) ?? '').trim();
  const movements = epicMovements(epic).slice(0, Math.max(1, movementCap));
  const hooks = epicHooks(epic).slice(0, 6);

  lines.push('【史诗 · 围绕 {{user}} 的那条长线】');
  if (title || stage) lines.push(`${title ? `《${title}》` : ''}${stage ? `　进程：${stage}` : ''}`);
  if (line) lines.push(`总纲：${line}`);
  if (movements.length) {
    lines.push('走向（这条长线的路程；**排在后面的是远期许诺，不要提前兑现**）：');
    for (let i = 0; i < movements.length; i++) lines.push(`　${i + 1}. ${movements[i]}`);
  }
  if (hooks.length) lines.push(`埋着还没兑现的伏笔（合适的时候兑现，一次兑现一个就够）：${hooks.join('；')}`);
  if (ledger) lines.push(`既成事实（**已经发生、不可撤销**，后面全部建立在这上面）：${ledger}`);
  lines.push(
    '怎么用它：',
    '　· {{user}} 是这条线的主角：大势应该压在他和他身边的人事上，与他无关的势力动向只作背景；',
    '　· 每一章只推进这条长线的**一小段**，不要一口气把走向全用完；',
    '　· 章与章之间要接得上：这一章的条件应该是上一章留下的；',
    '　· **大势归大势** —— 具体怎么发生，永远以 {{user}} 实际做了 / 说了什么为准；他偏出去就跟着偏（见下面这一章）。',
  );
  if (banUserAction) {
    lines.push('　· 总纲里也不要写「他会去做什么」：写「世界会怎么变、谁会找上他、什么会落到他头上」。');
  }
  return { lines, started: true };
}

/** 面板上的「采用」按钮要用的东西：把 <StoryEpic> 区块变成可落盘的对象。 */
export function epicFromBlock(raw, { chapter = 0 } = {}) {
  const attrs = parseAttributes(raw);
  const movements = splitBeats(attrOf(attrs, '走向', 'movements', '线') || '');
  const hooks = (attrOf(attrs, '伏笔', 'hooks') || '')
    .split(/[；;\n]/)
    .map((text) => text.trim())
    .filter(Boolean);
  return {
    ...emptyEpic(),
    [EP.title]: sanitize(attrOf(attrs, '标题', 'title'), 60),
    [EP.line]: sanitize(attrOf(attrs, '总纲', '纲', 'line'), 400),
    [EP.movements]: movements.map((text) => sanitize(text, 300)).slice(0, 12),
    [EP.hooks]: hooks.map((text) => sanitize(text, 200)).slice(0, 8),
    [EP.ledger]: sanitize(attrOf(attrs, '既成事实', '事实', 'ledger'), 600),
    [EP.stage]: sanitize(attrOf(attrs, '当前进程', '进程', 'stage'), 40),
    [EP.chapter]: Math.max(0, Math.round(Number(chapter) || 0)),
    [EP.updated]: new Date().toISOString(),
  };
}

/**
 * 「间章」——与主线**互斥**的另一种幕。
 *
 * 主线一章收尾后，场子不该空着：这段时间交给间章，演日常、顺手埋伏笔。
 * 与主线最大的不同：**它不要求跑完拍**。节拍列出来是给叙事者参考的日常素材，
 * 什么时候够了由正文模型说了算（写 `可回主线`），到点就回到主线。
 */
export const INTERLUDE = '间章';
export const IL = {
  active: '进行中',
  title: '标题',
  scene: '场合',
  beats: '拍',
  beat: '当前拍',
  beatDone: '本拍已落',
  done: '已演够',
  ready: '可回主线',
  note: '说明',
  started: '开始',
};

export function emptyInterlude() {
  return {
    [IL.active]: false,
    [IL.title]: '',
    [IL.scene]: '',
    [IL.beats]: [],
    [IL.beat]: 1,
    [IL.beatDone]: false,
    [IL.done]: false,
    [IL.ready]: false,
    [IL.note]: '',
    [IL.started]: '',
  };
}

/** 取间章对象（没有就给一份默认形状）。 */
export function interludeChapterOf(root) {
  const ns = isPlainObject(root?.[NS]) ? root[NS] : null;
  const box = ns && isPlainObject(ns[INTERLUDE]) ? ns[INTERLUDE] : null;
  return box ? { ...emptyInterlude(), ...box } : emptyInterlude();
}

export function interludeActive(root) {
  return truthy(interludeChapterOf(root)[IL.active]);
}

export function interludeBeatsOf(chapter) {
  const beats = unwrap(chapter?.[IL.beats]);
  if (Array.isArray(beats)) {
    return beats
      .map((item) => (isPlainObject(item) ? String(unwrap(item.value ?? item.内容 ?? item.text ?? '')) : String(unwrap(item) ?? '')))
      .map((text) => text.trim())
      .filter(Boolean);
  }
  return splitBeats(beats);
}

export function interludeBeat(chapter) {
  return Math.max(1, Math.round(toNumber(chapter?.[IL.beat], 1)));
}

export const INTERLUDE_FIELDS = {
  title: '标题',
  status: '状态',
  after: '接在',
  beat: '内容',
  done: '已落',
};

// ───────────────────────────── 基础工具 ─────────────────────────────

export function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** MVU 的字段值可能是 { value, ... } 包装，取里层的真值。 */
export function unwrap(value) {
  if (isPlainObject(value) && 'value' in value) return value.value;
  return value;
}

/** 递归解包（打印用）。 */
export function unwrapDeep(value, depth = 0) {
  if (depth > 8) return value;
  if (Array.isArray(value)) return value.map((item) => unwrapDeep(item, depth + 1));
  if (isPlainObject(value)) {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (typeof key === 'string' && key.startsWith('$')) continue;
      out[key] = unwrapDeep(item, depth + 1);
    }
    return out;
  }
  return unwrap(value);
}

export function display(value) {
  const raw = unwrap(value);
  if (raw === undefined || raw === null) return '—';
  if (typeof raw === 'object') {
    try { return JSON.stringify(raw); } catch { return String(raw); }
  }
  return String(raw);
}

export function toNumber(value, fallback = 0) {
  const raw = unwrap(value);
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  const text = String(raw ?? '').trim();
  if (!text) return fallback;
  const num = Number(text.replace(/[^\d.+-]/g, ''));
  return Number.isFinite(num) ? num : fallback;
}

export function truthy(value) {
  const raw = unwrap(value);
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'number') return raw !== 0;
  const text = String(raw ?? '').trim().toLowerCase();
  return ['true', '1', 'yes', 'y', '是', '真', '已', 'on', 'done'].includes(text);
}

export const isMetaKey = (key) => typeof key === 'string' && key.startsWith('$');

/** 把一段文本裁到 limit 个字符（保留首尾，中间打省略标记）。 */
export function capText(text, limit) {
  const raw = String(text ?? '');
  if (!Number.isFinite(limit) || limit <= 0 || raw.length <= limit) return raw;
  const head = Math.max(0, Math.floor(limit * 0.7));
  const tail = Math.max(0, limit - head - 20);
  return `${raw.slice(0, head)}\n…（中间省略 ${raw.length - head - tail} 字）…\n${raw.slice(raw.length - tail)}`;
}

// ───────────────────────────── 拍 ─────────────────────────────

/**
 * 把一段「拍」文本拆成有序列表，两种写法都认：
 *   A. 多行编号：`1. …\n2. …`（每项可以继续换行，直到下一个编号）
 *   B. 单行分号：`一拍：…；二拍：…；`
 * 认不出编号就整段当作一拍返回（宁可少拆也不要拆错）。
 */
export function splitBeats(text) {
  const raw = String(text ?? '').replace(/\r/g, '').trim();
  if (!raw) return [];

  // A. 多行编号
  const lines = raw.split('\n');
  const items = [];
  let current = null;
  for (const line of lines) {
    const match = line.match(/^\s*(?:第\s*)?(\d{1,2}|[一二三四五六七八九十]{1,3})\s*(?:拍|步|节|幕)?\s*[.、．)）:：]\s*(.*)$/);
    if (match) {
      if (current) items.push(current);
      current = { no: beatNumber(match[1]), text: String(match[2] ?? '').trim() };
      continue;
    }
    if (current) current.text = `${current.text}\n${line.trim()}`.trim();
  }
  if (current) items.push(current);
  if (items.length >= 2) {
    const ordered = items.slice().sort((a, b) => a.no - b.no);
    // 编号必须从 1 起连续，否则可能把正文里别的编号行误当拍
    if (ordered.every((item, index) => item.no === index + 1)) {
      return ordered.map((item) => item.text.replace(/\n+/g, ' ').trim()).filter(Boolean);
    }
  }

  // B. 全平铺的编号列表：`1. 甲 2. 乙 3. 丙` / `一拍：甲；二拍：乙`
  //    先按分号切（`一拍：` 这种中文序数写法），不行再按行内的编号标记切。
  const flat = raw.replace(/\n+/g, ' ').trim();
  const MARKER = /(?:^|[;；\s])(?:第\s*)?(?:\d{1,2}|[一二三四五六七八九十]{1,3})\s*(?:拍|步|节|幕)?\s*[.、．)）:：]\s*/g;

  const bySemicolon = flat
    .split(/[;；]/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.replace(/^(?:第\s*)?(?:\d{1,2}|[一二三四五六七八九十]{1,3})\s*(?:拍|步|节|幕)?\s*[.、．)）:：]\s*/, '').trim())
    .filter(Boolean);
  if (bySemicolon.length >= 2) return bySemicolon;

  const marks = [...flat.matchAll(MARKER)];
  if (marks.length >= 2) {
    const collected = [];
    for (let i = 0; i < marks.length; i++) {
      const start = marks[i].index + marks[i][0].length;
      const end = i + 1 < marks.length ? marks[i + 1].index : flat.length;
      const text = flat.slice(start, end).trim();
      if (text) collected.push(text);
    }
    if (collected.length >= 2) return collected;
  }

  if (items.length >= 1) return items.map((item) => item.text.replace(/\n+/g, ' ').trim()).filter(Boolean);
  return [flat];
}

function beatNumber(token) {
  const text = String(token ?? '').trim();
  if (/^\d+$/.test(text)) return Number(text);
  const digits = '零一二三四五六七八九';
  if (text.length === 1) {
    const index = digits.indexOf(text);
    return index >= 0 ? index : NaN;
  }
  if (text === '十') return 10;
  if (text.startsWith('十')) return 10 + (digits.indexOf(text[1]) || 0);
  if (text.endsWith('十')) return (digits.indexOf(text[0]) || 0) * 10;
  if (text.includes('十')) {
    const [tens, ones] = text.split('十');
    return (digits.indexOf(tens) || 0) * 10 + (digits.indexOf(ones) || 0);
  }
  return NaN;
}

/** 把一条主线里的拍取出来（优先数组，其次字符串）。 */
export function beatsOf(target) {
  const beats = unwrap(target?.[MAIN_BEATS]);
  if (Array.isArray(beats)) {
    return beats
      .map((item) => {
        if (typeof item === 'string') return item.trim();
        if (isPlainObject(item)) return String(unwrap(item.value ?? item.内容 ?? item.text ?? '')).trim();
        return String(unwrap(item) ?? '').trim();
      })
      .filter(Boolean);
  }
  return splitBeats(beats);
}

/** 解析模型的 <StoryChapters> / <StoryThreads> / <StoryInterlude> 区块。 */
export function parseBlocks(text, tag) {
  const source = String(text ?? '');
  const pattern = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  const out = [];
  for (const match of source.matchAll(pattern)) out.push(match[1]);
  return out;
}

/**
 * 逐字段拆一个区块。属性行写法：`标题: xxx` / `标题：xxx` / `标题="xxx"`，
 * 值可以跨行，直到下一个 `字段:` 或 `字段=` 行出现。
 */
export function parseAttributes(raw) {
  let text = String(raw ?? '').replace(/\r/g, '');
  // 调用方可能把整块（含 <StoryChapters> 围栏）传进来，也可能只传内层文本（此时结尾会带一个
  // 孤零零的 </StoryChapters>）。两种都先清掉，否则闭合标签会被算进最后一个字段的值里。
  text = text.replace(/<\/?[A-Za-z][A-Za-z0-9_-]{0,30}>/g, ' ').trim();
  // 字段值可以跨行：终止于「下一行的字段名」或「真正的字符串结尾」。
  // ⚠ 这里不能用 `\n*$`——正则带 m 标志时 `$` 会匹配每一个行尾，值会在第一行就被截断
  //（模型把 `拍` 写成多行编号列表时，那样只会留下第一拍）。
  const re = /^[ \t]*([\p{Script=Han}A-Za-z_]{1,12})[ \t]*[:：=][ \t]*([\s\S]*?)(?=\n[ \t]*[\p{Script=Han}A-Za-z_]{1,12}[ \t]*[:：=]|(?![\s\S]))/gmu;
  const out = {};
  for (const match of text.matchAll(re)) {
    const key = match[1].trim();
    let value = String(match[2] ?? '').trim();
    value = value.replace(/^["'「『]/, '').replace(/["'」』]$/, '').trim();
    if (!key) continue;
    out[key] = value;
    out[key.toLowerCase()] = value;
  }
  return out;
}

/** 从一个区块里取字段（中英键都认）。 */
export function attrOf(attrs, ...names) {
  for (const name of names) {
    if (attrs && Object.hasOwn(attrs, name)) {
      const value = attrs[name];
      if (value !== undefined && value !== null && String(value).trim() !== '') return String(value).trim();
    }
  }
  return '';
}

// ───────────────────────────── 数据读写 ─────────────────────────────

export function emptyMain() {
  return {
    [MAIN_TITLE]: '',
    [MAIN_ARC]: '',
    [MAIN_SCOPE]: '',
    [MAIN_GOAL]: '',
    [MAIN_BEATS]: [],
    [KEY_BEAT]: 1,
    [KEY_BEAT_DONE]: false,
    [KEY_CHAPTER_DONE]: false,
    [KEY_READY]: false,
    [KEY_REVIEW]: REVIEW_PASS,
    [KEY_REVIEW_NOTE]: '',
    [MAIN_STARTED]: '',
    [MAIN_ENDED]: '',
  };
}

export function mainOf(root) {
  const ns = isPlainObject(root?.[NS]) ? root[NS] : null;
  const main = ns && isPlainObject(ns.主线) ? ns.主线 : null;
  return main ? { ...emptyMain(), ...main } : emptyMain();
}

export function listOf(root, kind) {
  const ns = isPlainObject(root?.[NS]) ? root[NS] : null;
  const box = ns && isPlainObject(ns[kind]) ? ns[kind] : {};
  const out = [];
  for (const [id, value] of Object.entries(box)) {
    if (isMetaKey(id) || !isPlainObject(value)) continue;
    out.push({ id, ...value });
  }
  return out;
}

/** 主线当前拍（1 起）。 */
export function currentBeat(main) {
  return Math.max(1, Math.round(toNumber(main?.[KEY_BEAT], 1)));
}

export function reviewStateOf(main) {
  const raw = String(display(main?.[KEY_REVIEW] ?? '')).trim();
  return REVIEW_STATES.includes(raw) ? raw : REVIEW_PASS;
}

export function reviewNoteOf(main) {
  const raw = main?.[KEY_REVIEW_NOTE];
  const text = String(unwrap(raw) ?? '').trim();
  return text;
}

/** 一条支线是否还「活着」（可以被注入）。 */
export function isLiveThread(thread) {
  const status = String(display(thread?.[THREAD_FIELDS.status] ?? '')).trim();
  return status === STATUS_ACTIVE || status === STATUS_PENDING;
}

export function threadLanded(thread) {
  return truthy(thread?.[THREAD_FIELDS.done]);
}

export function interludeLanded(interlude) {
  return truthy(interlude?.[INTERLUDE_FIELDS.done]);
}

export function interludePending(interlude) {
  if (interludeLanded(interlude)) return false;
  const status = String(display(interlude?.[INTERLUDE_FIELDS.status] ?? '')).trim();
  // 「已完成 / 已跳过」都算走完了 —— 模型可能只写状态不写「已落」，只认「已落」会让它永远占着配额。
  return status !== STATUS_DONE && status !== STATUS_SKIPPED;
}

/** 取「接在」字段里的主线拍号；认不出返回 0（＝不看位置，随时可演）。 */
export function interludeAfter(interlude) {
  const raw = display(interlude?.[INTERLUDE_FIELDS.after] ?? '');
  const match = String(raw).match(/(\d{1,3})/);
  return match ? Number(match[1]) : 0;
}

/** 生成一个稳定且不撞车的编号（支线 t1、t2…；插曲 i1、i2…）。 */
export function nextId(used, prefix) {
  const set = new Set(Array.isArray(used) ? used.map(String) : []);
  let index = 1;
  while (set.has(`${prefix}${index}`)) index++;
  return `${prefix}${index}`;
}

/** 已有的全部标题（做去重用）。 */
export function takenTitles(root) {
  const titles = [];
  const main = mainOf(root);
  if (String(unwrap(main[MAIN_TITLE]) ?? '').trim()) titles.push(String(unwrap(main[MAIN_TITLE])).trim());
  if (String(unwrap(main[MAIN_ARC]) ?? '').trim()) titles.push(String(unwrap(main[MAIN_ARC])).trim());
  for (const thread of listOf(root, '支线')) titles.push(String(unwrap(thread[THREAD_FIELDS.title]) ?? '').trim());
  for (const interlude of listOf(root, '插曲')) titles.push(String(unwrap(interlude[INTERLUDE_FIELDS.title]) ?? '').trim());
  return titles.filter(Boolean);
}

// ───────────────────────────── 注入渲染 ─────────────────────────────

/**
 * 注入的抬头 + 落地方式。
 * @param {boolean} banUserAction 是否强制「不安排 {{user}} 行为」。
 *   ⚠ 关掉之后导演就可能替玩家写行为 —— 默认必须开着，这是引擎问题不是口味问题。
 * @param {'main'|'interlude'} mode 当前是哪种幕（间章时抬头要说清主线正收着）。
 */
export function renderInjectionHeader({ banUserAction = true, mode = 'main' } = {}) {
  const lines = [
    '<story_director_status>',
    '【故事导演 · 幕后引导】以下内容是导演给你的**演出计划**，不是台词、不要复述、不要写进正文。',
  ];
  if (mode === 'interlude') {
    lines.push('【当前幕：间章】主线暂时收着（它已经在章节史里），这几轮演**日常**：生活质感、人物侧面、顺手埋线。');
    lines.push('间章**不推进主线**，也**不要求演完** —— 演够了随时可以收尾回主线（注入里会写怎么写）。');
  } else {
    lines.push('【当前幕：主线】按下面这一章推进。');
  }
  if (banUserAction) {
    lines.push(
      '【落地方式】剧情由**世界里发生了什么 + 别人的行动 + 埋下的伏笔**推动：你要写的是「谁做了什么、于是局面变成什么样」。',
      '**绝不安排 {{user}} 的行为**：不替他说话、不替他做决定、不替他表态，也不要写「等他…之后…」。把局面摆到他面前，怎么走由他自己决定。',
    );
  } else {
    lines.push(
      '【落地方式】剧情由**世界里发生了什么 + 别人的行动 + 埋下的伏笔**推动：你要写的是「谁做了什么、于是局面变成什么样」。',
    );
  }
  return lines;
}

/**
 * 主线区块：整条线的拍列表 + 本轮聚焦哪一拍 + 落拍回报怎么写。
 */
export function renderMainSection(main, { maxBeats = 8, root = null, banUserAction = true } = {}) {
  const lines = [];
  const title = String(unwrap(main[MAIN_TITLE]) ?? '').trim();
  const arc = String(unwrap(main[MAIN_ARC]) ?? '').trim();
  const goal = String(unwrap(main[MAIN_GOAL]) ?? '').trim();
  const scope = String(unwrap(main[MAIN_SCOPE]) ?? '').trim();
  const beats = beatsOf(main).slice(0, Math.max(1, maxBeats));
  const total = beats.length;
  const current = currentBeat(main);

  lines.push('【主线 · 按拍推进】');
  if (title || arc) lines.push(`本章：${[arc, title].filter(Boolean).join(' · ')}`);
  if (goal) lines.push(`章目标（整章走完才算，本轮的拍不等于章目标）：${goal}`);
  if (scope) lines.push(`范围：${scope}`);

  // 已经演过的旧标题只报个名字，避免模型把演过的章又写一遍
  const history = completedMainTitles(root);
  if (history.length) lines.push(`已经走过的章（**不要重演、不要换个说法再来一遍**）：${history.join('、')}`);

  if (!total) {
    lines.push('本章还没有拍列表：请按章目标自然推进，把这一章讲完再收束。');
    return { lines, total: 0, current: 0, done: false };
  }

  if (current > total) {
    lines.push(`本章 ${total} 拍已经全部演过。不要再重演其中任何一拍：把笔墨放在**后果**（别人的察觉、关系的位移、留下的痕迹）与下一章的铺垫上。`);
  } else {
    lines.push(`本章共 ${total} 拍（按顺序推进，不要跳拍）：`);
    for (let i = 0; i < total; i++) {
      const mark = i + 1 < current ? '✔' : (i + 1 === current ? '▶' : '·');
      lines.push(`${mark} ${i + 1}. ${beats[i]}`);
    }
    lines.push(`本轮聚焦第 ${current} 拍（✔ 的已经发生过、不要重演；· 的不要抢跑）。`);
    // 这一拍的落地方式：由世界里的事推动，而不是替玩家安排行为
    lines.push('　落地方式：把这一拍写成**场里真的发生了什么** —— 谁做了什么、传了什么话、局面变成了什么样。');
    if (banUserAction) {
      lines.push(
        '　**不要替 {{user}} 说话、做事、下决定**，也不要写「等他…之后再…」把剧情挂在他的反应上；把局面摆到他面前，怎么走由他自己决定。',
      );
    }
    lines.push('　推不动就用**伏笔与事件**推：一个被收起来的物件、一句没说完的话、一个别人做的决定、一次意外、一条传到他耳朵里的消息。');
  }

  lines.push(
    '落拍回报（写进变量，插件据此换拍、换章；**只在这一拍真的写进正文之后写，不要预告**）：',
    `　· 第 ${current <= total ? current : total} 拍真的发生了 → \`_.set('${PATH.main}.${KEY_BEAT}', ${(current <= total ? current : total) + 1})\``,
    `　· 整章的章目标真的达成了 → \`_.set('${PATH.main}.${KEY_CHAPTER_DONE}', true)\``,
    `　· 当前场景已经收尾、适合开新的一章 → \`_.set('${PATH.main}.${KEY_READY}', true)\``,
    `　· 这一拍在当前场景里落不下去（要成立就得硬加设定 / 会让人物出戏）→ 这一拍**不要落笔**，写 \`_.set('${PATH.main}.${KEY_REVIEW}', '${REVIEW_REJECT}')\`，并在 \`${KEY_REVIEW_NOTE}\` 里一句话说明原因。`,
    `　· 稍微挪一下场合 / 换个人来触发就能自然发生 → 自己微调执行方式（保持意图与结果不变），写 \`_.set('${PATH.main}.${KEY_REVIEW}', '${REVIEW_ADJUST}')\` 并说明你改了什么。`,
    `　· 插件读到「${REVIEW_ADJUST}」/「${REVIEW_REJECT}」会**按当前情况把剩下的拍重新设计**（下一轮生效），所以不要为了塞进这一拍而硬写。`,
  );

  const note = reviewNoteOf(main);
  const state = reviewStateOf(main);
  // 审查结论由插件在读到后**立刻复位**为「通过」，所以这里基本不会渲染；留着是为了万一有别的
  // 写入方（例如手改）留下结论时也能把上下文带出来。
  if (state !== REVIEW_PASS) lines.push(`（上一轮对本章提过异议：${state}${note ? `——${note}` : ''}；拍列表已经按它改过一遍了。）`);

  return { lines, total, current, done: current > total };
}

/** 历史章标题（线里只记最近几章，避免注入无限增长）。 */
export function completedMainTitles(root) {
  const ns = isPlainObject(root?.[NS]) ? root[NS] : null;
  const box = ns && isPlainObject(ns.章节史) ? ns.章节史 : {};
  return Object.values(box)
    .map((item) => String(unwrap(isPlainObject(item) ? item[MAIN_TITLE] : item) ?? '').trim())
    .filter(Boolean);
}

/**
 * 支线区块：只给「还在演」的那几条（默认最多 keep 条），每条一拍一个落点。
 */
export function renderThreadsSection(threads, { keep = 2, banUserAction = true } = {}) {
  const live = (Array.isArray(threads) ? threads : []).filter(isLiveThread).slice(0, Math.max(0, keep));
  const lines = [];
  if (!live.length) return { lines, live };
  lines.push('【支线 · 与主线并行但不要抢戏】');
  lines.push('这些线各自独立推进：每轮可以只让其中一条往前走一小步，也可以整轮都不碰；绝不要让支线盖过主线当前那一拍。');
  lines.push(
    banUserAction
      ? '推进方式与主线相同：**写别人做了什么、发生了什么小状况**，不要替 {{user}} 安排行为，也不要把支线的进展挂在他的选择上。'
      : '推进方式与主线相同：**写别人做了什么、发生了什么小状况**。',
  );
  for (const thread of live) {
    const title = String(unwrap(thread[THREAD_FIELDS.title]) ?? '').trim() || thread.id;
    const goal = String(unwrap(thread[THREAD_FIELDS.goal]) ?? '').trim();
    const entry = String(unwrap(thread[THREAD_FIELDS.entry]) ?? '').trim();
    const land = String(unwrap(thread[THREAD_FIELDS.land]) ?? '').trim();
    lines.push(`· ${thread.id}「${title}」${goal ? `：${goal}` : ''}`);
    if (entry) lines.push(`　起始迹象：${entry}`);
    if (land) lines.push(`　收束／落点：${land}`);
    lines.push(`　落点真的在正文里发生之后写 \`_.set('${PATH.threads}.${thread.id}.${THREAD_FIELDS.done}', true)\` 并写 \`_.set('${PATH.threads}.${thread.id}.${THREAD_FIELDS.status}', '${STATUS_DONE}')\`；长期推不动就写 \`'${STATUS_STALLED}'\` 收尾（插件会把它从注入里摘掉）。`);
  }
  return { lines, live };
}

/**
 * 插曲区块：给一条「排在最前面的、位置已到」的插曲。位置没到就不出现。
 */
export function renderInterludeSection(interludes, currentMainBeat, { keep = 1, banUserAction = true } = {}) {
  const due = (Array.isArray(interludes) ? interludes : []).filter((item) => {
    if (!interludePending(item)) return false;
    const after = interludeAfter(item);
    return !after || currentMainBeat >= after;
  }).slice(0, Math.max(0, keep));
  const lines = [];
  if (!due.length) return { lines, due };
  lines.push('【插曲 · 幕间小段】');
  lines.push('插曲是让人物歇一口气的小场景（日常、误会、闲话、旧事），**不是主线的一拍**：它不推进章目标，只负责呼吸感与埋线。');
  lines.push(
    banUserAction
      ? '写的是**别人 / 环境在过日子**（谁在忙什么、听说了一件旧事、谁送来了什么），不是「{{user}} 去做了什么」。'
      : '写的是**别人 / 环境在过日子**（谁在忙什么、听说了一件旧事、谁送来了什么）。',
  );
  for (const item of due) {
    const title = String(unwrap(item[INTERLUDE_FIELDS.title]) ?? '').trim() || item.id;
    const beat = String(unwrap(item[INTERLUDE_FIELDS.beat]) ?? '').trim();
    lines.push(`· ${item.id}「${title}」`);
    if (beat) lines.push(`　内容：${beat}`);
    lines.push(`　真的写进正文之后写 \`_.set('${PATH.interludes}.${item.id}.${INTERLUDE_FIELDS.done}', true)\` 与 \`_.set('${PATH.interludes}.${item.id}.${INTERLUDE_FIELDS.status}', '${STATUS_DONE}')\`；这一条与本轮场景合不来就整轮不写它，不要硬塞。`);
  }
  return { lines, due };
}

/**
 * 间章区块：日常的拍 + 「不必跑完」的说明 + 回主线的回报写法。
 * 与主线区块的区别就是这套「随时可以收」的语义 —— 注入里必须写清楚，否则模型会把日常演成第二个主线。
 */
export function renderInterludeChapterSection(chapter, { maxBeats = 6, banUserAction = true } = {}) {
  const lines = [];
  const title = String(unwrap(chapter?.[IL.title]) ?? '').trim();
  const scene = String(unwrap(chapter?.[IL.scene]) ?? '').trim();
  const beats = interludeBeatsOf(chapter).slice(0, Math.max(1, maxBeats));
  const total = beats.length;
  const current = interludeBeat(chapter);

  lines.push('【间章 · 与主线互斥的另一幕】');
  lines.push('本章是**间章**：主线暂时收着，这几轮演的是**日常**——生活质感、人物侧面、顺手埋线。');
  lines.push('⚠ 间章**不要求跑完**：下面这些拍只是素材与顺序建议。你觉得日常已经演够了、或者主线那边该接上了，**随时可以收尾回主线**。');
  lines.push('⚠ 间章**不推进主线**：不升级冲突、不给关键转折、不让新角色登场。它也可以**顺手埋一根线**（一个以后会兑现的细节），但不要当场兑现、也不要点破。');
  if (title) lines.push(`${title}${scene ? `　（${scene}）` : ''}`);

  if (!total) {
    lines.push('这一段间章还没有拍列表：按上面的要求自然演日常即可，觉得够了就写 `' + IL.ready + '`。');
  } else {
    if (current > total) {
      lines.push(`素材里列的 ${total} 个日常画面都已经演过了：接着写日常的余韵，或者在合适的地方收尾回主线。`);
    } else {
      lines.push(`可用的日常画面（共 ${total} 个，**不要求全演**、也可以只挑其中几个）：`);
      for (let i = 0; i < total; i++) {
        const mark = i + 1 < current ? '✔' : (i + 1 === current ? '▶' : '·');
        lines.push(`${mark} ${i + 1}. ${beats[i]}`);
      }
      lines.push(`本轮可以做 ${current}（✔ 的已经演过；· 的只是备选，跳过没关系）。`);
    }
  }

  lines.push('　落地方式：把这一拍写成**场里真的发生了什么** —— 谁做了什么、谁说了什么闲话、什么东西出现了。');
  if (banUserAction) {
    lines.push('　**不要替 {{user}} 说话、做事、下决定**，也不要写「等他…之后再…」；把局面摆到他面前，怎么走由他自己决定。');
  }
  lines.push(
    '落拍回报（写进变量；**只在这一拍真的写进正文之后写**）：',
    `　· 第 ${Math.max(1, Math.min(current, total || current))} 个日常画面真的演到了 → \`_.set('${PATH.interlude}.${IL.beat}', ${Math.max(1, Math.min(current, total || current)) + 1})\``,
    `　· 日常演够了、可以回主线了（**随时可以**，不必等拍演完）→ \`_.set('${PATH.interlude}.${IL.ready}', true)\``,
    `　· 顺手中了一根线、想记一笔 → \`_.set('${PATH.interlude}.${IL.note}', '一句话')\``,
    `　· 插件读到 \`${IL.ready}\` 就会请故事神谕**接着开主线的新一章**，所以：写到合适的地方就收，不要为了把日常拖长而硬凑。`,
  );
  return { lines, total, current };
}

/**
 * 变量契约：只讲「怎么回报」，字段清单交给世界书（省 token）。
 * 每轮都注入，但正文很短。
 */
export function renderContractSection({ banUserAction = true } = {}) {
  const lines = [
    '【落拍回报 · 命令写法】',
    '你可以在回复末尾用 MVU 命令写变量（与卡片自己的状态栏变量互不干扰，全部写在 `故事导演` 命名空间下）：',
    '```',
    `_.set('${PATH.main}.${KEY_BEAT}', 3);`,
    `_.set('${PATH.main}.${KEY_CHAPTER_DONE}', true);`,
    `_.set('${PATH.main}.${KEY_READY}', true);`,
    `_.set('${PATH.interlude}.${IL.beat}', 2);`,
    `_.set('${PATH.interlude}.${IL.ready}', true);`,
    `_.set('${PATH.threads}.t1.${THREAD_FIELDS.done}', true);`,
    `_.set('${PATH.interludes}.i1.${INTERLUDE_FIELDS.done}', true);`,
    '```',
    `　· \`${NS}.${EPIC}.*\`（总纲）是**导演写的，你只读** —— 不要自己改它。`,
    '　· 只有**真的写进正文之后**才写这些命令；写不出、拿不准就什么都不写（插件不会因此卡住，下一轮照旧引导）。',
    `　· \`${PATH.interlude}.*\` 只在**间章**时段有效（注入块里有【间章】时）；主线时段写它会被插件忽略。`,
    '　· 不要自己改 `拍` 列表与 `标题`（那是导演的事）；不要写 `故事导演` 之外的新根键。',
  ];
  if (banUserAction) {
    lines.push('　· 这些字段只描述**世界里发生了什么**：不要用它们安排 {{user}} 的行为（「他答应了」「她看着他离开」这种把玩家写成被安排的对象）。');
  }
  return lines;
}

// ───────────────────────────── 归一化 / 备份 ─────────────────────────────

const sanitize = (value, limit = 200) => String(value ?? '').trim().replace(/\s*\n\s*/g, ' ').slice(0, limit);

export function normalizeInterludeChapter(source, { beatBudget = 4 } = {}) {
  const beats = (Array.isArray(source?.beats) ? source.beats : splitBeats(source?.beats ?? source?.拍 ?? ''))
    .map((beat) => sanitize(beat, 300))
    .filter(Boolean)
    .slice(0, Math.max(1, beatBudget));
  return {
    [IL.active]: true,
    [IL.title]: sanitize(source?.title ?? source?.[IL.title], 60),
    [IL.scene]: sanitize(source?.scene ?? source?.[IL.scene], 120),
    [IL.beats]: beats,
    [IL.beat]: 1,
    [IL.beatDone]: false,
    [IL.done]: false,
    [IL.ready]: false,
    [IL.note]: '',
    [IL.started]: new Date().toISOString(),
  };
}

/** 面板上的「采用」按钮要用的东西：把 <StoryInterludeChapter> 区块变成可落盘的对象。 */
export function interludeChapterFromBlock(raw, opts = {}) {
  const attrs = parseAttributes(raw);
  return normalizeInterludeChapter({
    title: attrOf(attrs, '标题', 'title') || '一段日常',
    scene: attrOf(attrs, '场合', '地点', 'scene'),
    beats: attrOf(attrs, '拍', 'beats'),
  }, opts);
}

/** 把解析出来的一个「章」对象规整成可落 MVU 的形状。
 * source 来自 <StoryChapters> 区块（解析后的属性对象）。
 */
export function normalizeChapter(source, { index = 0, keepId = '' } = {}) {
  const beats = Array.isArray(source?.beats) ? source.beats : splitBeats(source?.beats ?? source?.拍 ?? '');
  return {
    id: keepId || `c${index + 1}`,
    [MAIN_TITLE]: sanitize(source?.title ?? source?.[MAIN_TITLE], 60),
    [MAIN_ARC]: sanitize(source?.arc ?? source?.[MAIN_ARC], 60),
    [MAIN_SCOPE]: sanitize(source?.scope ?? source?.[MAIN_SCOPE], 240),
    [MAIN_GOAL]: sanitize(source?.goal ?? source?.[MAIN_GOAL], 300),
    [MAIN_BEATS]: beats.map((beat) => sanitize(beat, 300)).filter(Boolean).slice(0, 10),
    [KEY_BEAT]: 1,
    [KEY_BEAT_DONE]: false,
    [KEY_CHAPTER_DONE]: false,
    [KEY_READY]: false,
    [KEY_REVIEW]: REVIEW_PASS,
    [KEY_REVIEW_NOTE]: '',
    [MAIN_STARTED]: new Date().toISOString(),
    [MAIN_ENDED]: '',
  };
}

export function normalizeThread(source, { id = '' } = {}) {
  return {
    id,
    [THREAD_FIELDS.title]: sanitize(source?.title ?? source?.[THREAD_FIELDS.title], 60),
    [THREAD_FIELDS.status]: STATUS_PENDING,
    [THREAD_FIELDS.goal]: sanitize(source?.goal ?? source?.[THREAD_FIELDS.goal], 300),
    [THREAD_FIELDS.entry]: sanitize(source?.entry ?? source?.[THREAD_FIELDS.entry], 240),
    [THREAD_FIELDS.land]: sanitize(source?.land ?? source?.[THREAD_FIELDS.land], 300),
    [THREAD_FIELDS.due]: sanitize(source?.due ?? source?.[THREAD_FIELDS.due], 40),
    [THREAD_FIELDS.started]: new Date().toISOString(),
    [THREAD_FIELDS.ended]: '',
    [THREAD_FIELDS.done]: false,
    [THREAD_FIELDS.note]: '',
  };
}

export function normalizeInterlude(source, { id = '', after = 0 } = {}) {
  // 「接在」三种来源：模型写的原话 > 调用方算出的拍号 > 默认「随时」。
  // 原话要原样留着（面板显示）；同时把里面的数字抠出来给调度用。
  const asked = String(source?.after ?? source?.[INTERLUDE_FIELDS.after] ?? '').trim();
  const askedNumber = Number((asked.match(/(\d{1,3})/) || [])[1] || 0);
  const number = askedNumber > 0 ? askedNumber : Math.max(0, Math.round(Number(after) || 0));
  return {
    id,
    [INTERLUDE_FIELDS.title]: sanitize(source?.title ?? source?.[INTERLUDE_FIELDS.title], 60),
    [INTERLUDE_FIELDS.status]: STATUS_PENDING,
    [INTERLUDE_FIELDS.after]: asked && !/^随时$/.test(asked) && /[^\d\s拍第之后]/.test(asked)
      ? sanitize(asked, 40)
      : (number > 0 ? `第 ${number} 拍之后` : '随时'),
    [INTERLUDE_FIELDS.beat]: sanitize(source?.beat ?? source?.[INTERLUDE_FIELDS.beat], 300),
    [INTERLUDE_FIELDS.done]: false,
  };
}

/** 面板上的「采用」按钮要用的东西：把区块文本变成一个可落盘的对象。 */
export function chapterFromBlock(raw, opts = {}) {
  const attrs = parseAttributes(raw);
  return normalizeChapter({
    title: attrOf(attrs, '章标题', '标题', 'title') || '未命名的一章',
    arc: attrOf(attrs, '篇章', '弧线', 'arc', 'story'),
    scope: attrOf(attrs, '范围', '边界', 'scope'),
    goal: attrOf(attrs, '章目标', '目标', 'goal'),
    beats: attrOf(attrs, '拍', 'beats', 'beats:'),
  }, opts);
}

export function threadFromBlock(raw, opts = {}) {
  const attrs = parseAttributes(raw);
  return normalizeThread({
    title: attrOf(attrs, '标题', 'title') || '未命名的支线',
    goal: attrOf(attrs, '目标', 'goal'),
    entry: attrOf(attrs, '切入', '起始迹象', 'entry'),
    land: attrOf(attrs, '落点', '收束', 'land'),
    due: attrOf(attrs, '时限', 'due'),
  }, opts);
}

export function interludeFromBlock(raw, opts = {}) {
  const attrs = parseAttributes(raw);
  return normalizeInterlude({
    title: attrOf(attrs, '标题', 'title') || '未命名的插曲',
    beat: attrOf(attrs, '内容', '一拍', 'beat'),
    after: attrOf(attrs, '接在', 'after'),
  }, opts);
}

// ───────────────────────────── MVU 命令 ─────────────────────────────

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** lodash 风格路径解析：`a.b[0]` / `a["x y"]` 都认。 */
export function toPath(path) {
  const text = String(path ?? '').trim();
  if (!text) return [];
  const out = [];
  for (const match of text.matchAll(/\[([^\]]*)\]|([^.[\]]+)/g)) {
    const fromBracket = match[1] !== undefined;
    let token = String(fromBracket ? match[1] : match[2]).trim();
    if (fromBracket && token.length >= 2) {
      const first = token[0];
      if ((first === '"' || first === "'") && token[token.length - 1] === first) token = token.slice(1, -1);
    }
    if (token !== '' && !UNSAFE_KEYS.has(token)) out.push(token);
  }
  return out;
}

export function getPath(obj, path) {
  return toPath(path).reduce((value, key) => (value == null ? undefined : value[key]), obj);
}

export function setPath(obj, path, value) {
  const parts = toPath(path);
  if (!parts.length || obj == null) return obj;
  let node = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (!isPlainObject(node[key]) && !Array.isArray(node[key])) node[key] = {};
    node = node[key];
  }
  node[parts[parts.length - 1]] = value;
  return obj;
}

export function unsetPath(obj, path) {
  const parts = toPath(path);
  if (parts.length < 2) return obj;
  const parent = getPath(obj, parts.slice(0, -1).join('.'));
  if (parent && typeof parent === 'object') delete parent[parts[parts.length - 1]];
  return obj;
}

/** 把单引号字符串换成双引号，好让 JSON.parse 吃得下模型写的字面量。 */
function requote(text) {
  return text.replace(/'((?:\\.|[^'\\])*)'/g, (_match, inner) => JSON.stringify(String(inner).replace(/\\(['"\\])/g, '$1')));
}

export function parseCommandLiteral(text) {
  if (typeof text !== 'string') return text;
  const raw = text.trim();
  if (!raw) return '';
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  if (raw === 'undefined') return undefined;
  if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
    try { return JSON.parse(raw); } catch { return raw.slice(1, -1); }
  }
  if (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2) {
    return raw.slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, '\\');
  }
  if (raw.startsWith('{') || raw.startsWith('[')) {
    for (const candidate of [raw, requote(raw)]) {
      if (!candidate) continue;
      try { return JSON.parse(candidate); } catch { /* 换下一种 */ }
    }
  }
  if (/^[+-]?\d+(?:\.\d+)?$/.test(raw)) return Number(raw);
  return raw;
}

/** 命令是否落在我们的命名空间里；是则返回去掉前缀后的路径，否则 null。 */
export function nsPathOfCommand(command) {
  const raw = command?.args?.[0];
  if (typeof raw !== 'string') return null;
  let path = raw.trim();
  if ((path.startsWith('"') && path.endsWith('"')) || (path.startsWith("'") && path.endsWith("'"))) {
    path = path.slice(1, -1);
  }
  path = path.replace(/^(?:stat_data|status_current_variables)\./, '');
  if (path === NS || path.startsWith(`${NS}.`) || path.startsWith(`${NS}[`)) return path;
  return null;
}

/** 只有插件能写的字段（AI 写了也忽略）。`[ ]` 写法与点号写法都要认。 */
const PLUGIN_OWNED = new Set();
for (const key of [MAIN_BEATS, MAIN_TITLE, MAIN_ARC, MAIN_SCOPE, MAIN_GOAL]) PLUGIN_OWNED.add(`${NS}.主线.${key}`);
for (const key of [IL.title, IL.scene, IL.beats]) PLUGIN_OWNED.add(`${NS}.${INTERLUDE}.${key}`);
/** 间章时段之外，模型对 `间章.*` 的写入一律忽略（防止它在主线时段乱改间章状态）。 */
let interludeWritesAllowed = false;
export function setInterludeWritesAllowed(flag) {
  interludeWritesAllowed = !!flag;
}

function ownedPathOf(target) {
  return String(target ?? '').replace(/\[(['"])(.*?)\1\]/g, '.$2');
}

/**
 * 诊断计数：模型（或旧消息重放）想写一个**更小**的拍号、被我们按「只增不减」挡掉了几次。
 * 面板「诊断」里会显示它 —— 有人报「拍号回退」时，看这个数就知道是不是这条路径。
 * 读真实值用 model.beatOrderSkips()。
 */
let beatOrderSkips = 0;
export function beatOrderSkipsReset() { beatOrderSkips = 0; }
export function beatOrderSkipsRead() { return beatOrderSkips; }

/**
 * 把一个「拍号」旧值读成数字。
 * ⚠ 不能用 `Number(raw)`：`Number(null)` 是 0、`Number('')` 也是 0 —— 那会让「只增不减」
 * 的守卫把 0 当成合法旧值，表现成「拍号回退到 2」。null / undefined / 空串一律算读不出来。
 */
function beatValueOf(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : NaN;
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (!text) return NaN;
    const num = Number(text);
    return Number.isFinite(num) ? num : NaN;
  }
  return NaN;
}

/** 按字段名规整值：开关转布尔、拍号只增不减且至少 1。 */
export function coerceFieldValue(key, value, previous) {
  const field = String(key ?? '').split('.').pop();
  const oldNumber = beatValueOf(unwrap(previous));
  if ([KEY_BEAT_DONE, KEY_CHAPTER_DONE, KEY_READY, THREAD_FIELDS.done, INTERLUDE_FIELDS.done, IL.beatDone, IL.done, IL.ready].includes(field)) {
    return truthy(value);
  }
  if (field === KEY_BEAT || field === IL.beat) {
    const asked = Math.max(1, Math.round(Number(unwrap(value)) || 1));
    // 库里读不出数（键被删 / 值被写成 null 或不可解析的东西）时**不接受模型写的值**：
    // 宁可退回第 1 拍，也不要让「拍号回退」出现在正文里 —— 那种回退用户一眼就能看出来。
    if (!Number.isFinite(oldNumber)) {
      if (unwrap(previous) !== undefined) beatOrderSkips++;
      console.info(`[故事导演] ${field} 读不出旧值（${JSON.stringify(unwrap(previous))}），按 1 处理，忽略模型写的 ${asked}`);
      return 1;
    }
    const kept = Math.max(Math.round(oldNumber), asked);
    if (asked < Math.round(oldNumber)) {
      beatOrderSkips++;
      console.info(`[故事导演] 挡下一次拍号回退：想写 ${asked}，当前是 ${Math.round(oldNumber)}（拍号只增不减）`);
    }
    return kept;
  }
  if (field === KEY_REVIEW) {
    const text = String(unwrap(value) ?? '').trim();
    return REVIEW_STATES.includes(text) ? text : REVIEW_PASS;
  }
  return value;
}

function mergeDeep(target, source) {
  if (!isPlainObject(target) || !isPlainObject(source)) return source;
  for (const [key, value] of Object.entries(source)) {
    if (UNSAFE_KEYS.has(key)) continue;
    target[key] = isPlainObject(value) && isPlainObject(target[key]) ? mergeDeep(target[key], value) : value;
  }
  return target;
}

/** 套用一条命令；返回 true 表示「这条命令归我们管」。 */
export function applyNsCommand(statData, command, path) {
  const type = String(command?.type || '').toLowerCase();
  const args = Array.isArray(command?.args) ? command.args : [];
  const target = String(path ?? '');
  const owned = ownedPathOf(target);
  // 间章时段之外，模型写 `间章.*` 一律忽略：那些字段只在这段幕里有效，别让它留下脏状态。
  if (!interludeWritesAllowed && (owned === `${NS}.${INTERLUDE}` || owned.startsWith(`${NS}.${INTERLUDE}.`))) {
    return true;
  }
  if (PLUGIN_OWNED.has(owned)) {
    console.debug(`[故事导演] 忽略 AI 对导演专有字段的写入：${target}`);
    return true;
  }
  if (type === 'set') {
    if (args.length < 2) return true;
    const previous = getPath(statData, target);
    setPath(statData, target, coerceFieldValue(target, parseCommandLiteral(args[args.length - 1]), previous));
    return true;
  }
  if (type === 'add') {
    if (args.length < 2) return true;
    const previous = Number(unwrap(getPath(statData, target))) || 0;
    const delta = Number(parseCommandLiteral(args[1])) || 0;
    setPath(statData, target, coerceFieldValue(target, previous + delta, previous));
    return true;
  }
  if (type === 'insert' || type === 'assign') {
    if (args.length >= 3) {
      const key = parseCommandLiteral(args[1]);
      const value = parseCommandLiteral(args[2]);
      const collection = getPath(statData, target);
      if (Array.isArray(collection) && (typeof key === 'number' || key === '-')) {
        collection.splice(key === '-' ? collection.length : Number(key), 0, value);
        return true;
      }
      if (!isPlainObject(collection)) setPath(statData, target, {});
      const box = getPath(statData, target);
      const field = String(key);
      const previous = box[field];
      const next = coerceFieldValue(field, value, previous);
      box[field] = isPlainObject(next) && isPlainObject(previous) ? mergeDeep(previous, next) : next;
      return true;
    }
    const value = parseCommandLiteral(args[1]);
    const collection = getPath(statData, target);
    if (Array.isArray(collection)) { collection.push(value); return true; }
    if (isPlainObject(collection) && isPlainObject(value)) { mergeDeep(collection, value); return true; }
    setPath(statData, target, value);
    return true;
  }
  if (type === 'delete' || type === 'remove' || type === 'unset') {
    if (args.length >= 2) {
      const key = parseCommandLiteral(args[1]);
      const collection = getPath(statData, target);
      if (Array.isArray(collection)) {
        const index = Number(key);
        if (Number.isInteger(index) && index >= 0 && index < collection.length) collection.splice(index, 1);
        return true;
      }
      if (isPlainObject(collection) && key !== undefined && key !== null) delete collection[String(key)];
      return true;
    }
    unsetPath(statData, target);
    return true;
  }
  return false;
}

/**
 * 主入口：把属于 `故事导演` 的命令自己套用到 statData，并**原地**把它们从 commands 里摘掉。
 * 返回 { owned, applied }。
 */
export function applyNsCommands(statData, commands) {
  if (!isPlainObject(statData) || !Array.isArray(commands) || !commands.length) return { owned: 0, applied: 0 };
  const mine = [];
  const rest = [];
  for (const command of commands) {
    const path = nsPathOfCommand(command);
    if (path === null) rest.push(command);
    else mine.push({ command, path });
  }
  if (!mine.length) return { owned: 0, applied: 0 };
  let applied = 0;
  for (const { command, path } of mine) {
    const before = JSON.stringify(statData[NS] ?? null);
    try {
      applyNsCommand(statData, command, path);
    } catch (error) {
      console.debug(`[故事导演] 套用命令失败（已忽略）：${command?.full_match ?? path}`, error);
    }
    if (JSON.stringify(statData[NS] ?? null) !== before) applied++;
  }
  commands.length = 0;
  commands.push(...rest);
  return { owned: mine.length, applied };
}

/** 找到与 startPos 处开括号配对的闭括号（跳过引号内部；找不到返回 -1）。 */
function findMatchingCloseParen(str, startPos) {
  let depth = 1;
  let quote = '';
  for (let i = startPos; i < str.length; i++) {
    const ch = str[i];
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') { depth--; if (!depth) return i; }
  }
  return -1;
}

/** 按顶层逗号切参数（引号/括号内的逗号不算）。 */
export function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let quote = '';
  let current = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      current += ch;
      if (ch === '\\') { current += text[i + 1] ?? ''; i++; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; current += ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') { depth++; current += ch; continue; }
    if (ch === ')' || ch === ']' || ch === '}') { depth--; current += ch; continue; }
    if (ch === ',' && depth === 0) { parts.push(current.trim()); current = ''; continue; }
    current += ch;
  }
  if (current.trim() !== '') parts.push(current.trim());
  return parts;
}

/**
 * 从正文里抠出属于我们命名空间的 MVU 命令（MVU 事件没送到时的兜底）。
 * 会自动跳过 fenced code block 里的示例，免得把「示例命令」当成真命令。
 */
export function extractNsCommands(text) {
  const source = String(text ?? '');
  const out = [];
  let i = 0;
  while (i < source.length) {
    const match = source.substring(i).match(/_\.(set|insert|assign|add|remove|delete|unset)\(/);
    if (!match || match.index === undefined) break;
    const start = i + match.index;
    const open = start + match[0].length;
    const close = findMatchingCloseParen(source, open);
    if (close === -1) { i = open; continue; }
    if (source[close + 1] !== ';') { i = close + 1; continue; }
    if (insideFence(source, start)) { i = close + 2; continue; }
    const args = splitTopLevel(source.slice(open, close));
    const full_match = source.slice(start, close + 1) + ';';
    i = close + 2;
    if (!args.length || nsPathOfCommand({ args }) === null) continue;
    out.push({ type: match[1], full_match, args, reason: '' });
  }
  return out;
}

/**
 * 位置是否落在 ``` 围栏里，或落在一行里未闭合的行内 `code` 里。
 * 注入块把示例命令写成 `` `_.set(...)` ``，模型整段抄回去时不该被当成真命令。
 *
 * ⚠ 早期版本是「数全文反引号奇偶」，正文里随便一个落单的反引号就会把后面所有真命令一起吞掉
 *（而这正是兜底路径存在的意义）。现在按行判定：
 *   · 行内：这一行里、位置之前有奇数个反引号 → 还在行内代码里；
 *   · 围栏：整个文本里 ``` 的个数为奇数 → 还在围栏里。
 */
function insideFence(source, index) {
  const before = source.slice(0, index);
  const fences = before.match(/^\s*```/gm);
  if (fences && fences.length % 2 === 1) return true;
  const line = before.slice(before.lastIndexOf('\n') + 1);
  const inline = line.match(/`/g);
  return !!inline && inline.length % 2 === 1;
}

/** 世界书条目 → 一段纯文本（给神谕当规则来源）。 */
export function worldbookDigest(entries) {
  const list = Array.isArray(entries) ? entries : [];
  return list
    .filter((entry) => entry && typeof entry.content === 'string' && entry.content.trim())
    .map((entry) => {
      const title = String(entry.comment ?? entry.name ?? '').trim();
      return title ? `## ${title}\n${entry.content.trim()}` : entry.content.trim();
    })
    .join('\n\n');
}
