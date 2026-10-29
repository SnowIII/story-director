import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {designTemplates,preserveDesignTemplates} from '../coop/design-worldbook.js';
import {designMessages,BLUEPRINTS_BY_RANK} from '../coop/prompts.js';
import {initialState,clone} from '../coop/model.js';

const bundled=JSON.parse(fs.readFileSync(new URL('../worldbook/story-director.json',import.meta.url),'utf8'));
const profile=count=>initialState({a:{id:'a',name:'画家',mode:'coop',rankCount:count}}).profiles.a;
const completed=(p,rank)=>{p.rank=rank;p.history=Array.from({length:rank},(_,i)=>({rank:i+1,eventId:'e'+i,
    summary:'实际经历',choice:'用户选择',outcome:'结果',facts:[],openHooks:[],closedHooks:[]}));};
for(const count of [4,7,10]) test('editable worldbook selects only the current act of its '+count+'-rank plan',()=>{
    const p=profile(count),entries=Object.values(clone(bundled).entries).map(entry=>({...entry,disable:false,enabled:true}));
    for(let rank=0;rank<count;rank++) {
        completed(p,rank);const selected=designTemplates(entries,p),messages=designMessages(p,'现场资料',selected);
        assert.equal(selected.blueprint,BLUEPRINTS_BY_RANK[count][rank]);
        assert.ok(selected.rules.includes('已锁定 '+count+' 阶方案'));
        assert.ok(selected.rules.includes('Rank '+(count===4?3:count-1)+' 根据用户明确选择'));
        assert.ok(!selected.rules.includes('{{coop.'));
        assert.ok(messages[1].content.includes(selected.blueprint));
        if(rank+1<count) assert.ok(!messages[1].content.includes(BLUEPRINTS_BY_RANK[count][rank+1]));
    }
});
test('custom common rules and current-rank text replace defaults while program contracts remain',()=>{
    const p=profile(7);completed(p,1);
    const entries=[{name:'[coop_design] 自定义规则',content:'采用克制风格，{{coop.rankCount}} 阶，关系阶 {{coop.relationshipRank}}，门槛 {{coop.thresholds}}。',enabled:true},
        {comment:'[coop_rank_7] 自定义流程',enabled:true,content:'全阶共同要求\n## Rank 1\n第一次会面\n## Rank 2\n在旧车站讨论承诺\n## Rank 3\n未来秘密'},
        {comment:'[coop_rank_4]',enabled:true,content:'其他方案不应混入'}];
    const selected=designTemplates(entries,p),messages=designMessages(p,'资料',selected);
    assert.equal(selected.blueprint,'全阶共同要求\n在旧车站讨论承诺');
    assert.ok(messages[0].content.includes('采用克制风格，7 阶，关系阶 6'));
    assert.ok(!messages[0].content.includes('你是 Coop 羁绊事件设计师'));
    assert.ok(messages[0].content.includes('【程序契约】角色已锁定 7 阶'));
    assert.ok(messages[0].content.includes('usedHistory:全部前阶事件ID数组'));
    assert.ok(!messages[1].content.includes('未来秘密'));assert.ok(!messages[1].content.includes('其他方案'));
});
test('missing or incomplete templates fall back to the current built-in stage',()=>{
    const p=profile(10);completed(p,4);
    const selected=designTemplates([{comment:'[coop_rank_10]',enabled:true,content:'## Rank 1\n只有开场'}],p);
    const messages=designMessages(p,'',selected);
    assert.ok(messages[0].content.includes('你是 Coop 羁绊事件设计师'));
    assert.ok(messages[1].content.includes(BLUEPRINTS_BY_RANK[10][4]));
    assert.equal(designTemplates([{comment:'[coop_rank_10]',enabled:true,content:'全部阶级通用的自定义原则'}],p).blueprint,'全部阶级通用的自定义原则');
});
for(const count of [4,7,10]) test('common and '+count+'-rank switches independently select custom or built-in prompts',()=>{
    const p=profile(count);
    for(const raw of [false,true]) for(const commonOn of [false,true]) for(const flowOn of [false,true]) {
        const entry=(key,content,on)=>({comment:'[coop_'+key+']',content,
            ...(raw?{disable:!on,enabled:!on}:{enabled:on})});
        const entries=[entry('design','自定义通用规则',commonOn),entry('rank_'+count,'## Rank 1\n自定义本阶流程',flowOn)];
        const selected=designTemplates(entries,p),messages=designMessages(p,'',selected);
        assert.equal(selected.rules,commonOn?'自定义通用规则':'');
        assert.equal(selected.blueprint,flowOn?'自定义本阶流程':'');
        assert.ok(messages[0].content.includes(commonOn?'自定义通用规则':'你是 Coop 羁绊事件设计师'));
        assert.ok(messages[1].content.includes(flowOn?'自定义本阶流程':BLUEPRINTS_BY_RANK[count][0]));
    }
    assert.deepEqual(designTemplates(Object.values(bundled.entries),p),{rules:'',blueprint:''});
    assert.deepEqual(designTemplates([{comment:'[coop_design]',content:'没有开启状态'},
        {comment:'[coop_rank_'+count+']',enabled:true,content:'  '}],p),{rules:'',blueprint:''});
});
test('automatic worldbook upgrades preserve custom Coop text and update regular contracts',()=>{
    const incoming=clone(bundled),installed=Object.values(clone(bundled).entries);
    Object.assign(installed.find(entry=>entry.comment.includes('[coop_design]')),{content:'用户编辑的通用规则',disable:false,enabled:true});
    Object.assign(installed.find(entry=>entry.comment.includes('[coop_rank_7]')),{content:'用户编辑的七阶流程',disable:false,enabled:true});
    installed.find(entry=>entry.comment.includes('[mvu_update]')).content='旧变量契约';
    const merged=preserveDesignTemplates(incoming,installed),p=profile(7),selected=designTemplates(Object.values(merged.entries),p);
    assert.equal(selected.rules,'用户编辑的通用规则');assert.equal(selected.blueprint,'用户编辑的七阶流程');
    assert.notEqual(merged.entries[0].content,'旧变量契约');
    const defaults=designMessages(profile(4),'',designTemplates(Object.values(merged.entries),profile(4)));
    assert.ok(defaults[1].content.includes('契约与初窥'));
});
test('automatic upgrades preserve enabled and disabled switches from either worldbook API',()=>{
    for(const raw of [false,true]) for(const on of [false,true]) {
        const installed=[{name:'[coop_design] 用户设计',content:'保留的自定义内容',...(raw?{disable:!on}:{enabled:on})}];
        const merged=preserveDesignTemplates(clone(bundled),installed),entry=merged.entries[4];
        assert.equal(entry.content,'保留的自定义内容');assert.equal(entry.enabled,on);assert.equal(entry.disable,!on);
        assert.equal(designTemplates(Object.values(merged.entries),profile(4)).rules,on?'保留的自定义内容':'');
    }
});
test('Coop design templates stay disabled in ordinary chat and the MVU contract requests no event payload',()=>{
    const entries=Object.values(bundled.entries),templates=entries.filter(entry=>/\[coop_/.test(entry.comment));
    assert.equal(templates.length,4);assert.ok(templates.every(entry=>entry.disable && !entry.constant));
    assert.ok(bundled.entries[0].content.includes('不写入 MVU'));
    assert.ok(!bundled.entries[0].content.includes('阶段进度和归档写入 故事导演.Coop.回报'));
});
