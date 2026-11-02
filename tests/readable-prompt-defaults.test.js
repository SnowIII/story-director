import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {PROMPT_SLOTS,setPromptEntries,configureDesignPrompt,preservePromptEntries} from '../prompt-worldbook.js';
import {archiveSystemPrompt,growthRule} from '../coop/prompts.js';
import {renderInjectionHeader} from '../model.js';
import {hash} from '../coop/model.js';
import {directorFixture} from './prompt-fixture.js';

const bundled=JSON.parse(fs.readFileSync(new URL('../worldbook/story-director.json',import.meta.url),'utf8'));
const entries=()=>structuredClone(Object.values(bundled.entries));
const find=(list,key)=>list.find(entry=>entry.comment?.startsWith('[sd_prompt_'+key+']'));
const reset=t=>{setPromptEntries([]);t.after(()=>setPromptEntries([]));};
const on=entry=>({...entry,enabled:true,disable:false});

test('all shipped prompt slots contain readable default rules rather than a whole-prompt macro',()=>{
    const list=entries();
    for(const key of Object.keys(PROMPT_SLOTS)){
        const entry=find(list,key);
        assert.ok(entry.content.trim().length>50,key+' has its full rules');
        assert.ok(!entry.content.includes('{{sd.default}}'),key+' has no opaque default macro');
        assert.equal(entry.sdPromptDefaultHash,hash(entry.content.trim()));
    }
    assert.ok(find(list,'epic').content.includes('audit'));
    assert.ok(find(list,'epic').content.includes('evolve'));
    assert.ok(find(list,'chapter').content.includes('局部重排'));
    assert.ok(!find(list,'chapter').content.includes('这是故事的第一章：'));
});

test('unedited visible defaults retain live modes and counts even when the worldbook API omits custom metadata',t=>{
    reset(t);const fixture=directorFixture();
    fixture.settings.beatTarget=6;fixture.settings.chaptersPerEpic=6;
    const cases=[['epic','buildEpicSystemPrompt',{mode:'audit'},{epicMode:'audit'}],
        ['epic','buildEpicSystemPrompt',{mode:'evolve'},{epicMode:'evolve'}],
        ['chapter','buildChapterSystemPrompt',{remaining:2,keep:4},{remaining:2,keep:4}],
        ['interlude_chapter','buildInterludeChapterSystemPrompt',{},{}],
        ['thread','buildThreadSystemPrompt',{},{}],['interlude','buildInterludeSystemPrompt',{},{}]];
    for(const [key,builder,options,params] of cases){
        setPromptEntries([]);const raw=fixture.build(builder,options);
        const expected=configureDesignPrompt(raw,fixture.sections,params);
        const selected=on(find(entries(),key));delete selected.sdPromptDefaultHash;
        setPromptEntries([selected]);
        assert.equal(configureDesignPrompt(raw,fixture.sections,params),expected,key);
    }
    setPromptEntries([]);const narration=renderInjectionHeader({banUserAction:false});
    setPromptEntries([on(find(entries(),'narration_main'))]);
    assert.deepEqual(renderInjectionHeader({banUserAction:false}),narration);
});

test('editing a visible chapter default preserves shared edits and expands live replan quantities',t=>{
    reset(t);const fixture=directorFixture(),list=entries();
    const chapter=on(find(list,'chapter'));chapter.content+='\n新增偏好：共同完成一件小事。';
    const common=on(find(list,'common'));common.content='自定义通用规则，保留字面量 $&。';
    setPromptEntries([chapter,common]);
    const result=configureDesignPrompt(fixture.build('buildChapterSystemPrompt',{remaining:2,keep:4}),fixture.sections,
        {beatTarget:6,beatBudget:2,keep:4,remaining:2,regenerate:true,intensity:'自然推进',tone:''});
    assert.ok(result.includes('新增偏好：共同完成一件小事。'));
    assert.ok(result.includes(common.content));
    assert.ok(!result.includes('铁律（对所有产出都有效）'));
    assert.ok(!/\{\{sd\./.test(result));
    assert.ok(result.includes('"remaining":2'));assert.ok(result.includes('"keep":4'));
    assert.equal(result.split('<StoryChapters>').length-1,1);
});

test('archive defaults compose with growth edits before and after editing their full text',t=>{
    reset(t);const list=entries(),growth=on(find(list,'coop_growth'));
    growth.content='只记录已经验证的局部成长，金额 $& 保留原文。';
    for(const edited of [false,true]){
        const archive=on(find(list,'coop_archive'));
        if(edited)archive.content+='\n补充：先写结果，再写遗留问题。';
        setPromptEntries([archive,growth]);const result=archiveSystemPrompt();
        assert.ok(result.includes(growth.content));assert.ok(!result.includes(growthRule));
        assert.ok(result.includes('【固定返回格式：Coop 归档'));
        if(edited)assert.ok(result.includes('补充：先写结果，再写遗留问题。'));
    }
});

test('shared rule extensions are composed once with both old macros and edited full task text',t=>{
    reset(t);const fixture=directorFixture();
    for(const full of [false,true]){
        const chapter=on(find(entries(),'chapter'));
        chapter.content=(full?chapter.content:'{{sd.default}}')+'\n章节偏好：留下具体成果。';
        setPromptEntries([chapter,{comment:'[sd_prompt_common]',content:'{{sd.default}}\n共用新增规则：保留生活细节。',enabled:true}]);
        const result=configureDesignPrompt(fixture.build('buildChapterSystemPrompt'),fixture.sections,
            {beatTarget:4,beatBudget:4,intensity:'自然推进',tone:'',keep:0});
        assert.equal(result.split('共用新增规则：保留生活细节。').length-1,1);
        assert.equal(result.split('章节偏好：留下具体成果。').length-1,1);
    }
});

test('edited full defaults expand quantities for every design task and retain real rejection data',t=>{
    reset(t);const fixture=directorFixture();
    const tasks={epic:'buildEpicSystemPrompt',chapter:'buildChapterSystemPrompt',interlude_chapter:'buildInterludeChapterSystemPrompt',
        thread:'buildThreadSystemPrompt',interlude:'buildInterludeSystemPrompt'};
    const parameters={beatTarget:6,beatBudget:2,interludeBeats:2,chaptersPerEpic:6,keep:4,remaining:2,regenerate:true,
        rejected:{scrap:true,reason:'当前场合已改变',badBeats:['不能重演的旧拍']},epicMode:'audit',intensity:'自然推进',tone:''};
    for(const [key,builder] of Object.entries(tasks)){
        const selected=on(find(entries(),key));selected.content+='\n新增偏好：从真实处境出发。';
        setPromptEntries([selected]);
        const result=configureDesignPrompt(fixture.build(builder),fixture.sections,parameters);
        assert.ok(!/\{\{sd\./.test(result),key+' has no unresolved plugin variables');
        assert.ok(result.includes('新增偏好：从真实处境出发。'));
        assert.ok(result.includes('当前场合已改变'));assert.ok(result.includes('不能重演的旧拍'));
    }
});

test('edited narration full text receives the actual player-autonomy switch',t=>{
    reset(t);const main=on(find(entries(),'narration_main'));main.content+='\n对白简洁。';
    setPromptEntries([main]);
    for(const banUserAction of [false,true]){
        const result=renderInjectionHeader({banUserAction}).join('\n');
        assert.ok(result.includes('【禁止安排用户行为开关】'+banUserAction));
        assert.ok(!result.includes('{{sd.banUserAction}}'));assert.ok(result.includes('对白简洁。'));
    }
});

test('upgrades expand old default macros while preserving extra text, literal symbols and switch states',()=>{
    for(const enabled of [true,false])for(const raw of [true,false]){
        const previous=find(entries(),'chapter');
        previous.content='{{sd.default}}\n用户追加 $& 和 {{user}}，以及 {{sd.default}}';
        previous.sdPromptDefaultHash=hash('{{sd.default}}');
        if(raw){delete previous.enabled;previous.disable=!enabled;}
        else{delete previous.disable;previous.enabled=enabled;}
        const result=preservePromptEntries(structuredClone(bundled),[previous]);
        const upgraded=find(Object.values(result.entries),'chapter'),full=find(entries(),'chapter').content;
        assert.equal(upgraded.content,full+'\n用户追加 $& 和 {{user}}，以及 '+full);
        assert.equal(upgraded.enabled,enabled);assert.equal(upgraded.disable,!enabled);
        assert.equal(upgraded.sdPromptDefaultHash,hash(full.trim()));
        assert.equal(find(Object.values(preservePromptEntries(structuredClone(bundled),[upgraded]).entries),'chapter').content,upgraded.content);
    }
});
