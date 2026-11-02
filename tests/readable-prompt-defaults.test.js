import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {setPromptEntries,configureDesignPrompt,preservePromptEntries,FIELD_PROMPTS,FIELD_PROMPT_DEFAULT_NOTE} from '../prompt-worldbook.js';
import {hash} from '../coop/model.js';
import {directorFixture} from './prompt-fixture.js';
const book=JSON.parse(fs.readFileSync(new URL('../worldbook/story-director.json',import.meta.url),'utf8'));
const reset=t=>{setPromptEntries([]);t.after(()=>setPromptEntries([]));};
test('enabled visible field defaults retain live audit, evolve and partial replan behavior without metadata',t=>{
    reset(t);const f=directorFixture();f.settings.beatTarget=6;f.settings.chaptersPerEpic=6;
    const cases=[['buildEpicSystemPrompt',{mode:'audit'},{epicMode:'audit'}],['buildEpicSystemPrompt',{mode:'evolve'},{epicMode:'evolve'}],
        ['buildChapterSystemPrompt',{remaining:2,keep:4},{remaining:2,keep:4}],['buildInterludeChapterSystemPrompt',{},{}],['buildThreadSystemPrompt',{},{}],['buildInterludeSystemPrompt',{},{}]];
    for(const [builder,options,params] of cases){
        setPromptEntries([]);const raw=f.build(builder,options),expected=configureDesignPrompt(raw,f.sections,params);
        setPromptEntries(Object.values(book.entries).map(({sdPromptDefaultHash,...entry})=>({...entry,enabled:true,disable:false})));
        assert.equal(configureDesignPrompt(raw,f.sections,params),expected);
    }
});
test('field variables follow this request rather than freezing the displayed default quantities',t=>{
    reset(t);const f=directorFixture();setPromptEntries([{name:'[sd_field_chapter_beats]',enabled:true,
        content:'已保留 {{sd.keep}} 拍，仅续写 {{sd.beatBudget}} 拍。{{user}} 的行动由用户决定，字面量 $&。'}]);
    const prompt=configureDesignPrompt(f.build('buildChapterSystemPrompt',{remaining:2,keep:4}),f.sections,{keep:4,beatBudget:2,remaining:2});
    assert.ok(prompt.includes('已保留 4 拍，仅续写 2 拍'));assert.ok(prompt.includes('{{user}}'));assert.ok(prompt.includes('字面量 $&'));
    assert.ok(!prompt.includes('{{sd.keep}}'));
});
test('field upgrades disable untouched legacy defaults while retaining actual edits and their switches',()=>{
    for(const changed of [false,true])for(const on of [false,true]){
        const previous={name:'[sd_field_chapter_goal]',content:changed?'自己的写法':'较早默认',sdPromptDefaultHash:hash('较早默认'),disable:!on};
        const result=preservePromptEntries(structuredClone(book),[previous]);
        const entry=Object.values(result.entries).find(e=>e.comment.includes('[sd_field_chapter_goal]'));
        const expectedOn=changed&&on;
        assert.equal(entry.content,changed?'自己的写法':FIELD_PROMPTS.chapter_goal.content);assert.equal(entry.enabled,expectedOn);assert.equal(entry.disable,!expectedOn);
    }
});

test('after the disabled-default migration, explicitly enabled unchanged fields survive future upgrades',()=>{
    for(const on of [false,true])for(const renamed of [false,true]){
        const previous={comment:renamed?'我的目标写法 [sd_field_chapter_goal]':'字段写法 · 主线 · 章目标 [sd_field_chapter_goal]'+FIELD_PROMPT_DEFAULT_NOTE,
            ...(renamed?{sdPromptDefaultDisabled:true}:{}),
            content:FIELD_PROMPTS.chapter_goal.content,sdPromptDefaultHash:hash(FIELD_PROMPTS.chapter_goal.content),disable:!on};
        const first=preservePromptEntries(structuredClone(book),[previous]);
        const second=preservePromptEntries(structuredClone(book),Object.values(first.entries));
        const entry=Object.values(second.entries).find(e=>e.comment.includes('[sd_field_chapter_goal]'));
        assert.equal(entry.enabled,on);assert.equal(entry.disable,!on);
    }
});
