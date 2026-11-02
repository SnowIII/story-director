import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {PROMPT_SLOTS,setPromptEntries,applyPromptTemplate,configureDesignPrompt} from '../prompt-worldbook.js';
import {preserveDesignTemplates,designTemplates} from '../coop/design-worldbook.js';
import {initialState,clone,hash} from '../coop/model.js';
import {designMessages,affinityContract,directorReportContract,archiveSystemPrompt,growthRule} from '../coop/prompts.js';
import {renderInjectionHeader,renderContractSection} from '../model.js';
import {directorFixture} from './prompt-fixture.js';
import {CoopRuntime} from '../coop/runtime.js';

const bundled=JSON.parse(fs.readFileSync(new URL('../worldbook/story-director.json',import.meta.url),'utf8'));
const entries=()=>Object.values(clone(bundled).entries);
const entry=(key,content,on=true,raw=false)=>({comment:'[sd_prompt_'+key+']',content,...(raw?{disable:!on,enabled:!on}:{enabled:on})});
const reset=t=>{setPromptEntries([]);t.after(()=>setPromptEntries([]));};
const tasks={epic:'buildEpicSystemPrompt',chapter:'buildChapterSystemPrompt',interlude_chapter:'buildInterludeChapterSystemPrompt',thread:'buildThreadSystemPrompt',interlude:'buildInterludeSystemPrompt'};

test('every configurable prompt has a disabled non-triggering bundled entry with a default fingerprint',()=>{
    const prompts=entries().filter(e=>e.comment.startsWith('[sd_prompt_'));
    assert.equal(prompts.length,Object.keys(PROMPT_SLOTS).length);
    for(const e of prompts){assert.equal(e.enabled,false);assert.equal(e.disable,true);assert.equal(e.constant,false);assert.deepEqual(e.key,[]);
        assert.equal(e.sdPromptDefaultHash,hash(e.content.trim()));assert.ok(e.content.trim());}
});

for(const raw of [false,true])test('each prompt switch independently selects a replacement or its default, raw='+raw,t=>{
    reset(t);
    for(const key of Object.keys(PROMPT_SLOTS))for(const on of [false,true]){
        setPromptEntries([entry(key,'我的规则',on,raw)]);
        assert.equal(applyPromptTemplate(key,'原有规则'),on?'我的规则':'原有规则');
        assert.equal(applyPromptTemplate(key==='common'?'chapter':'common','另一默认'),'另一默认');
    }
    for(const content of ['', '  ',null,{},4]){setPromptEntries([entry('common',content)]);assert.equal(applyPromptTemplate('common','默认'),'默认');}
    setPromptEntries([entry('common','没有开启标志')].map(({comment,content})=>({comment,content})));
    assert.equal(applyPromptTemplate('common','默认'),'默认');
});

test('plugin macros expand as plain text and preserve Tavern macros, contracts and literal replacement symbols',t=>{
    reset(t);setPromptEntries([entry('chapter','{{user}} / {{sd.remaining}} / $& / {{sd.unknown}}')]);
    assert.equal(applyPromptTemplate('chapter','原文',{contract:'固定格式',variables:{remaining:2}}),'{{user}} / 2 / $& / {{sd.unknown}}\n\n固定格式');
    setPromptEntries([entry('chapter','{{sd.default}}\n附加偏好')]);
    assert.equal(applyPromptTemplate('chapter','原文',{contract:'原文已有的格式'}),'原文\n附加偏好');
});

test('literal replacement symbols survive shared-section and Coop growth composition',t=>{
    reset(t);const fixture=directorFixture(),literal='保留字面量 $& 和 $$，不插回旧规则';
    setPromptEntries([entry('common',literal),entry('coop_growth',literal)]);
    const designed=configureDesignPrompt(fixture.build(tasks.chapter),fixture.sections);
    assert.ok(designed.includes(literal));assert.ok(!designed.includes('铁律（对所有产出都有效）'));
    const p=initialState({a:{id:'a',name:'画家',mode:'coop'}}).profiles.a;
    assert.ok(designMessages(p,'',{rules:growthRule})[0].content.includes(literal));
});

for(const [key,fn] of Object.entries(tasks))test('custom '+key+' replaces design defaults while retaining current task and XML protocol',t=>{
    reset(t);const fixture=directorFixture(),builtin=fixture.build(fn);
    setPromptEntries([entry(key,'以轻松的人物合作为主，数量 {{sd.beatTarget}}。')]);
    const result=configureDesignPrompt(builtin,fixture.sections,{beatTarget:5});
    assert.ok(result.startsWith('以轻松的人物合作为主，数量 5。'));
    assert.ok(result.includes('【程序任务与输出契约'));
    assert.ok(!result.includes('===== 设计通则 ====='));
    const tag=builtin.match(/<(Story\w+)>/)[1];
    assert.equal(result.split('<'+tag+'>').length-1,1);assert.ok(result.includes('</'+tag+'>'));
    const block=builtin.match(/<Story\w+>[\s\S]*?<\/Story\w+>/)[0];
    for(const field of block.matchAll(/^([^\s<>:：]{1,20})[:：]/gm))assert.ok(result.includes(field[1]+':'));
    assert.ok(!result.includes('〔另一个舞台〕'));
});

test('shared sections only change prompts using that layer and default templates reproduce original prompts exactly',t=>{
    reset(t);const fixture=directorFixture();
    for(const allOn of [false,true]){
        setPromptEntries(entries().map(e=>({...e,enabled:allOn,disable:!allOn})));
        for(const fn of Object.values(tasks)){const raw=fixture.build(fn);assert.equal(configureDesignPrompt(raw,fixture.sections),raw);}
    }
    setPromptEntries([entry('design_arc','自定义篇章编排'),entry('design_beats','自定义拍设计')]);
    const epic=configureDesignPrompt(fixture.build(tasks.epic),fixture.sections),chapter=configureDesignPrompt(fixture.build(tasks.chapter),fixture.sections);
    assert.ok(epic.includes('自定义篇章编排'));assert.ok(!epic.includes('自定义拍设计'));
    assert.ok(chapter.includes('自定义拍设计'));assert.ok(!chapter.includes('自定义篇章编排'));
});

test('audit and partial replan keep runtime task, counts and preservation requirements when replacing the system prompt',t=>{
    reset(t);const fixture=directorFixture();setPromptEntries([entry('epic','检查用户选择带来的后果'),entry('chapter','只改变未演部分')]);
    const audit=configureDesignPrompt(fixture.build(tasks.epic,{mode:'audit'}),fixture.sections,{epicMode:'audit',chaptersPerEpic:6});
    assert.ok(audit.includes('检查这一部篇章还成不成立'));assert.ok(audit.includes('区块外再写一行'));assert.ok(audit.includes('"chaptersPerEpic":6'));
    const partial=configureDesignPrompt(fixture.build(tasks.chapter,{remaining:2,keep:3}),fixture.sections,{remaining:2,keep:3});
    assert.ok(partial.includes('已经演过的部分不许动'));assert.ok(partial.includes('"keep":3'));assert.ok(partial.includes('"remaining":2'));
});

test('narration replacements retain structural tags and live beat reporting; review edits retain the parser contract',t=>{
    reset(t);setPromptEntries([entry('narration_main','主线采用克制对白'),entry('narration_interlude','间章多用生活细节'),entry('main_review','按现场人物动机决定执行方式')]);
    const main=renderInjectionHeader().join('\n'),interlude=renderInjectionHeader({mode:'interlude'}).join('\n');
    assert.ok(main.startsWith('<story_director_status>\n主线采用克制对白'));assert.ok(main.includes('用户的言行'));
    assert.ok(interlude.includes('间章多用生活细节'));assert.ok(!interlude.includes('主线采用克制对白'));
    const contract=renderContractSection({beat:'守卫递出信件'}).join('\n');
    assert.ok(contract.includes('按现场人物动机决定执行方式'));assert.ok(contract.includes('<本轮这一拍>守卫递出信件</本轮这一拍>'));
    assert.ok(contract.includes('<故事导演自检>'));assert.ok(contract.includes('本拍已落'));
});

test('Coop policy edits reach numeric, design, report and archive prompts without replacing actors or evidence schemas',t=>{
    reset(t);setPromptEntries([entry('coop_affinity','普通感谢不加分'),entry('coop_growth','只记实际验证的习惯变化'),entry('coop_archive','摘要优先概括行动与结果')]);
    const p=initialState({a:{id:'a',name:'画家',mode:'coop'}}).profiles.a,snapshot={nonce:'n',reportChannel:'director',roles:{a:{mvuKey:'画家'}}};
    const score=affinityContract([p],snapshot);assert.ok(score.includes('普通感谢不加分'));assert.ok(score.includes('/故事导演/Coop/角色/画家/好感度'));assert.ok(score.includes('超过100'));
    for(const templates of [{},designTemplates(entries().map(e=>({...e,enabled:true,disable:false})),p)]){
        assert.ok(designMessages(p,'',templates)[0].content.includes('只记实际验证的习惯变化'));
        assert.ok(!designMessages(p,'',templates)[0].content.includes(growthRule));
    }
    const report=directorReportContract({id:'e',characterId:'a',phase:'resolution'},snapshot);
    assert.ok(report.includes('只记实际验证的习惯变化'));assert.ok(report.includes('<CoopReport>'));
    const archive=archiveSystemPrompt();assert.ok(archive.startsWith('摘要优先概括行动与结果'));assert.ok(archive.includes('【归档程序契约】'));
    assert.ok(archive.includes('blockingConflicts:[]'));assert.ok(archive.includes('不能代替眼前危机'));
});

test('upgrades preserve edited text and both API switch formats, upgrade default text, and leave old Coop templates intact',()=>{
    for(const raw of [false,true])for(const on of [false,true]){
        const old=entries(),target=old.find(e=>e.comment.includes('[sd_prompt_chapter]'));
        target.content='用户自己的章节提示词';Object.assign(target,raw?{disable:!on}:{enabled:on,disable:undefined});
        const unchanged=old.find(e=>e.comment.includes('[sd_prompt_common]'));unchanged.content='旧版默认';unchanged.sdPromptDefaultHash=hash(unchanged.content);
        const coop=old.find(e=>e.comment.includes('[coop_rank_7]'));coop.content='我的七阶规则';
        const upgraded=preserveDesignTemplates(clone(bundled),old),list=Object.values(upgraded.entries);
        const result=list.find(e=>e.comment.includes('[sd_prompt_chapter]'));
        assert.equal(result.content,'用户自己的章节提示词');assert.equal(result.enabled,on);assert.equal(result.disable,!on);
        assert.notEqual(list.find(e=>e.comment.includes('[sd_prompt_common]')).content,'旧版默认');
        assert.equal(list.find(e=>e.comment.includes('[coop_rank_7]')).content,'我的七阶规则');
    }
    const old=entries().filter(e=>!e.comment.startsWith('[sd_prompt_')),upgraded=preserveDesignTemplates(clone(bundled),old);
    assert.equal(Object.values(upgraded.entries).filter(e=>e.comment.startsWith('[sd_prompt_') && e.disable).length,18);
});

test('fresh worldbook reads apply edits and clear disabled templates without evaluating their content',async t=>{
    reset(t);const {source}=directorFixture();let book=[entry('common','新规则')];
    const start=source.indexOf('async function readOurWorldbookEntries()'),end=source.indexOf('// 阶段六：注入',start);
    const context=vm.createContext({PLUGIN_WORLD:'故事导演',setPromptEntries,console,world_info:{},window:{TavernHelper:{getWorldbook:async()=>book}}});
    vm.runInContext(source.slice(start,end),context);await vm.runInContext('readOurWorldbookEntries()',context);
    assert.equal(applyPromptTemplate('common','默认'),'新规则');book=[entry('common','新规则',false)];
    await vm.runInContext('readOurWorldbookEntries()',context);assert.equal(applyPromptTemplate('common','默认'),'默认');
    const declaration=source.match(/const plot = ours\.filter\([^\n]+/)[0];
    const plot=vm.runInNewContext(declaration+'\nplot;',{ours:[...entries(),{comment:'普通剧情',content:'背景'}]});
    assert.equal(plot.length,1);assert.equal(plot[0].comment,'普通剧情');
});

test('Oracle transport uses newly read replacements in its single existing request and disables them on the next request',async t=>{
    reset(t);const fixture=directorFixture(),requests=[];let on=true,reads=0;
    Object.assign(fixture.context,{oracleApi:()=>({run:async messages=>{requests.push(messages);return '<StoryChapters>测试响应</StoryChapters>';}}),
        genId:1,genCtl:null,genAborted:false,chatKey:()=> 'test',lastRequestChars:0,console,ORACLE_CANCELLED:'cancelled',providerErrorOf:()=>'',
        buildUserPrompt:async()=>{reads++;setPromptEntries([entry('chapter','新读入的规则',on)]);return '本次真实上下文';}});
    const start=fixture.source.indexOf('function configuredSystemPrompt('),end=fixture.source.indexOf('function providerErrorOf(',start);
    vm.runInContext(fixture.source.slice(start,end),fixture.context);
    await vm.runInContext("askOracle({task:'chapter',keep:3,remaining:2})",fixture.context);
    assert.equal(reads,1);assert.equal(requests.length,1);assert.ok(requests[0][0].content.startsWith('新读入的规则'));
    assert.ok(requests[0][0].content.includes('"keep":3'));assert.equal(requests[0][1].content,'本次真实上下文');
    on=false;await vm.runInContext("askOracle({task:'chapter'})",fixture.context);
    assert.equal(reads,2);assert.equal(requests.length,2);assert.ok(!requests[1][0].content.includes('新读入的规则'));
    assert.ok(requests[1][0].content.includes('你的唯一任务'));
});

test('each narrative preparation refreshes the worldbook before composing its live MVU rules',async t=>{
    reset(t);const metadata={},messages=[{is_user:true,mes:'我来帮忙。'}];let on=true,reads=0;
    const host={scope:()=> 'prompt-refresh',metadata:()=>metadata,messages:()=>messages,context:()=>({}),available:()=>true,autoAllowed:()=>false,
        locks:{request:async(name,options,fn)=>fn({name})},persist:async doc=>{metadata.storyDirectorCoop=clone(doc);},
        refreshPrompts:async()=>{reads++;setPromptEntries([entry('coop_growth','当前世界书的成长规则',on)]);}};
    const runtime=new CoopRuntime(host);t.after(()=>runtime.dispose());await runtime.load();
    await runtime.prepare();assert.equal(reads,1);assert.ok(archiveSystemPrompt().includes('当前世界书的成长规则'));
    on=false;await runtime.prepare();assert.equal(reads,2);assert.ok(!archiveSystemPrompt().includes('当前世界书的成长规则'));
});
