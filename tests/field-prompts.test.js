import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as model from '../model.js';
import {FIELD_PROMPTS,fieldPromptName,FIELD_PROMPT_DEFAULT_NOTE,setPromptEntries,configureDesignPrompt,splitDesignPrompt,preservePromptEntries} from '../prompt-worldbook.js';
import {hash} from '../coop/model.js';
import {directorFixture} from './prompt-fixture.js';

const bundled=JSON.parse(fs.readFileSync(new URL('../worldbook/story-director.json',import.meta.url),'utf8'));
const entries=()=>structuredClone(Object.values(bundled.entries));
const entry=(key,content,on=true,raw=false)=>({comment:fieldPromptName(key)+' [sd_field_'+key+']',content,...(raw?{disable:!on,enabled:!on}:{enabled:on})});
const reset=t=>{setPromptEntries([]);t.after(()=>setPromptEntries([]));};
const tasks={epic:'buildEpicSystemPrompt',chapter:'buildChapterSystemPrompt',interlude_chapter:'buildInterludeChapterSystemPrompt',thread:'buildThreadSystemPrompt',interlude:'buildInterludeSystemPrompt'};

test('the worldbook contains one readable entry per output field and no old prompt entries or archives',()=>{
    const list=entries(),fields=list.filter(e=>/\[sd_field_/.test(e.comment));
    assert.equal(Object.keys(FIELD_PROMPTS).length,23);assert.equal(fields.length,23);
    assert.ok(!list.some(e=>/\[(?:sd_prompt_|coop_(?:design|forms)\]|sd_legacy_)/.test(e.comment)));
    assert.equal(list.length,34);
    for(const [key,field] of Object.entries(FIELD_PROMPTS)){
        const found=fields.find(e=>e.comment.includes('[sd_field_'+key+']'));
        assert.ok(found.comment.includes(fieldPromptName(key)));
        assert.ok(found.comment.endsWith(FIELD_PROMPT_DEFAULT_NOTE));
        assert.equal(found.content,field.content);assert.ok(!found.content.includes('{{sd.default}}'));
        assert.equal(found.sdPromptDefaultHash,hash(found.content.trim()));
        assert.equal(found.enabled,false);assert.equal(found.disable,true);assert.equal(found.constant,false);assert.deepEqual(found.key,[]);
    }
});

for(const raw of [false,true])test('every field independently replaces its rule, with disabled, empty and missing entries falling back; raw='+raw,t=>{
    reset(t);const fixture=directorFixture();
    for(const [key,field] of Object.entries(FIELD_PROMPTS))for(const on of [false,true]){
        setPromptEntries([entry(key,'本字段只用「行动／收获／遗留问题」，字面量 $&。',on,raw)]);
        const result=configureDesignPrompt(fixture.build(tasks[field.task]),fixture.sections);
        assert.equal(result.includes('本字段只用「行动／收获／遗留问题」，字面量 $&。'),on,key);
        assert.equal(result.includes(field.content),!on,key);
        const other=Object.entries(FIELD_PROMPTS).find(([id,f])=>id!==key&&f.task===field.task)[1];
        assert.ok(result.includes(other.content));
        const differentTask=Object.keys(tasks).find(task=>task!==field.task);
        assert.ok(!configureDesignPrompt(fixture.build(tasks[differentTask]),fixture.sections).includes('字面量 $&。'));
    }
    for(const content of ['', '  ',null,{},3]){
        setPromptEntries([entry('chapter_goal',content)]);
        assert.ok(configureDesignPrompt(fixture.build(tasks.chapter),fixture.sections).includes(FIELD_PROMPTS.chapter_goal.content));
    }
});

test('custom chapter-list and beat structures replace the old field formulas without changing the fixed protocol',t=>{
    reset(t);const fixture=directorFixture();
    for(const [task,key] of [['epic','epic_chapters'],['chapter','chapter_beats']]){
        setPromptEntries([entry(key,'每条按「行动、收获、遗留问题」组织，允许连续发生在同一地点。')]);
        const raw=fixture.build(tasks[task]),result=configureDesignPrompt(raw,fixture.sections,{beatTarget:5,beatBudget:2,keep:3,remaining:2});
        assert.ok(!result.includes('每条以〔舞台〕开头'));
        assert.ok(!result.includes('每一条照四个槽写'));
        assert.ok(!result.includes('每章自己一套「起承转合」'));
        assert.ok(!result.includes('章内走一遍 **正 → 反 → 合**'));
        assert.ok(!result.includes('每一拍按这个格式写'));
        assert.ok(result.includes('行动、收获、遗留问题'));
        assert.ok(result.endsWith(splitDesignPrompt(raw).format));
    }
});

test('upgrades preserve only current field edits and switches, discarding all legacy entries',()=>{
    for(const raw of [false,true])for(const on of [false,true]){
        const old=[entry('epic_chapters','我的新章内容写法',on,raw),{comment:'[sd_prompt_epic]',content:'不再使用的旧全文',enabled:true},
            {comment:'[coop_design]',content:'旧通用规则',enabled:true}];
        const upgraded=preservePromptEntries(structuredClone(bundled),old),list=Object.values(upgraded.entries);
        const field=list.find(e=>e.comment.includes('[sd_field_epic_chapters]'));
        assert.equal(field.content,'我的新章内容写法');assert.equal(field.enabled,on);assert.equal(field.disable,!on);
        assert.ok(!JSON.stringify(upgraded).includes('不再使用的旧全文'));assert.ok(!JSON.stringify(upgraded).includes('旧通用规则'));
    }
});

const functionSource=(source,name)=>{
    const start=source.indexOf('function '+name+'(');
    assert.ok(start>=0,name);return source.slice(start,source.indexOf('\n}\n',start)+2);
};

test('the real page renderers show matching worldbook entry names beside fields and in side directories',()=>{
    const f=directorFixture(),host={innerHTML:'',querySelector:()=>null,querySelectorAll:()=>[]};
    Object.assign(f.context,{panel:{querySelector:()=>host},mainState:()=>model.mainOf(f.root),currentMode:()=> 'main',
        esc:value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;'),
        FIELD_PROMPTS,fieldPromptName,FIELD_PROMPT_DEFAULT_NOTE,threadsState:()=>[],interludesState:()=>[],archivedEpicSection:()=>''});
    vm.runInContext(['fieldPromptHint','fieldPromptDirectory','renderMainTab','renderEpicTab','renderInterludeTab','renderSideTab'].map(name=>functionSource(f.source,name)).join('\n'),f.context);
    f.context.renderMainTab();
    for(const [key,field] of Object.entries(FIELD_PROMPTS).filter(([,field])=>field.task==='chapter'))assert.ok(host.innerHTML.includes(fieldPromptName(key)));
    assert.ok(!host.innerHTML.includes('写成矛盾的走向'));
    f.context.renderEpicTab();assert.ok(host.innerHTML.includes('修改这些字段的生成写法'),'directory is visible before creating an epic');
    Object.assign(f.root[model.NS][model.EPIC],{[model.EP.title]:'已有篇章',[model.EP.line]:'共同修船',[model.EP.chapters]:['行动／收获']});
    f.context.renderEpicTab();
    for(const [key] of Object.entries(FIELD_PROMPTS).filter(([,field])=>field.task==='epic'))assert.ok(host.innerHTML.includes(fieldPromptName(key)));
    assert.ok(!host.innerHTML.includes('每条 起 / 承 / 转 / 合'));
    f.context.renderInterludeTab(host);
    for(const [key] of Object.entries(FIELD_PROMPTS).filter(([,field])=>field.task==='interlude_chapter'))assert.ok(host.innerHTML.includes(fieldPromptName(key)));
    f.context.renderSideTab();
    for(const [key] of Object.entries(FIELD_PROMPTS).filter(([,field])=>['thread','interlude'].includes(field.task)))assert.ok(host.innerHTML.includes(fieldPromptName(key)));
});

test('actual current-state context retains the chapter table without reimposing its former four-slot format',()=>{
    const f=directorFixture();
    Object.assign(f.root[model.NS][model.EPIC],{[model.EP.title]:'修船',[model.EP.line]:'共同合作',[model.EP.chapters]:['行动：备料；收获：找到分工','行动：试航']});
    Object.assign(f.context,{threadsState:()=>[],interludesState:()=>[],epicIsArchived:()=>false});
    vm.runInContext(functionSource(f.source,'focusedStateBlock'),f.context);
    const result=f.context.focusedStateBlock('chapter');
    assert.ok(result.includes('行动：备料；收获：找到分工'));assert.ok(result.includes('你要细化的只有 ▶ 那一条'));
    assert.ok(!result.includes('每条 起 / 承 / 转 / 合'));
});

test('a one-beat replan does not reintroduce the full chapter minimum through the fixed self-check',t=>{
    reset(t);const f=directorFixture();setPromptEntries([entry('chapter_beats','每拍按行动与结果组织。')]);
    const prompt=configureDesignPrompt(f.build('buildChapterSystemPrompt',{remaining:1,keep:3}),f.sections,{remaining:1,keep:3,beatBudget:1});
    assert.ok(prompt.includes('剩余的 1 拍'));assert.ok(!prompt.includes('自检之后如果不足 3 拍'));
    assert.ok(prompt.includes('不为达到整章最少拍数而加拍'));
});
