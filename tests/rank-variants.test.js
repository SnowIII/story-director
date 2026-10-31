import test from 'node:test';
import assert from 'node:assert/strict';
import {RANK_COUNTS,rankPolicy,thresholds,initialState,clone,applyAffinity,adoptPlan,acceptBeat,
    acceptAnswer,chooseRoute,assertState,validatePlan} from '../coop/model.js';
import {configureRoster} from '../coop/roster.js';
import {newDocument,readDocument,project} from '../coop/timeline.js';
import {designMessages,BLUEPRINTS_BY_RANK} from '../coop/prompts.js';
import {CoopRuntime} from '../coop/runtime.js';
import {mergeCoopMvu} from '../coop/mvu.js';
import {validateAffinityProposal} from '../coop/affinity.js';

const seeds={persona:'能干的画家',desire:'举办展览',shadow:'害怕否定',friction:'导师的要求'};
const plan=(p,rounds=3)=>({targetRank:p.rank+1,rounds,title:'画册与约定',scene:'画室',conflict:'理想与现实',goal:'形成新的应对方式',
    hook:'她拿出旧画册',dilemma:'她提出疑问',question:'你愿意如何面对？',resolution:'根据回应核对资料',
    seeds:p.seeds || seeds,usedHistory:p.history.map(h=>h.eventId),references:[],conflicts:[]});
const config=(id,count)=>({id,name:'角色'+id,rankCount:count,mode:'coop',initialAffinity:0,thresholds:thresholds(undefined,count)});

test('four seven and ten ranks have fixed independent gates and relationship checkpoints',()=>{
    assert.deepEqual(RANK_COUNTS,[4,7,10]);
    assert.deepEqual(rankPolicy(4).thresholds,[30,60,90,100]);
    assert.deepEqual(rankPolicy(7).thresholds,[15,30,45,60,75,90,100]);
    assert.deepEqual(rankPolicy(10).thresholds,[10,20,30,40,50,60,70,80,90,100]);
    assert.deepEqual(RANK_COUNTS.map(count=>rankPolicy(count).relationshipRank),[3,6,9]);
    for(const count of [0,5,6,8,'7',null]) assert.throws(()=>rankPolicy(count),{code:'INVALID_RANK_SYSTEM'});
    for(const count of RANK_COUNTS) {
        const copy=thresholds(undefined,count);copy[0]++;
        assert.throws(()=>thresholds(copy,count),{code:'INVALID_THRESHOLDS'});
        assert.equal(rankPolicy(count).thresholds.at(-1),100);
    }
});

test('each profile locks its scheme before progress and cannot change it while editing',()=>{
    const document=newDocument('s');
    for(const count of RANK_COUNTS) configureRoster(document,project(document,new Map()),config('p'+count,count));
    const before=JSON.stringify(document);
    for(const from of RANK_COUNTS) for(const to of RANK_COUNTS.filter(count=>count!==from)) {
        assert.throws(()=>configureRoster(document,project(document,new Map()),{...document.roster['p'+from],rankCount:to}),{code:'RANK_SYSTEM_LOCKED'});
    }
    assert.equal(JSON.stringify(document),before);
    configureRoster(document,project(document,new Map()),{...document.roster.p7,name:'新称呼',description:'补充内容'});
    const restored=project(readDocument(document,'s'),new Map());
    assert.deepEqual(Object.values(restored.profiles).map(p=>p.rankCount),[4,7,10]);
    assert.equal(restored.profiles.p7.name,'新称呼');assert.equal(restored.profiles.p7.rankCount,7);
});

for(const count of RANK_COUNTS) for(const route of ['friendship','romance']) for(const rounds of [2,3]) {
    test('complete '+count+' rank arc, route='+route+', rounds='+rounds,()=>{
        const state=initialState({a:config('a',count)}),p=state.profiles.a,policy=rankPolicy(count);
        let index=0;
        const source=(userId,body)=>({id:'m'+(++index),version:'v'+index,index,body,isUser:false,
            userId,userVersion:'uv'+index,userIndex:index-1,userBody:'我愿意帮你。'});
        for(let target=1;target<=count;target++) {
            while(p.affinity<policy.thresholds[target-1]) {
                applyAffinity(state,{characterId:'a',delta:5,reason:'实际支持',interactionId:'score-'+target+'-'+p.affinity,source:{index:index++}});
            }
            assert.equal(p.lock.targetRank,target);assert.equal(p.affinity,policy.thresholds[target-1]);
            applyAffinity(state,{characterId:'a',delta:-5,interactionId:'locked-'+target,source:{index:index++}});
            assert.equal(p.affinity,policy.thresholds[target-1]);
            const e=adoptPlan(state,{characterId:'a',gateId:p.lock.id,eventId:'e'+target,plan:plan(p,rounds)});
            const opening=source('opening-'+target,'她拿出旧画册，提出疑问。');
            acceptBeat(state,{characterId:'a',eventId:e.id,eventVersion:e.version,phase:e.phase,evidence:'旧画册',source:opening});
            if(rounds===3) acceptBeat(state,{characterId:'a',eventId:e.id,eventVersion:e.version,phase:e.phase,
                evidence:'提出疑问',source:source('question-'+target,'她提出疑问，等待回应。')});
            assert.equal(e.phase,'waiting_user');
            const answer={id:'answer-'+target,version:'answer-v'+target,index:++index,isUser:true,body:'我愿意帮你核对资料。'};
            acceptAnswer(state,{characterId:'a',eventId:e.id,source:answer});
            if(target===policy.relationshipRank) {
                assert.equal(e.phase,'waiting_route');assert.equal(p.rank,target-1);
                chooseRoute(state,{characterId:'a',eventId:e.id,route});
            } else {
                assert.equal(e.phase,'resolution');
                assert.throws(()=>chooseRoute(state,{characterId:'a',eventId:e.id,route}),{code:'INVALID_ROUTE'});
            }
            const ending=source(answer.id,'她决定核对资料，保留自己的判断。');
            ending.userVersion=answer.version;ending.userIndex=answer.index;
            acceptBeat(state,{characterId:'a',eventId:e.id,eventVersion:e.version,phase:'resolution',evidence:'核对资料',source:ending,
                completion:{summary:'她谈清了本阶画册与导师要求的困扰，用户愿意帮忙核对资料。她接受有限帮助并保留自己的判断，形成了本阶新的认识。',
                    outcome:'核对资料',outcomeEvidence:'核对资料',choice:'愿意帮忙',choiceEvidence:'愿意帮你',
                    traits:['本阶习惯'+target],facts:['本阶事实'+target],boundaries:[],openHooks:[],closedHooks:[]}});
            assert.equal(p.rank,target);assert.equal(p.history.length,target);assert.equal(p.lock,null);assertState(state);
        }
        assert.equal(p.route,route);assert.equal(p.rank,count);assert.equal(p.affinity,100);
        assert.throws(()=>validatePlan(plan(p),p),{code:'INVALID_RANK'});
        applyAffinity(state,{characterId:'a',delta:5,interactionId:'after-max',source:{index:++index}});
        assert.equal(p.lock,null);assert.equal(p.rank,count);assertState(state);
    });
}

test('seven and ten rank blueprints distinguish growth tasks and retain relationship checkpoints',()=>{
    assert.equal(BLUEPRINTS_BY_RANK[7].length,7);assert.equal(BLUEPRINTS_BY_RANK[10].length,10);
    assert.ok(BLUEPRINTS_BY_RANK[7][0].includes('合作基础'));
    assert.ok(BLUEPRINTS_BY_RANK[7][2].includes('价值边界'));
    assert.ok(BLUEPRINTS_BY_RANK[7][4].includes('不可替代的作用'));
    assert.ok(BLUEPRINTS_BY_RANK[7][5].includes('强制路线抉择断点'));
    assert.ok(BLUEPRINTS_BY_RANK[7][6].includes('具体未来约定'));
    assert.ok(BLUEPRINTS_BY_RANK[10][1].includes('反差日常'));
    assert.ok(BLUEPRINTS_BY_RANK[10][2].includes('分工与协作'));
    assert.ok(BLUEPRINTS_BY_RANK[10][5].includes('责任筹划'));
    assert.ok(BLUEPRINTS_BY_RANK[10][6].includes('重头戏'));
    assert.ok(BLUEPRINTS_BY_RANK[10][8].includes('强制互动断点'));
    assert.ok(BLUEPRINTS_BY_RANK[10][9].includes('共同未来'));
    for(const count of RANK_COUNTS) for(let rank=0;rank<count;rank++) {
        const p=initialState({a:config('a',count)}).profiles.a;p.rank=rank;
        p.history=Array.from({length:rank},(_,i)=>({rank:i+1,eventId:'e'+i,summary:'实际经历'+i,
            choice:'真实回应',outcome:'实际结果',facts:[],openHooks:[],closedHooks:[]}));
        const messages=designMessages(p);
        assert.ok(messages[0].content.includes('Rank '+rankPolicy(count).relationshipRank+' 根据用户明确选择'));
        assert.ok(messages[1].content.includes(BLUEPRINTS_BY_RANK[count][rank]));
    }
});

test('mixed-rank runtime reports use each profile gate, survive reload and expose immutable limits',async t=>{
    const messages=[],metadata={},host={scope:()=> 'mixed',context:()=>({}),messages:()=>messages,metadata:()=>metadata,
        available:()=>true,locks:{request:async(name,options,fn)=>fn({name})},persist:async document=>{metadata.storyDirectorCoop=clone(document);}};
    const runtime=new CoopRuntime(host);await runtime.load();t.after(()=>runtime.dispose());
    await runtime.configure({...config('seven',7),initialAffinity:14});await runtime.configure({...config('ten',10),initialAffinity:9});
    messages.push({is_user:true,mes:'我来帮你们。'});await runtime.prepare();const snapshot=runtime.snapshot;
    const report={nonce:snapshot.nonce,affinity:['seven','ten'].map(characterId=>({characterId,delta:5,reason:'实际支持',userEvidence:'帮你们',evidence:'放松'}))};
    messages.push({is_user:false,mes:'她们放松了。<UpdateVariable><JSONPatch>'+JSON.stringify([{op:'add',path:'/故事导演/Coop/回报',value:report}])+'</JSONPatch></UpdateVariable>'});
    await runtime.afterMessage(messages.length-1);
    assert.equal(runtime.state().profiles.seven.affinity,15);assert.equal(runtime.state().profiles.ten.affinity,10);
    assert.ok(runtime.variableContract().includes('"rankCount":7'));assert.ok(runtime.variableContract().includes('"relationshipRank":9'));
    await runtime.load();assert.equal(runtime.state().profiles.seven.rankCount,7);assert.equal(runtime.state().profiles.ten.rankCount,10);
    const mirrored={stat_data:{}};mergeCoopMvu(mirrored,runtime.state());
    assert.equal(mirrored.stat_data.故事导演.Coop.角色.角色seven.阶级上限,7);
    assert.equal(mirrored.stat_data.故事导演.Coop.角色.角色ten.关系确认阶级,9);
    const before=JSON.stringify(runtime.store.document),forged=clone(runtime.store.document);
    forged.roster.seven.rankCount=10;forged.roster.seven.thresholds=thresholds(undefined,10);
    await assert.rejects(runtime.restore(forged),{code:'RANK_SYSTEM_LOCKED'});assert.equal(JSON.stringify(runtime.store.document),before);
    const stale={...snapshot.roles.seven,rankCount:4};
    assert.throws(()=>validateAffinityProposal(report.affinity[0],runtime.state().profiles.seven,{},stale),{code:'STALE_POLICY'});
});
