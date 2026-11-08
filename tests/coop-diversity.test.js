import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {initialState,clone} from '../coop/model.js';
import {designMessages,BLUEPRINTS_BY_RANK,growthRule,renderScene,directorReportContract,reportContract} from '../coop/prompts.js';
import {designTemplates,preserveDesignTemplates} from '../coop/design-worldbook.js';
import {CoopRuntime} from '../coop/runtime.js';

const bundled=JSON.parse(fs.readFileSync(new URL('../worldbook/story-director.json',import.meta.url),'utf8'));
const profile=()=>initialState({a:{id:'a',name:'画家',mode:'coop',rankCount:7}}).profiles.a;
const history=(rank)=>({rank,eventId:'event-'+rank,summary:'第'+rank+'阶实际完成的经历',choice:'实际选择'+rank,
    outcome:'实际结果'+rank,facts:[],openHooks:[],closedHooks:[]});

test('design contrasts recent plans with all actual archives without treating old plans as facts',()=>{
    const p=profile();p.rank=3;p.history=[1,2,3].map(history);
    for(const h of p.history)p.events[h.eventId]={plan:{title:'原计划'+h.rank,conflict:'原冲突'+h.rank,
        hook:'原切入'+h.rank,question:'原问题'+h.rank,resolution:'尚未发生的设想'+h.rank+'长'.repeat(1000)}};
    const before=clone(p),messages=designMessages(p,'当前现场');
    for(const h of p.history)assert.ok(messages[1].content.includes(h.summary));
    assert.ok(!messages[1].content.includes('原计划1'));
    assert.ok(messages[1].content.includes('原计划2'));assert.ok(messages[1].content.includes('原计划3'));
    assert.ok(messages[1].content.includes('实际发生的事以归档为准'));
    assert.ok(!messages[1].content.includes('长'.repeat(241)));
    assert.deepEqual(p,before);assert.equal(messages.length,2);
});

test('legacy archives without original event plans remain usable with built-in and custom prompts',()=>{
    const p=profile();p.rank=2;p.history=[1,2].map(history);
    for(const templates of [{},{rules:'用户自己的设计规则',blueprint:'用户自己的阶段要求'}]){
        const messages=designMessages(p,'现场',templates);
        assert.ok(messages[1].content.includes('第1阶实际完成的经历'));
        assert.ok(messages[1].content.includes('第2阶实际完成的经历'));
        assert.ok(!messages[1].content.includes('最近两阶原设计'));
        if(templates.rules)assert.ok(messages[0].content.startsWith(templates.rules));
    }
});

test('worldbook upgrades preserve restored rank blueprints while removing retired common Coop templates',()=>{
    for(const on of [true,false]){
        const installed=['design','forms','rank_4','rank_7','rank_10'].map(key=>({comment:'[coop_'+key+']',content:'旧自定义 '+key,disable:!on,enabled:on}));
        const merged=preserveDesignTemplates(clone(bundled),installed);
        assert.ok(!Object.values(merged.entries).some(e=>/\[coop_design\]/.test(e.comment)));
        const forms=Object.values(merged.entries).find(e=>e.comment.includes('[coop_forms]'));
        assert.equal(forms.content,'旧自定义 forms');assert.equal(forms.enabled,on);assert.equal(forms.disable,!on);
        for(const count of [4,7,10]){
            const entry=Object.values(merged.entries).find(e=>e.comment.includes('[coop_rank_'+count+']'));
            assert.equal(entry.content,'旧自定义 rank_'+count);assert.equal(entry.enabled,on);assert.equal(entry.disable,!on);
        }
        const next=preserveDesignTemplates(clone(bundled),Object.values(merged.entries));
        assert.deepEqual(next,merged);
    }
});

test('bundled editable defaults match built-in variation rules and retain local growth in live reports',()=>{
    const p=profile(),entries=Object.values(clone(bundled).entries).map(e=>({...e,disable:false,enabled:true}));
    const plain=designMessages(p),editable=designMessages(p,'',designTemplates(entries,p));
    assert.deepEqual(editable,plain);
    assert.ok(plain[0].content.includes('冲突机制或用户参与任务'));
    const e={id:'e',characterId:'a',targetRank:1,phase:'resolution',version:3,plan:{goal:'核对资料',resolution:'完成核对'},answerSource:{body:'一起核对'}};
    const snapshot={nonce:'n',reportChannel:'director',roles:{a:{mvuKey:'画家'}}};
    const live=[renderScene(p,e),directorReportContract(e,snapshot)].join('\n');
    assert.equal(live.split(growthRule).length-1,1);
    assert.ok(reportContract([p],e,snapshot).includes(growthRule));
    assert.ok(BLUEPRINTS_BY_RANK[7][2].includes('已确认的归属直接沿用'));
});

test('event design uses one existing model call without a separate similarity check',async t=>{
    const messages=[],metadata={},requests=[];
    const host={scope:()=> 'diversity-test',context:()=>({}),metadata:()=>metadata,messages:()=>messages,
        available:()=>true,autoAllowed:()=>false,contextText:async()=> '工作室当前需要核对资料',
        designTemplates:async p=>designTemplates([{comment:'[coop_rank_4]',enabled:true,content:'## Rank 1\n只采用这一阶的自定义合作方式'}],p),
        locks:{request:async(name,options,fn)=>fn({name})},persist:async doc=>{metadata.storyDirectorCoop=clone(doc);},
        ask:async request=>{requests.push(request);return JSON.stringify({targetRank:1,rounds:3,title:'资料的不同解读',
            scene:'工作室',conflict:'速度与核实质量',goal:'形成协作办法',hook:'画家带来待核对的资料',
            dilemma:'需要协商核对顺序',question:'先处理哪部分？',resolution:'根据真实回应完成核对',
            seeds:{persona:'画家',desire:'完成展览',shadow:'害怕否定',friction:'导师的要求'},usedHistory:[],references:[],conflicts:[]});}};
    const runtime=new CoopRuntime(host);t.after(()=>runtime.dispose());await runtime.load();
    await runtime.configure({id:'a',name:'画家',mode:'coop',initialAffinity:30});
    await runtime.generate('a');assert.equal(requests.length,1);
    assert.ok(requests[0][1].content.includes('只采用这一阶的自定义合作方式'));
    assert.equal(runtime.event().plan.title,'资料的不同解读');
});
