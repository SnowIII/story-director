import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as model from '../model.js';

const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const { NS, EPIC, EP, INTERLUDE, IL, MAIN_TITLE, MAIN_BEATS, MAIN_CLOSED, KEY_BEAT, KEY_CHAPTER_DONE, KEY_READY } = model;
const epicReply = '<StoryEpic>\n标题: 新的一部\n篇章: 新的矛盾与因果\n章内容:\n1. 新的起因与落点\n</StoryEpic>';

// 执行实际编排函数，隔离酒馆导入、网络与界面；沿用已有 host / MVU 测试的 VM 方式。
function functionSource(name) {
    const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
    assert.ok(start >= 0, name);
    return source.slice(start, source.indexOf('\n}\n', start) + 2);
}

function fixture(overrides = {}) {
    const calls = [], notices = [], cancelled = Symbol('cancelled');
    const main = { ...model.emptyMain(), [MAIN_TITLE]: '当前章', [MAIN_BEATS]: ['第一拍', '第二拍'], [KEY_BEAT]: 2 };
    const epic = { ...model.emptyEpic(), [EP.title]: '旧篇章', [EP.line]: '旧的矛盾', [EP.chapters]: ['旧章一', '旧章二'], [EP.chapter]: 0 };
    const s = {
        enabled: true, autoDirector: true, autoChapter: true, autoEpic: true, autoInterludeChapter: true,
        chapterGap: 4, chaptersPerEpic: 4, chapters: {},
        run: { chatId: 'chat', aftermathAt: 9, lastGenerateAt: 9, closedChapter: '', retiredEpics: [] },
        story: { 主线: main, [EPIC]: epic, [INTERLUDE]: model.emptyInterlude() }, ...overrides,
    };
    let scope = 'chat', generated = true;
    const root = { [NS]: s.story };
    const context = vm.createContext({
        ...model, console: { info() {}, debug() {} }, coop: null, panel: null,
        settings: () => s, rootOf: () => root, mainState: () => model.mainOf(root),
        chatKey: () => scope, aiMessageCount: () => 10,
        mvu: () => ({ getMvuData() {} }), mvuData: () => ({ stat_data: {} }), oracleApi: () => ({ run() {} }),
        patchMain: async fields => { Object.assign(main, fields); },
        patchInterlude: async fields => { Object.assign(s.story[INTERLUDE], fields); },
        patchEpic: async fields => { Object.assign(epic, fields); },
        writeStory: async apply => { apply(root); },
        save: () => calls.push('save'), render() {}, syncMainInjection() {}, syncInterludeWrites() {},
        currentMode: () => model.interludeActive(root) ? 'interlude' : 'main',
        needsArming: () => false, repairRunCursors: () => false, pruneDiscardedEpics: () => false,
        syncBeatBackOnRollback: () => false, handleBeatReview: async () => false, sweepThreads: async () => {},
        noteBlock() {}, landingReportedByReply: () => null, FOCUS_STALE_REPLIES: 3,
        isPending: () => false, isBackingOff: () => false, markPending() {}, clearPending() {}, clearFailed() {},
        beginGenerate: () => 1, endGenerate() {}, markFailed() {}, markFailedFromError() {},
        ORACLE_CANCELLED: cancelled, justAborted: () => false, toast: message => notices.push(message),
        buildEpicSystemPrompt: () => '', reportBlockFailure() {},
        noteGenerateFailure: () => ({ kind: 'other' }), failureToastText: () => '生成失败',
        askOracle: async () => { calls.push('oracle'); return epicReply; },
        generateChapter: async () => { calls.push('chapter'); return generated; },
        generateInterludeChapter: async () => {
            calls.push('interlude');
            if (generated) {
                s.story[INTERLUDE][IL.active] = true;
                main[MAIN_CLOSED] = true;
                main[KEY_READY] = false;
            }
            return generated;
        },
        collectContextBlocks: async () => [], pinnedAskText: () => '',
        esc: String, BOOK_MODES: {}, ORACLE_WORLDINFO_MODES: {},
    });
    const names = ['finishChapter', 'evaluateDirector', 'endInterludeNow', 'switchMode', 'rememberChapter',
        'rememberInterlude', 'archiveFinishedEpic', 'rememberRetiredEpic', 'epicIsArchived', 'ensureClosingChapter',
        'generateEpic', 'applyEpic', 'antiRepeatBlock', 'buildUserPrompt', 'chaptersPerEpic', 'renderSetTab',
        'markGenerated', 'blockedByCooldown'];
    vm.runInContext('let evaluating = false, closingChapterTask = null;\n' + names.map(functionSource).join('\n'), context);
    return { context, s, main, epic, calls, notices, cancelled,
        switchChat: () => { scope = 'other'; }, generation: ok => { generated = ok; } };
}

test('manual chapter finish bypasses aftermath wait and enters an interlude only once', async () => {
    const h = fixture();
    await h.context.finishChapter();
    assert.deepEqual(h.calls.filter(call => call !== 'save'), ['interlude']);
    assert.equal(h.s.run.closedChapter, '主线:当前章');
    assert.equal(h.epic[EP.chapter], 1);
    assert.equal(Object.keys(h.s.chapters).length, 1);
});

test('finishing the last chapter enters its interlude before establishing the next epic', async () => {
    const h = fixture(); h.epic[EP.chapter] = 1;
    await h.context.finishChapter();
    assert.deepEqual(h.calls.filter(call => call !== 'save'), ['interlude']);
    assert.equal(h.epic[EP.title], '旧篇章');
    assert.equal(h.s.run.retiredEpics[0].why, 'finished');
});

test('manual chapter finish opens the next chapter when interludes are disabled', async () => {
    const h = fixture({ autoInterludeChapter: false });
    await h.context.finishChapter();
    assert.deepEqual(h.calls.filter(call => call !== 'save'), ['chapter']);
});

for (const flags of [{ autoDirector: false }, { autoChapter: false }]) {
    test('manual chapter finish records history without generating, ' + JSON.stringify(flags), async () => {
        const h = fixture(flags);
        await h.context.finishChapter();
        assert.deepEqual(h.calls.filter(call => call !== 'save'), []);
        assert.equal(h.s.run.closedChapter, '主线:当前章');
        assert.equal(h.main[KEY_CHAPTER_DONE], true);
        assert.equal(h.epic[EP.chapter], 1);
        assert.equal(Object.keys(h.s.chapters).length, 1);
    });
}

test('a failed manual closure can be retried without duplicating history or epic progress', async () => {
    const h = fixture(); h.generation(false);
    await h.context.finishChapter();
    assert.equal(h.s.run.closedChapter, '');
    h.generation(true); await h.context.finishChapter();
    assert.deepEqual(h.calls.filter(call => call !== 'save'), ['interlude', 'interlude']);
    assert.equal(h.epic[EP.chapter], 1);
    assert.equal(Object.keys(h.s.chapters).length, 1);
});

for (const autoDirector of [true, false]) for (const autoChapter of [true, false]) {
    test(`manual return leaves the interlude with autoDirector=${autoDirector}, autoChapter=${autoChapter}`, async () => {
        const h = fixture({ autoDirector, autoChapter });
        Object.assign(h.s.story[INTERLUDE], { [IL.active]: true, [IL.title]: '日常间章', [IL.beats]: ['尚未演完的画面'] });
        await h.context.endInterludeNow();
        assert.equal(h.s.story[INTERLUDE][IL.active], false);
        assert.equal(h.s.run.mode, 'main');
        assert.equal(h.s.run.closedChapter, '间章:日常间章');
        assert.deepEqual(h.calls.filter(call => call !== 'save'), autoChapter ? ['chapter'] : []);
        assert.equal(Object.values(h.s.chapters)[0].类型, '间章');
        assert.equal(h.epic[EP.chapter], 0, 'interludes do not count towards epic progress');
        if (!autoChapter) assert.match(h.notices.at(-1), /自动换章已关闭/);
    });
}

test('returning from the final interlude establishes the next epic after the interlude is recorded', async () => {
    const h = fixture(); h.epic[EP.chapter] = 1;
    await h.context.finishChapter();
    h.s.story[INTERLUDE][IL.title] = '终章后的日常';
    await h.context.endInterludeNow();
    assert.deepEqual(h.calls.filter(call => call !== 'save'), ['interlude', 'oracle']);
    assert.equal(h.epic[EP.title], '新的一部');
    assert.equal(h.s.run.retiredEpics.length, 1);
    assert.equal(Object.keys(h.s.chapters).length, 2);
});

for (const aborted of [true, false]) {
    test('a failed manual return preserves the exit without claiming a new chapter, aborted=' + aborted, async () => {
        const h = fixture({ autoDirector: false }); h.generation(false);
        Object.assign(h.s.story[INTERLUDE], { [IL.active]: true, [IL.title]: '日常间章' });
        h.context.justAborted = () => aborted;
        await h.context.endInterludeNow();
        assert.equal(h.s.story[INTERLUDE][IL.active], false);
        assert.equal(h.s.run.closedChapter, '');
        assert.equal(h.notices.some(message => message.includes('新章未生成')), !aborted);
    });
}

test('manual return cannot mark a different chat as closed after generating', async () => {
    const h = fixture();
    Object.assign(h.s.story[INTERLUDE], { [IL.active]: true, [IL.title]: '日常间章' });
    h.context.generateChapter = async () => { h.switchChat(); return true; };
    await h.context.endInterludeNow();
    assert.equal(h.s.run.closedChapter, '');
});

for (const failure of ['cancelled', 'null', 'network', 'invalid', 'chat-switch', 'apply', 'apply-chat-switch']) {
    test('establishing an epic does not retire the current epic on ' + failure, async () => {
        const h = fixture(); h.epic[EP.chapter] = 2;
        h.context.askOracle = async () => {
            assert.equal(h.s.run.retiredEpics.length, 0, 'no retirement while the request is in flight');
            if (failure === 'cancelled') return h.cancelled;
            if (failure === 'null') return null;
            if (failure === 'network') throw new Error('offline');
            if (failure === 'invalid') return 'unparseable';
            if (failure === 'chat-switch') h.switchChat();
            return epicReply;
        };
        if (failure === 'apply') h.context.applyEpic = async () => { throw new Error('save failed'); };
        if (failure === 'apply-chat-switch') h.context.applyEpic = async () => { h.switchChat(); return true; };
        assert.equal(await h.context.generateEpic({ mode: 'establish' }), false);
        assert.equal(h.epic[EP.title], '旧篇章');
        assert.equal(h.s.run.retiredEpics.length, 0);
        assert.equal(h.context.epicIsArchived(h.epic), false);
    });
}

for (const written of [0, 2]) {
    test('a successfully adopted epic retires its predecessor with progress=' + written, async () => {
        const h = fixture(); h.epic[EP.chapter] = written;
        h.context.askOracle = async () => {
            assert.equal(h.s.run.retiredEpics.length, 0);
            return epicReply;
        };
        assert.equal(await h.context.generateEpic(), true);
        assert.equal(h.epic[EP.title], '新的一部');
        assert.equal(h.s.run.retiredEpics[0].title, '旧篇章');
        assert.equal(h.s.run.retiredEpics[0].why, written === 2 ? 'finished' : 'replaced');
    });
}

test('replacement prompts retain the current chapter table without persisting retirement', async () => {
    const h = fixture();
    h.s.run.retiredEpics = [{ title: '旧篇章', chapters: ['旧章一', '旧章二'], why: 'finished' }];
    const before = JSON.stringify(h.s.run.retiredEpics);
    const prompt = await h.context.buildUserPrompt('epic', '', { replacingEpic: true });
    assert.match(prompt, /旧章一/);
    assert.match(prompt, /旧章二/);
    assert.equal((prompt.match(/上一部篇章/g) || []).length, 1, 'the current epic is not repeated');
    assert.equal(JSON.stringify(h.s.run.retiredEpics), before);
    h.s.run.retiredEpics = [];
    assert.match(await h.context.buildUserPrompt('epic', '', { replacingEpic: true }), /旧章一/);
    assert.equal(h.s.run.retiredEpics.length, 0);
});

test('settings-tab chapter count changes are saved as bounded integers', () => {
    const h = fixture(), listeners = new Map();
    const node = { addEventListener: (event, handler) => listeners.set(event, handler) };
    const host = { innerHTML: '', querySelector: selector =>
        selector === '[name="chapters-per-epic"]' && host.innerHTML.includes('name="chapters-per-epic"') ? node : null };
    h.context.panel = { querySelector: selector => selector === '.sd-set-tab' ? host : null };
    h.context.renderSetTab();
    assert.equal(typeof listeners.get('change'), 'function');
    for (const [value, expected] of [['7', 7], ['99', 12], ['0', 1], ['3.6', 4]]) {
        const saved = h.calls.length;
        listeners.get('change')({ target: { value } });
        assert.equal(h.s.chaptersPerEpic, expected);
        assert.equal(h.calls.length, saved + 1);
    }
});
