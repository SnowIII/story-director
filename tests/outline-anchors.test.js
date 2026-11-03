import test from 'node:test';
import assert from 'node:assert/strict';
import {chapterFromBlock,normalizeChapter,anchorsOf,currentAnchor,renderMainSection,renderContractSection,
    MAIN_BEATS,MAIN_ANCHORS,KEY_BEAT,applyNsCommands,extractNsCommands} from '../model.js';
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
    assert.ok(on.includes('不得偷换结果'));assert.ok(on.includes('主动构思并写出合乎逻辑的剧情发展'));
    assert.ok(on.includes('动机、知情范围'));assert.ok(on.includes('人物为什么行动 → 采取什么行动'));
    assert.ok(on.includes('主动寻找另一条'));assert.ok(on.includes('缺少铺垫就安排合理的铺垫'));
    assert.ok(on.includes('不增加锚点逐项核销条件'));assert.ok(!on.includes('全部锚点已真实发生'));
    assert.ok(on.includes('玩家作选择'));assert.ok(on.includes('可跨轮完成'));
    assert.ok(!on.includes('要么写**别处正在发生的事**'));
    assert.ok(!on.includes('来信者身份明确'));
    chapter[KEY_BEAT]=3;assert.ok(!renderMainSection(chapter,{strengthenOutline:true}).lines.join('\n').includes('本拍剧情锚点'));
    assert.ok(!renderMainSection({[MAIN_BEATS]:[]},{strengthenOutline:true}).lines.join('\n').includes('本拍剧情锚点'));
});

test('anchor guidance leaves the extra variable model landing contract unchanged',()=>{
    const options={beat:'侍女递出旧信',landingBy:'extra'};
    const text=renderContractSection(options).join('\n');
    assert.equal(renderContractSection({...options,anchor:currentAnchor(plan())}).join('\n'),text);
    assert.ok(!text.includes('本拍剧情锚点'));assert.ok(!text.includes('大纲遵循强化'));
    assert.ok(text.includes('额外的变量模型'));assert.ok(text.includes('本拍已落'));
    for(const options of [{mode:'interlude',beat:'喝茶'},{mode:'coop',beat:'合作'},{beat:''}])
        assert.ok(!renderContractSection({...options,anchor:'不该出现的主线锚点'}).join('\n').includes('不该出现的主线锚点'));
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
