import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {setPromptEntries,applyPromptTemplate,configureDesignPrompt,splitDesignPrompt,FIELD_PROMPTS} from '../prompt-worldbook.js';
import {initialState,clone} from '../coop/model.js';
import {affinityContract,directorReportContract,archiveSystemPrompt,growthRule} from '../coop/prompts.js';
import {renderInjectionHeader,renderContractSection} from '../model.js';
import {directorFixture} from './prompt-fixture.js';
import {CoopRuntime} from '../coop/runtime.js';
const bundled=JSON.parse(fs.readFileSync(new URL('../worldbook/story-director.json',import.meta.url),'utf8'));
const entries=()=>Object.values(clone(bundled).entries);
const entry=(key,content,on=true)=>({comment:'[sd_field_'+key+']',content,enabled:on});
const reset=t=>{setPromptEntries([]);t.after(()=>setPromptEntries([]));};

test('field variables expand as plain text and preserve Tavern macros and literal dollar symbols',t=>{
    reset(t);setPromptEntries([entry('chapter_goal','{{user}} / {{sd.remaining}} / $& / {{sd.unknown}}')]);
    assert.equal(applyPromptTemplate('chapter_goal','原文',{variables:{remaining:2}}),'{{user}} / 2 / $& / {{sd.unknown}}');
    setPromptEntries([entry('chapter_goal','{{sd.default}}\n附加偏好')]);
    assert.equal(applyPromptTemplate('chapter_goal','原文'),'原文\n附加偏好');
});
test('all retired shared, whole-task, narration, review and Coop entries are ignored',t=>{
    reset(t);const fixture=directorFixture(),builtin=fixture.build('buildChapterSystemPrompt');
    const profile=initialState({a:{id:'a',name:'画家',mode:'coop'}}).profiles.a;
    const snapshot={nonce:'n',reportChannel:'director',roles:{a:{mvuKey:'画家'}}};
    const output=()=>[configureDesignPrompt(builtin,fixture.sections),renderInjectionHeader().join('\n'),renderInjectionHeader({mode:'interlude'}).join('\n'),
        renderContractSection({beat:'守卫递信'}).join('\n'),affinityContract([profile],snapshot),directorReportContract({id:'e',characterId:'a',phase:'resolution'},snapshot),archiveSystemPrompt()];
    const expected=output();
    setPromptEntries(['common','tone_guard','beat_format','design_both','design_arc','design_beats','design_side','epic','chapter','interlude_chapter','thread','interlude',
        'narration_main','narration_interlude','main_review','coop_affinity','coop_growth','coop_archive'].map(key=>({comment:'[sd_prompt_'+key+']',content:'不应生效的旧规则',enabled:true})));
    assert.deepEqual(output(),expected);assert.ok(archiveSystemPrompt().includes(growthRule));
});
test('audit and partial replan retain task, live counts, rejection evidence and played-history protection',t=>{
    reset(t);const fixture=directorFixture();setPromptEntries([entry('epic_chapters','各章用人物线组织'),entry('chapter_beats','每拍用观察与行动组织')]);
    const audit=configureDesignPrompt(fixture.build('buildEpicSystemPrompt',{mode:'audit'}),fixture.sections,{epicMode:'audit',chaptersPerEpic:6});
    assert.ok(audit.includes('检查这一部篇章还成不成立'));assert.ok(audit.includes('单独写一行结论'));assert.ok(audit.includes('"chaptersPerEpic":6'));
    const partial=configureDesignPrompt(fixture.build('buildChapterSystemPrompt',{remaining:2,keep:3}),fixture.sections,{remaining:2,keep:3,rejected:{note:'地点已改变'}});
    assert.ok(partial.includes('已经演过的部分不许动'));assert.ok(partial.includes('"keep":3'));assert.ok(partial.includes('"remaining":2'));assert.ok(partial.includes('地点已改变'));
    assert.ok(partial.endsWith(splitDesignPrompt(fixture.build('buildChapterSystemPrompt',{remaining:2,keep:3})).format));
});
test('fresh worldbook reads apply field edits and clear disabled entries without evaluating text',async t=>{
    reset(t);const {source}=directorFixture();let book=[entry('chapter_goal','新字段规则')];
    const start=source.indexOf('async function readOurWorldbookEntries()'),end=source.indexOf('// 阶段六：注入',start);
    const context=vm.createContext({PLUGIN_WORLD:'故事导演',setPromptEntries,console,world_info:{},window:{TavernHelper:{getWorldbook:async()=>book}}});
    vm.runInContext(source.slice(start,end),context);await vm.runInContext('readOurWorldbookEntries()',context);
    assert.equal(applyPromptTemplate('chapter_goal','默认'),'新字段规则');book=[entry('chapter_goal','新字段规则',false)];
    await vm.runInContext('readOurWorldbookEntries()',context);assert.equal(applyPromptTemplate('chapter_goal','默认'),'默认');
    const declaration=source.match(/const plot = ours\.filter\([^\n]+/)[0];
    const plot=vm.runInNewContext(declaration+'\nplot;',{ours:[...entries(),{comment:'[sd_prompt_epic]',content:'旧规则'},
        {comment:'[coop_forms]',content:'旧形式库'},{comment:'普通剧情',content:'背景'}]});
    assert.equal(plot.length,1);assert.equal(plot[0].comment,'普通剧情');
});
test('Oracle transport uses freshly read field rules in its one existing request and falls back when disabled',async t=>{
    reset(t);const fixture=directorFixture(),requests=[];let on=true,reads=0;
    Object.assign(fixture.context,{oracleApi:()=>({run:async messages=>{requests.push(messages);return '<StoryChapters>测试响应</StoryChapters>';}}),
        genId:1,genCtl:null,genAborted:false,chatKey:()=> 'test',lastRequestChars:0,console,ORACLE_CANCELLED:'cancelled',providerErrorOf:()=>'',
        buildUserPrompt:async()=>{reads++;setPromptEntries([entry('chapter_goal','新读入的字段规则',on)]);return '本次真实上下文';}});
    const start=fixture.source.indexOf('function configuredSystemPrompt('),end=fixture.source.indexOf('function providerErrorOf(',start);
    vm.runInContext(fixture.source.slice(start,end),fixture.context);
    await vm.runInContext("askOracle({task:'chapter',keep:3,remaining:2})",fixture.context);
    assert.equal(reads,1);assert.equal(requests.length,1);assert.ok(requests[0][0].content.includes('新读入的字段规则'));
    assert.ok(requests[0][0].content.includes('"keep":3'));assert.equal(requests[0][1].content,'本次真实上下文');
    on=false;await vm.runInContext("askOracle({task:'chapter'})",fixture.context);
    assert.equal(reads,2);assert.equal(requests.length,2);assert.ok(!requests[1][0].content.includes('新读入的字段规则'));
    assert.ok(requests[1][0].content.includes(FIELD_PROMPTS.chapter_goal.content));
});
test('narrative preparation refreshes current field choices while Coop rules stay fixed',async t=>{
    reset(t);const metadata={},messages=[{is_user:true,mes:'我来帮忙。'}];let on=true,reads=0;
    const host={scope:()=> 'prompt-refresh',metadata:()=>metadata,messages:()=>messages,context:()=>({}),available:()=>true,autoAllowed:()=>false,
        locks:{request:async(name,options,fn)=>fn({name})},persist:async doc=>{metadata.storyDirectorCoop=clone(doc);},
        refreshPrompts:async()=>{reads++;setPromptEntries([entry('chapter_goal','当前世界书的字段规则',on)]);}};
    const runtime=new CoopRuntime(host);t.after(()=>runtime.dispose());await runtime.load();
    const archive=archiveSystemPrompt();await runtime.prepare();assert.equal(reads,1);assert.equal(applyPromptTemplate('chapter_goal','默认'),'当前世界书的字段规则');
    on=false;await runtime.prepare();assert.equal(reads,2);assert.equal(applyPromptTemplate('chapter_goal','默认'),'默认');assert.equal(archiveSystemPrompt(),archive);
});
