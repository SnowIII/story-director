import test from 'node:test';
import assert from 'node:assert/strict';
import {initialState,activateGate,adoptPlan,acceptBeat,acceptAnswer,chooseRoute,assertState,
    clone,hash,historySignature,isTerminalEvent,unfinishedEvent,pendingRetry,rankPolicy} from '../coop/model.js';
import {newDocument,readDocument,appendOperation,project,deletedEventIds,pruneDeletedEvents} from '../coop/timeline.js';
import {continuity} from '../coop/history.js';
import {references} from '../coop/messages.js';
import {readMvuAffinity} from '../coop/mvu.js';

const makePlan=p=>({targetRank:p.rank+1,rounds:3,title:'核对画册',scene:'画室',conflict:'原稿去向不明',goal:'找到并核对原稿',
    hook:'她拿出画册线索',dilemma:'她询问是否一起寻找',question:'是否帮忙寻找？',resolution:'原稿找回并核对完毕',
    seeds:p.seeds || {persona:'画家',desire:'办展',shadow:'失败',friction:'遗失'},usedHistory:p.history.map(h=>h.eventId),references:[],conflicts:[]});
const failedReport=()=>({reason:'唯一原稿已经烧毁，原定目标不再可能达成',
    summary:'两人发现唯一原稿已经烧毁，原定的寻找与核对无法完成。她决定接受这一事实，之后另行安排展览。',
    outcome:'唯一原稿已经烧毁',outcomeEvidence:'唯一原稿已经烧毁',openHooks:['另行安排展览']});
const completedReport=()=>({summary:'用户协助她找到另一份有效资料，两人完成核对并澄清了误会，她学会在资料不全时主动寻求帮助。',
    outcome:'资料核对完毕',outcomeEvidence:'资料核对完毕',choice:'愿意帮忙',choiceEvidence:'我愿意帮忙',
    traits:['主动寻求帮助'],facts:[],boundaries:[],openHooks:[],closedHooks:[],conflicts:[],
    scene:{goalAchieved:true,closed:true,awaitingUser:false,blockingConflicts:[],evidence:'资料核对完毕'}});

function fixture(rankCount=4) {
    let index=0,user=null;
    const state=initialState({a:{id:'a',name:'画家',mode:'coop',rankCount,initialAffinity:rankPolicy(rankCount).thresholds[0]}});
    const f={state,event:null,profile:()=>state.profiles.a,
        user(body='我愿意帮忙。') {user={id:'u'+(++index),index,version:'v'+index,isUser:true,body};return user;},
        reply(body) {if(!user) f.user();return {id:'m'+(++index),index,version:'v'+index,isUser:false,body,
            userId:user.id,userVersion:user.version,userIndex:user.index,userBody:user.body};},
        start(eventId='event-'+index) {
            const p=f.profile();
            if(!p.lock) {p.affinity=p.thresholds[p.rank];activateGate(state,'a','gate-'+index);}
            f.event=adoptPlan(state,{characterId:'a',gateId:p.lock.id,eventId,plan:makePlan(p)});
            return f.event;
        },
        beat(phase,body) {
            f.user();const source=f.reply(body);
            acceptBeat(state,{characterId:'a',eventId:f.event.id,eventVersion:f.event.version,phase,evidence:body,source});
            return source;
        },
        answer(body='我愿意帮忙。') {
            const source=f.user(body);acceptAnswer(state,{characterId:'a',eventId:f.event.id,source});return source;
        },
        advance(phase='resolution') {
            if(phase==='hook') return;
            f.beat('hook','她拿出画册线索。');if(phase==='dilemma') return;
            f.beat('dilemma','她询问是否一起寻找。');if(phase==='waiting_user') return;
            f.answer();if(phase==='waiting_route') return;
            if(f.event.phase==='waiting_route') chooseRoute(state,{characterId:'a',eventId:f.event.id,route:'friendship'});
        },
        fail(report=failedReport()) {
            const source=f.reply('她确认唯一原稿已经烧毁，已经无法核对。');
            return acceptBeat(state,{characterId:'a',eventId:f.event.id,eventVersion:f.event.version,
                phase:f.event.phase,failed:true,evidence:'唯一原稿已经烧毁',failure:report,source});
        },
        complete(report=completedReport(),options={}) {
            const source=f.reply('她宣布资料核对完毕，感谢你的协助。');
            return acceptBeat(state,{characterId:'a',eventId:f.event.id,eventVersion:f.event.version,
                phase:'resolution',evidence:'资料核对完毕',completion:report,source,requireSceneClosure:true,...options});
        },
    };
    return f;
}

for(const rankCount of [4,7,10]) for(const phase of ['hook','dilemma','waiting_user','waiting_route','resolution']) {
    test(rankCount+' ranks: failure from '+phase+' ends only the attempt and keeps its gate',()=>{
        const f=fixture(rankCount),target=phase==='waiting_route'?rankPolicy(rankCount).relationshipRank:1;
        while(f.profile().rank<target-1) {f.start();f.advance();f.complete();}
        f.start();f.advance(phase);assert.equal(f.event.phase,phase);
        const before=clone(f.profile()),signature=historySignature(before);
        f.fail();
        const p=f.profile();assertState(f.state);
        assert.equal(p.rank,before.rank);assert.equal(p.affinity,before.affinity);assert.deepEqual(p.lock,before.lock);
        assert.equal(p.route,before.route);assert.deepEqual(p.history,before.history);
        assert.equal(f.state.activeEventId,null);assert.equal(unfinishedEvent(f.state),null);
        assert.ok(isTerminalEvent(f.event));assert.equal(f.event.phase,'failed');
        assert.equal(p.failedHistory.length,1);assert.equal(p.failedHistory[0].rank,target);
        assert.equal(pendingRetry(p).eventId,f.event.id);assert.notEqual(historySignature(p),signature);
        assert.match(continuity(p),/失败事件档案/);assert.match(continuity(p),/唯一原稿已经烧毁/);
    });
}

test('failure retry chain uses new IDs at the same Rank, then success promotes exactly once',()=>{
    const f=fixture();f.start('attempt-one');f.fail();const firstGate=clone(f.profile().lock);
    const second=f.start('attempt-two');assert.equal(second.retryOf,'attempt-one');assert.equal(second.targetRank,1);
    assert.equal(pendingRetry(f.profile()),null);assert.deepEqual(f.profile().lock,firstGate);
    f.fail();const third=f.start('attempt-three');assert.equal(third.retryOf,'attempt-two');
    f.advance();f.complete();
    const p=f.profile();assertState(f.state);assert.equal(p.rank,1);assert.equal(p.history.length,1);
    assert.equal(p.history[0].eventId,'attempt-three');assert.equal(p.lock,null);
    assert.deepEqual(p.failedHistory.map(h=>h.eventId),['attempt-one','attempt-two']);
    assert.equal(pendingRetry(p),null);
    assert.throws(()=>acceptBeat(f.state,{characterId:'a',eventId:'attempt-two'}),{code:'STALE_EVENT'});
});

test('retry lineage rejects a stale or unrelated failed attempt',()=>{
    const f=fixture();f.start('attempt-one');f.fail();const p=f.profile();
    assert.throws(()=>adoptPlan(f.state,{characterId:'a',gateId:p.lock.id,eventId:'attempt-two',
        retryOf:'another-failure',plan:makePlan(p)}),{code:'STALE_RETRY'});
    assert.throws(()=>adoptPlan(f.state,{characterId:'a',gateId:p.lock.id,eventId:'attempt-one',
        plan:makePlan(p)}),{code:'ALREADY_COMMITTED'});
    assert.equal(f.state.activeEventId,null);assert.equal(p.failedHistory.length,1);
});

test('failure accepts genuine current user choice before an answer phase and requires no growth',()=>{
    const f=fixture();f.start();f.user('我拒绝继续寻找。');
    const h=f.fail({...failedReport(),choice:'拒绝寻找',choiceEvidence:'我拒绝继续寻找'});
    assert.equal(h.choice,'拒绝寻找');assert.equal(h.choiceSource.body,'我拒绝继续寻找。');
    assert.equal(f.profile().rank,0);assert.equal(f.profile().traits.length,0);
});

test('intermediate changed choices remain valid evidence for success and failure',()=>{
    for(const failed of [false,true]) {
        const f=fixture();f.start();f.advance();const decision=f.answer('我改为远程协助。');f.answer('继续。');
        assert.equal(f.event.answerSources.length,3);
        const change={choice:'改为远程协助',choiceEvidence:'我改为远程协助'};
        const h=failed?f.fail({...failedReport(),...change}):f.complete({...completedReport(),...change});
        assert.equal(h.choiceSource.id,decision.id);assert.equal(h.choice,'改为远程协助');
        assert.equal(f.profile().rank,failed?0:1);
    }
});

for(const invalid of ['reason','outcome','outcomeEvidence','choiceEvidence','sharedFacts']) test('failure rejects invalid '+invalid+' without partial mutation',()=>{
    const f=fixture();f.start();f.user('我拒绝继续寻找。');const before=clone(f.state),report=failedReport();
    if(invalid==='reason' || invalid==='outcome') report[invalid]='';
    else if(invalid==='outcomeEvidence') report.outcomeEvidence='根本没有出现的事实';
    else if(invalid==='choiceEvidence') Object.assign(report,{choice:'放弃',choiceEvidence:'用户从未说过的话'});
    else report.sharedFacts=[{entityId:'painting',fact:'已烧毁',evidence:'伪造的引用'}];
    assert.throws(()=>f.fail(report),{code:'INVALID_EVIDENCE'});assert.deepEqual(clone(f.state),before);
});

test('failure preserves evidenced shared world facts for the next attempt',()=>{
    const f=fixture();f.start();f.fail({...failedReport(),sharedFacts:[{
        entityId:'original',name:'原稿',fact:'原稿已经烧毁',evidence:'唯一原稿已经烧毁',knownBy:['a'],
    }]});
    assert.equal(f.state.sharedFacts.original.fact,'原稿已经烧毁');
    assert.match(continuity(f.profile()),/原稿已经烧毁/);
});

test('new live force archives cannot promote an unmet objective; confirmed legacy force replays can',()=>{
    const f=fixture();f.start();f.advance();const report=completedReport();report.scene.goalAchieved=false;
    assert.throws(()=>f.complete(report,{requireSceneClosure:false}),{code:'NOT_COMPLETE'});
    assert.equal(f.profile().rank,0);assert.ok(f.profile().lock);
    const source=f.reply('她宣布资料核对完毕，感谢你的协助。');
    const h=acceptBeat(f.state,{characterId:'a',eventId:f.event.id,eventVersion:f.event.version,phase:'resolution',
        source,evidence:'资料核对完毕',completion:report,requireSceneClosure:false},{replay:true});
    assert.equal(f.profile().rank,1);assert.equal(h.closedBy,'force');
});

test('history signatures with no failures preserve the pre-upgrade hash',()=>{
    const f=fixture();assert.equal(historySignature(f.profile()),hash(JSON.stringify([])));
    f.start();f.advance();f.complete();
    assert.equal(historySignature(f.profile()),hash(JSON.stringify(f.profile().history.map(h=>[h.eventId,h.summary,h.summaryVersion]))));
});

function journalFixture() {
    const document=newDocument('failed-attempts');document.roster.a={id:'a',name:'画家',mode:'coop',initialAffinity:30,rankCount:4,
        thresholds:rankPolicy(4).thresholds.slice(),policyRevision:1};
    const sources=new Map();let state=project(document,sources),index=0,user=null,opId=0;
    const h={document,sources,get state(){return state;},profile:()=>state.profiles.a,
        user(body='我看看现场。') {user={id:'u'+(++index),index,version:'v'+index,isUser:true,body};sources.set(user.id,user);return user;},
        reply(body) {const source={id:'m'+(++index),index,version:'v'+index,isUser:false,body,
            userId:user.id,userVersion:user.version,userIndex:user.index,userBody:user.body};sources.set(source.id,source);return source;},
        op(kind,data,refs=[]) {state=appendOperation(document,state,{id:'op'+(++opId),kind,characterId:'a',mode:'coop',data,refs},sources);return state;},
        start(eventId) {const anchor=h.user();if(!h.profile().lock) h.op('activate',{});
            h.op('plan',{eventId,gateId:h.profile().lock.id,plan:makePlan(h.profile()),createdAt:{id:anchor.id,index:anchor.index}},references(anchor));return anchor;},
        fail(eventId) {const source=h.reply('她确认唯一原稿已经烧毁，已经无法核对。'),event=h.profile().events[eventId];
            h.op('beat',{eventId,phase:event.phase,eventVersion:event.version,failed:true,evidence:'唯一原稿已经烧毁',
                failure:failedReport(),source},references(source));return source;},
    };
    return h;
}

test('failed archives, retry links and locks survive document reload',()=>{
    const h=journalFixture();h.start('first');h.fail('first');h.start('retry');h.fail('retry');
    const state=project(readDocument(h.document,'failed-attempts'),h.sources);
    assert.deepEqual(state.profiles.a.failedHistory,h.profile().failedHistory);
    assert.equal(state.profiles.a.rank,0);assert.ok(state.profiles.a.lock);
    assert.equal(state.profiles.a.events.retry.retryOf,'first');assert.equal(pendingRetry(state.profiles.a).eventId,'retry');
    assert.deepEqual(state.skipped,[]);
});

test('deleting a later same-rank retry keeps all earlier failed attempts',()=>{
    const h=journalFixture();h.start('first');h.fail('first');h.start('second');h.fail('second');const origin=h.start('third');
    h.sources.delete(origin.id);
    assert.deepEqual([...deletedEventIds(h.document,h.sources)],['third']);
    pruneDeletedEvents(h.document,h.sources);const state=project(h.document,h.sources),p=state.profiles.a;
    assert.deepEqual(p.failedHistory.map(entry=>entry.eventId),['first','second']);
    assert.equal(p.events.third,undefined);assert.equal(pendingRetry(p).eventId,'second');assert.ok(p.lock);
});

test('deleting a failure source invalidates its dependent retry and restores the original attempt',()=>{
    const h=journalFixture();h.start('first');const failedSource=h.fail('first');h.start('retry');
    h.sources.delete(failedSource.id);
    let state=project(h.document,h.sources);
    assert.equal(state.profiles.a.failedHistory.length,0);assert.equal(state.profiles.a.events.first.phase,'hook');
    assert.equal(state.profiles.a.events.retry,undefined);assert.equal(state.activeEventId,'first');
    assert.ok(state.skipped.some(entry=>entry.code==='STALE_DEPENDENCY'));
    assert.deepEqual([...deletedEventIds(h.document,h.sources)],['retry']);
    pruneDeletedEvents(h.document,h.sources);state=project(h.document,h.sources);
    assert.equal(state.activeEventId,'first');assert.ok(state.profiles.a.lock);
});

test('MVU does not request unlocking a failed Rank even when the current value is below its threshold',()=>{
    const f=fixture();f.start('rank-one');f.advance();f.complete();f.start('rank-two');f.fail();
    readMvuAffinity({messages:()=>[]},f.state,{live:{stat_data:{故事导演:{Coop:{角色:{画家:{角色ID:'a',好感度:50,好感锁定:true}}}}}}});
    assert.equal(f.profile().rank,1);assert.equal(f.profile().unlockAfterArchive,false);assert.ok(f.profile().lock);
});
