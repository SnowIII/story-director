import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {PRETHINK_PROMPT,setPromptEntries,configureDesignPrompt,splitDesignPrompt,preservePromptEntries} from '../prompt-worldbook.js';
import {parseBlocks,storyBlockFailure,storyAuditVerdict,chapterFromBlock,MAIN_TITLE} from '../model.js';
import {hash} from '../coop/model.js';
import {directorFixture} from './prompt-fixture.js';

const book=JSON.parse(fs.readFileSync(new URL('../worldbook/story-director.json',import.meta.url),'utf8'));
const config=(content,on=true,raw=false)=>({comment:PRETHINK_PROMPT.name+' '+PRETHINK_PROMPT.marker,content,
    ...(raw?{disable:!on,enabled:!on}:{enabled:on})});
const reset=t=>{setPromptEntries([]);t.after(()=>setPromptEntries([]));};
const tasks={epic:'buildEpicSystemPrompt',chapter:'buildChapterSystemPrompt',interlude_chapter:'buildInterludeChapterSystemPrompt',thread:'buildThreadSystemPrompt',interlude:'buildInterludeSystemPrompt'};

for(const [task,builder] of Object.entries(tasks)){
    test(task+' emits no preThink instruction by default and keeps its complete original result format',t=>{
        reset(t);const f=directorFixture(),raw=f.build(builder);
        setPromptEntries(Object.values(book.entries));
        const prompt=configureDesignPrompt(raw,f.sections);
        assert.ok(!prompt.includes('<preThink>'));
        assert.ok(prompt.endsWith(splitDesignPrompt(raw).format));
    });
    test(task+' opt-in preThink precedes the fixed result without removing fields, quantities or audit suffix',t=>{
        reset(t);const f=directorFixture(),raw=f.build(builder,task==='epic'?{mode:'audit'}:{remaining:2,keep:3}),parts=splitDesignPrompt(raw);
        setPromptEntries([config('用两句话介绍本次 {{sd.task}} 的主题，保留 {{user}} 与 $&。')]);
        const prompt=configureDesignPrompt(raw,f.sections,{task,beatBudget:2,remaining:2,keep:3,epicMode:'audit'});
        const fixed=prompt.split('【固定返回格式：')[1];
        assert.ok(prompt.includes('用两句话介绍本次 '+task+' 的主题，保留 {{user}} 与 $&。'));
        assert.ok(fixed.includes('<preThink>〔按返回前置内容配置填写〕</preThink>'));
        assert.ok(fixed.indexOf('<preThink>〔')<fixed.indexOf('<'+parts.tag+'>'));
        assert.ok(!fixed.includes('且**只输出一个区块**'));
        assert.ok(prompt.endsWith(parts.format.slice(parts.format.indexOf('<'+parts.tag+'>'))));
    });
}

test('the preThink entry is independently blank and disabled, and blank, missing or disabled configs restore the original format',t=>{
    reset(t);const found=Object.values(book.entries).filter(entry=>entry.comment.includes(PRETHINK_PROMPT.marker));
    assert.equal(found.length,1);assert.equal(found[0].content,'');assert.equal(found[0].disable,true);assert.equal(found[0].enabled,false);
    assert.equal(found[0].constant,false);assert.deepEqual(found[0].key,[]);
    const f=directorFixture(),raw=f.build('buildChapterSystemPrompt'),expected=configureDesignPrompt(raw,f.sections);
    for(const entries of [[],[config('自定义前置说明',false)],[config('自定义前置说明',false,true)],[config('')],[config('  ')],[config(null)]]){
        setPromptEntries(entries);assert.equal(configureDesignPrompt(raw,f.sections),expected);
    }
    setPromptEntries([config('已保存的前置说明',true,true)]);
    assert.ok(configureDesignPrompt(raw,f.sections).includes('已保存的前置说明'));
    setPromptEntries([]);assert.equal(configureDesignPrompt(raw,f.sections),expected);
});

test('worldbook upgrades retain customized preThink content and its switch without applying field-default migration',()=>{
    for(const on of [false,true])for(const empty of [false,true]){
        const previous={...config(empty?'':'本次先介绍人物冲突',on,true),sdPromptDefaultHash:hash('')};
        const merged=preservePromptEntries(structuredClone(book),[previous]);
        const found=Object.values(merged.entries).find(entry=>entry.comment.includes(PRETHINK_PROMPT.marker));
        assert.equal(found.content,previous.content);assert.equal(found.enabled,on);assert.equal(found.disable,!on);
    }
});

for(const tag of ['StoryEpic','StoryChapters','StoryInterludeChapter','StoryThreads','StoryInterlude']){
    test(tag+' parsing ignores example result tags in preThink and selects only the real result',()=>{
        const preface='<preThink>示例：<'+tag+'>标题: 不是实际计划</'+tag+'>\n检查: 这不是实际结论</preThink>';
        const real='<'+tag+'>标题: 实际计划</'+tag+'>';
        assert.deepEqual(parseBlocks(preface+'\n'+real,tag),['标题: 实际计划']);
        assert.equal(storyBlockFailure(preface+'\n'+real,tag).kind,'ok');
        assert.deepEqual(parseBlocks(preface,tag),[]);
        assert.equal(storyBlockFailure(preface,tag).kind,'no-block');
    });
}

test('an incomplete preThink cannot create a plan from a quoted block and is diagnosed as truncated',()=>{
    const raw='<preThink>示例：<StoryChapters>章标题: 伪计划\n拍:\n1. 不能保存</StoryChapters>';
    assert.deepEqual(parseBlocks(raw,'StoryChapters'),[]);
    const failure=storyBlockFailure(raw,'StoryChapters');
    assert.equal(failure.kind,'truncated');assert.equal(failure.saw,'preThink');
});

test('preThink accepts ordinary tag case and attributes and does not hide a wrong result tag outside it',()=>{
    const raw='<PRETHINK data-kind="说明">示例 <StoryEpic>旧计划</StoryEpic></PRETHINK>\n<StoryThreads>标题: 实际支线</StoryThreads>';
    assert.deepEqual(parseBlocks(raw,'StoryThreads'),['标题: 实际支线']);
    assert.equal(storyBlockFailure(raw,'StoryEpic').saw,'StoryThreads');
});

test('epic audit reads the verdict after the result and ignores conclusions inside preThink',()=>{
    const preface='<preThink>检查: 不应作为实际结论</preThink>\n<StoryEpic>标题: 现有篇章</StoryEpic>';
    assert.equal(storyAuditVerdict(preface+'\n检查: 照旧'),'照旧');
    assert.equal(storyAuditVerdict(preface),'');
});

test('actual Oracle transport refreshes optional preThink in its existing request and leaves result parsing intact',async t=>{
    reset(t);const f=directorFixture(),requests=[];let on=true,reads=0;
    const reply='<preThink>本次关注人物的不同目标。</preThink>\n<StoryChapters>章标题: 一起修船\n篇章: 归港\n范围: 港口\n章目标: 船可试航\n拍:\n1. 船匠检查船板\n2. 船匠递来工具</StoryChapters>';
    Object.assign(f.context,{oracleApi:()=>({run:async messages=>{requests.push(messages);return reply;}}),
        genId:1,genCtl:null,genAborted:false,chatKey:()=> 'prethink-test',lastRequestChars:0,console,ORACLE_CANCELLED:'cancelled',providerErrorOf:()=>'',
        buildUserPrompt:async()=>{reads++;setPromptEntries([config('先简短介绍主题',on)]);return '当前上下文';}});
    const start=f.source.indexOf('function configuredSystemPrompt('),end=f.source.indexOf('function providerErrorOf(',start);
    vm.runInContext(f.source.slice(start,end),f.context);
    const raw=await vm.runInContext("askOracle({task:'chapter'})",f.context);
    assert.equal(reads,1);assert.equal(requests.length,1);assert.ok(requests[0][0].content.includes('先简短介绍主题'));
    assert.equal(raw,reply);assert.equal(chapterFromBlock(parseBlocks(raw,'StoryChapters')[0])[MAIN_TITLE],'一起修船');
    on=false;await vm.runInContext("askOracle({task:'chapter'})",f.context);
    assert.equal(reads,2);assert.equal(requests.length,2);assert.ok(!requests[1][0].content.includes('<preThink>'));
});
