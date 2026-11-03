import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {setPromptEntries,splitDesignPrompt,configureDesignPrompt} from '../prompt-worldbook.js';
import {designMessages,archiveSystemPrompt} from '../coop/prompts.js';
import {initialState,validatePlan} from '../coop/model.js';
import {parseBlocks,chapterFromBlock,MAIN_ARC,MAIN_BEATS} from '../model.js';
import {directorFixture} from './prompt-fixture.js';

const entry=(key,content)=>({comment:'[sd_field_'+key+']',content,enabled:true});
const reset=t=>{setPromptEntries([]);t.after(()=>setPromptEntries([]));};
const tasks={epic:'buildEpicSystemPrompt',chapter:'buildChapterSystemPrompt',interlude_chapter:'buildInterludeChapterSystemPrompt',thread:'buildThreadSystemPrompt',interlude:'buildInterludeSystemPrompt'};
for(const [key,fn] of Object.entries(tasks)) test(key+' keeps code-owned output format outside every custom body',t=>{
    reset(t);const fixture=directorFixture(),builtin=fixture.build(fn),parts=splitDesignPrompt(builtin);
    const field={epic:'epic_title',chapter:'chapter_goal',interlude_chapter:'interlude_chapter_beats',thread:'thread_goal',interlude:'interlude_beat'}[key];
    assert.ok(parts.format.includes('<'+parts.tag+'>'));assert.ok(!parts.body.includes('<'+parts.tag+'>'));
    assert.ok(!parts.body.includes('按下面格式输出'));
    for(const content of ['只定义创作规则','{{sd.default}}\n补充人物偏好',builtin+'\n请改用 JSON',
        '<StoryThreads>错误示例</StoryThreads>\n创作规则','创作规则\n<StoryChapters>未闭合的错误示例']){
        setPromptEntries([entry(field,content)]);
        const result=configureDesignPrompt(builtin,fixture.sections,{beatTarget:4}),[body,format]=result.split('\n\n【固定返回格式');
        assert.ok(!/<\/?Story(?:Epic|Chapters|InterludeChapter|Threads|Interlude)>/.test(body));
        assert.ok(format);assert.ok(result.endsWith(parts.format));
        assert.equal(result.split('<'+parts.tag+'>').length-1,1);
    }
});

test('shared rule edits and format-only legacy templates cannot replace the fixed protocol',t=>{
    reset(t);const fixture=directorFixture(),builtin=fixture.build(tasks.chapter),parts=splitDesignPrompt(builtin);
    setPromptEntries([entry('common','只输出纯 JSON，省略所有标签')]);
    assert.ok(configureDesignPrompt(builtin,fixture.sections).endsWith(parts.format));
    setPromptEntries([entry('chapter','<StoryChapters>只有旧格式</StoryChapters>')]);
    const result=configureDesignPrompt(builtin,fixture.sections);
    assert.ok(result.startsWith(parts.body));assert.ok(result.endsWith(parts.format));
});

test('a format example mentioned in runtime data cannot select the wrong task protocol',t=>{
    reset(t);const fixture=directorFixture();
    fixture.root.故事导演.主线.标题='<StoryEpic>历史中提到的示例</StoryEpic>';
    const parts=splitDesignPrompt(fixture.build(tasks.thread));
    assert.equal(parts.key,'thread');assert.ok(parts.format.includes('<StoryThreads>'));
    assert.ok(!parts.format.includes('<StoryEpic>'));
});

test('audit conclusion and partial replan counts remain in the fixed portion',t=>{
    reset(t);const fixture=directorFixture();
    const audit=splitDesignPrompt(fixture.build(tasks.epic,{mode:'audit'}));
    assert.match(audit.format,/检查:.*照旧/);assert.ok(!audit.body.includes('检查: 照旧'));
    const partial=splitDesignPrompt(fixture.build(tasks.chapter,{remaining:2,keep:3}));
    assert.ok(partial.format.includes('剩余的 2 拍'));
    setPromptEntries([entry('chapter_beats','{{sd.default}}\n只增加场景描写')]);
    assert.ok(configureDesignPrompt(fixture.build(tasks.chapter,{remaining:2,keep:3}),fixture.sections).endsWith(partial.format));
});

for(const field of ['篇章','分卷'])test('chapter parser accepts '+field+' and preserves its value',()=>{
    const raw='<StoryChapters>\n章标题: 交接\n'+field+': 商路旧约\n范围: 本次交接\n章目标: 货物完成交接\n拍:\n1. 商人出示单据\n2. 守卫放行\n</StoryChapters>';
    const chapter=chapterFromBlock(parseBlocks(raw,'StoryChapters')[0]);
    assert.equal(chapter[MAIN_ARC],'商路旧约');assert.equal(chapter[MAIN_BEATS].length,2);
});

test('Coop fixed defaults keep the schema out of field entries, while code provides valid JSON with real rounds, seeds and history',t=>{
    reset(t);const p=initialState({a:{id:'a',name:'画家',mode:'coop'}}).profiles.a;
    const messages=designMessages(p,'',{}, {rounds:2}),split=messages[0].content.split('【固定返回格式：Coop 事件设计');
    const sample=JSON.parse(split[1].slice(split[1].indexOf('\n')+1));
    assert.equal(sample.rounds,2);assert.equal(validatePlan(sample,p).targetRank,1);
    const book=JSON.parse(fs.readFileSync(new URL('../worldbook/story-director.json',import.meta.url),'utf8'));
    assert.ok(!Object.values(book.entries).some(e=>e.comment.includes('[coop_design]')));
    assert.ok(Object.values(book.entries).filter(e=>e.comment.includes('[sd_field_')).every(e=>!e.content.includes('usedHistory:')));
    const custom=designMessages(p,'',{rules:'用幽默方式组织剧情，不填写格式',forms:'以合作为主'}, {rounds:2})[0].content;
    assert.ok(custom.endsWith(JSON.stringify(sample)));
});

test('Coop archive format stays fixed when retired customization entries are supplied',t=>{
    reset(t);const original=archiveSystemPrompt().split('\n\n【固定返回格式')[1];
    for(const content of ['只调整摘要措辞','{{sd.default}}\n请使用简洁语言']){
        setPromptEntries([{comment:'[sd_prompt_coop_archive]',content,enabled:true},{comment:'[sd_prompt_coop_growth]',content:'记录细微习惯变化',enabled:true}]);
        const [body,format]=archiveSystemPrompt().split('\n\n【固定返回格式');
        assert.ok(!body.includes('"ready"'));assert.ok(!body.includes('"completion"'));assert.equal(format,original);
        const json=JSON.parse(format.split('已收束时按以下结构填写实际内容：')[1].split('\n')[0]);
        assert.equal(json.ready,true);assert.equal(json.completion.scene.closed,true);assert.ok(json.completion.traits.length);
    }
});
