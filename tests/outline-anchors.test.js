import test from 'node:test';
import assert from 'node:assert/strict';
import {chapterFromBlock,normalizeChapter,anchorsOf,currentAnchor,renderMainSection,renderContractSection,
    MAIN_BEATS,MAIN_ANCHORS,KEY_BEAT,applyNsCommands,extractNsCommands,outlineAnchorIssue,
    parseOutlineReceipt,outlineReceiptAllowsLanding} from '../model.js';
import {setPromptEntries,configureDesignPrompt,splitDesignPrompt,FIELD_PROMPTS} from '../prompt-worldbook.js';
import {directorFixture} from './prompt-fixture.js';

const plan=()=>chapterFromBlock('章标题: 旧信\n拍:\n1. 侍女递出旧信\n2. 守卫辨认印章\n剧情锚点:\n1. 旧信交到守卫手中；来信者身份明确\n2. 印章确认为旧王室徽记');

test('chapter parsing saves distinct anchors and their internal details separately from beats',()=>{
    const chapter=plan();
    assert.deepEqual(chapter[MAIN_BEATS],['侍女递出旧信','守卫辨认印章']);
    assert.deepEqual(anchorsOf(chapter),['旧信交到守卫手中；来信者身份明确','印章确认为旧王室徽记']);
    assert.equal(currentAnchor(chapter),'旧信交到守卫手中；来信者身份明确');
    chapter[KEY_BEAT]=2;assert.equal(currentAnchor(chapter),'印章确认为旧王室徽记');
    chapter[KEY_BEAT]=3;assert.equal(currentAnchor(chapter),'');
});

test('missing and empty numbered anchors retain their positions rather than shifting later anchors',()=>{
    for(const raw of ['1. 甲\n3. 丙','1. 甲\n2.\n  3. 丙', ['甲','','丙']]){
        const chapter=normalizeChapter({beats:['拍一','拍二','拍三'],anchors:raw});
        assert.deepEqual(anchorsOf(chapter),['甲','','丙']);
        chapter[KEY_BEAT]=2;assert.equal(currentAnchor(chapter),'拍二');
    }
    assert.deepEqual(anchorsOf({[MAIN_ANCHORS]:'1. 甲\n1. 乙'}),[]);
});

test('legacy plans and wrapped MVU-style values remain usable without generating replacement anchors',()=>{
    const legacy=chapterFromBlock('章标题: 老章\n拍:\n1. 守卫开门\n2. 信使递信');
    assert.deepEqual(anchorsOf(legacy),[]);assert.equal(currentAnchor(legacy),'守卫开门');
    const wrapped={[MAIN_BEATS]:{value:['第一拍','第二拍']},[MAIN_ANCHORS]:{value:[{value:'锚一'},{value:'锚二'}]},[KEY_BEAT]:{value:2}};
    assert.equal(currentAnchor(wrapped),'锚二');
});

test('main injection strengthens only the current anchor when explicitly enabled',()=>{
    const chapter=plan();chapter[KEY_BEAT]=2;
    const off=renderMainSection(chapter).lines.join('\n');
    assert.ok(!off.includes('大纲遵循强化'));assert.ok(!off.includes('印章确认为旧王室徽记'));
    const on=renderMainSection(chapter,{strengthenOutline:true,focusStale:'同一拍停留多轮'}).lines.join('\n');
    assert.ok(on.includes('<本拍剧情锚点>印章确认为旧王室徽记</本拍剧情锚点>'));
    assert.ok(on.includes('章目标只用于判断方向'));
    assert.ok(on.includes('不是必须逐层轮转的状态机'));
    assert.ok(on.includes('旁白宣告、口头承诺和计划预告都不算'));
    assert.ok(on.includes('最小因果桥'));
    assert.ok(on.includes('把条件与局面递给他并停笔'));
    assert.ok(on.includes('可以跨多轮展开'));
    assert.ok(!renderMainSection(chapter,{outlineHold:'强化回执无效'}).lines.join('\n').includes('强化回执无效'));
    assert.ok(renderMainSection(chapter,{strengthenOutline:true,outlineHold:'强化回执无效'}).lines.join('\n').includes('强化回执无效'));
    assert.ok(!on.includes('要么写**别处正在发生的事**'));
    assert.ok(!on.includes('来信者身份明确'));
    chapter[KEY_BEAT]=3;assert.ok(!renderMainSection(chapter,{strengthenOutline:true}).lines.join('\n').includes('本拍剧情锚点'));
    assert.ok(!renderMainSection({[MAIN_BEATS]:[]},{strengthenOutline:true}).lines.join('\n').includes('本拍剧情锚点'));
});

test('outline strengthening adds a read-only anchor and preflight check without changing off or other modes',()=>{
    const options={beat:'侍女递出旧信',landingBy:'extra'};
    const text=renderContractSection(options).join('\n');
    assert.equal(renderContractSection({...options,anchor:currentAnchor(plan())}).join('\n'),text);
    assert.ok(!text.includes('本拍剧情锚点'));assert.ok(!text.includes('大纲遵循强化'));
    assert.ok(text.includes('额外的变量模型'));assert.ok(text.includes('本拍已落'));
    const strong=renderContractSection({...options,strengthenOutline:true,anchor:currentAnchor(plan())}).join('\n');
    assert.ok(strong.includes('<当前拍锚点>旧信交到守卫手中；来信者身份明确</当前拍锚点>'));
    assert.ok(strong.includes('当前拍锚点：旧信交到守卫手中；来信者身份明确'));
    assert.ok(strong.includes('本轮推进层级：前提 / 触发 / 反应 / 结果'));
    assert.ok(strong.includes('只负责“写之前检查怎么推进”'));
    assert.ok(!strong.includes('本拍完成：是 / 否'));
    assert.ok(!strong.includes('完成证据：'));
    assert.ok(strong.includes('最终正文的世界状态回报为准'));
    for(const options of [{mode:'interlude',beat:'喝茶'},{mode:'coop',beat:'合作'},{beat:''}])
        assert.ok(!renderContractSection({...options,anchor:'不该出现的主线锚点'}).join('\n').includes('不该出现的主线锚点'));
});

test('closing contract exists only for strengthened main chapters after the last beat',()=>{
    const normal=renderContractSection({beat:'',landingBy:'extra'}).join('\n');
    const strengthenedButNotClosing=renderContractSection({beat:'',landingBy:'extra',strengthenOutline:true}).join('\n');
    const closing=renderContractSection({beat:'',landingBy:'extra',strengthenOutline:true,chapterClosing:true}).join('\n');
    assert.equal(strengthenedButNotClosing,normal,'enabling strengthening alone must not change the legacy no-beat guard');
    assert.ok(normal.includes('不要写任何 `故事导演.*` 回报'));
    assert.ok(!normal.includes('章目标达成'));
    assert.ok(closing.includes('大纲遵循强化｜本章收尾阶段'));
    assert.ok(closing.includes('章目标达成'));
    assert.ok(closing.includes('可进下一章'));
    assert.ok(closing.includes('下一轮仍可补报'));
    assert.ok(!closing.includes('不要写任何 `故事导演.*` 回报'));
});

test('outline receipts require the current anchor, result stage, completion and visible evidence',()=>{
    const anchor='守卫收到旧信';
    const receipt=(stage='结果',complete='是',evidence='守卫把旧信锁进证物箱',verdict='通过')=>
        `<故事导演自检>\n当前拍锚点：${anchor}\n本轮推进层级：${stage}\n本拍完成：${complete}\n完成证据：${evidence}\n结论：${verdict}\n</故事导演自检>`;
    const valid=parseOutlineReceipt(receipt(),anchor);
    assert.ok(valid.valid);assert.ok(valid.landed);assert.ok(outlineReceiptAllowsLanding(valid));
    assert.equal(parseOutlineReceipt(receipt('触发'),anchor).landed,false);
    assert.equal(parseOutlineReceipt(receipt('结果','否'),anchor).landed,false);
    assert.equal(parseOutlineReceipt(receipt('结果','是','无'),anchor).landed,false);
    assert.equal(parseOutlineReceipt(receipt().replace(anchor,'另一封信'),anchor).valid,false);
    assert.equal(outlineReceiptAllowsLanding(parseOutlineReceipt(receipt('结果','是','守卫收下旧信','驳回'),anchor)),false);
});

test('one anchor is expected to contain one result; extra clauses receive a non-destructive warning',()=>{
    assert.equal(outlineAnchorIssue('守卫收到旧信'),'');
    assert.match(outlineAnchorIssue('守卫收到旧信；他当场认出寄信人'),/每拍只写一个可验证结果/);
});

test('landed beats do not demand an anchor checklist replay during the pacing hold',()=>{
    const main=renderMainSection(plan(),{strengthenOutline:true,landedHold:'第1拍'}).lines.join('\n');
    assert.ok(main.includes('本拍已经落地'));assert.ok(main.includes('不为补齐锚点重演本拍'));
    assert.ok(!main.includes('主动构思并写出合乎逻辑的剧情发展'));
});

test('custom anchor writing cannot remove the required result field or its beat mapping',t=>{
    setPromptEntries([]);t.after(()=>setPromptEntries([]));const f=directorFixture();
    const raw=f.build('buildChapterSystemPrompt',{keep:3,remaining:2}),format=splitDesignPrompt(raw).format;
    assert.ok(format.includes('剧情锚点:'));assert.ok(format.includes('剩余的 2 拍'));
    setPromptEntries([{name:'[sd_field_chapter_anchors]',enabled:true,content:'按「关键信息／局面变化」描述，省略编号。'}]);
    const text=configureDesignPrompt(raw,f.sections,{keep:3,remaining:2});
    assert.ok(text.includes('关键信息／局面变化'));assert.ok(!text.includes(FIELD_PROMPTS.chapter_anchors.content));
    assert.ok(text.includes('数量相同，两组都从 1 连续编号'));assert.ok(text.endsWith(format));
});

test('variable reports cannot overwrite plugin-owned anchor plans',()=>{
    const data={故事导演:{主线:{剧情锚点:['原锚点']}}};
    applyNsCommands(data,extractNsCommands("_.set('故事导演.主线.剧情锚点', ['伪造锚点']);"));
    assert.deepEqual(data.故事导演.主线.剧情锚点,['原锚点']);
});
