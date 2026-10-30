import test from 'node:test';
import assert from 'node:assert/strict';
import {initialState,applyAffinity,adoptPlan,acceptBeat,acceptAnswer,chooseRoute,pauseEvent,resumeEvent,replanEvent,assertState,validatePlan,THRESHOLDS,clone} from '../coop/model.js';
import {continuity} from '../coop/history.js';
import {configureRoster} from '../coop/roster.js';
import {newDocument,project,appendOperation} from '../coop/timeline.js';
import {ensureMessageIds,sourceMap,ref,references,parseReports,visibleBody,safeJson} from '../coop/messages.js';
const config=(id='a',mode='coop')=>({id,name:'角色'+id,mode,thresholds:THRESHOLDS,initialAffinity:0});
export function plan(p) {return {targetRank:p.rank+1,title:'旧画册的线索',scene:'画室',conflict:'理想与现实无法兼顾',goal:'明确下一步与边界',
    hook:'她手里的旧画册突然掉落',dilemma:'她不知是否向导师提出异议',question:'你怎么看待这份责任？',
    resolution:'依据实际回应形成局部落点，留下下一步',seeds:p.seeds || {persona:'能干的画家',desire:'完成自己的展览',shadow:'害怕否定',friction:'与导师理念不合'},
    usedHistory:p.history.map(h=>h.eventId),references:[],conflicts:[]};}
function state(mode='coop'){return initialState({a:config('a',mode)});}
function score(s,delta,user='u'){return applyAffinity(s,{characterId:'a',delta,reason:'实际帮助',interactionId:user,source:{index:1}});}
function start(s,rank=1) {
    const p=s.profiles.a;
    for(let i=0;p.affinity<THRESHOLDS[rank-1];i++) score(s,5,'score-'+rank+'-'+i);
    return adoptPlan(s,{characterId:'a',gateId:p.lock.id,eventId:'e'+rank,plan:plan(p)});
}
const source=(user,index,body='她放下旧画册，正面提出问题。')=>({id:'m'+index,version:'v'+index,index,body,
    isUser:false,userId:user,userIndex:index-1,userBody:'我愿意帮你处理这件事。'});
const completion=()=>({summary:'她向用户说明了旧画册背后的顾虑，两人决定先核对展览资料。她开始接受有限的帮助，导师的问题仍待处理。',
    outcome:'决定先核对资料',outcomeEvidence:'核对资料',choice:'愿意帮忙',choiceEvidence:'愿意帮',
    traits:['紧张时会整理画册'],facts:['旧画册属于她'],boundaries:['愿意谈及工作烦恼'],openHooks:['导师的问题'],closedHooks:[],conflicts:[]});
function finish(s,e,route='friendship',report=null) {
    acceptBeat(s,{characterId:'a',eventId:e.id,eventVersion:e.version,phase:'hook',evidence:'旧画册',source:source('hook-'+e.id,2)});
    acceptBeat(s,{characterId:'a',eventId:e.id,eventVersion:e.version,phase:'dilemma',evidence:'提出问题',source:source('question-'+e.id,4)});
    acceptAnswer(s,{characterId:'a',eventId:e.id,source:{id:'answer-'+e.id,version:'v',index:5,isUser:true,body:'我愿意帮你处理这件事。'}});
    if(e.targetRank===3) chooseRoute(s,{characterId:'a',eventId:e.id,route});
    return acceptBeat(s,{characterId:'a',eventId:e.id,eventVersion:e.version,phase:'resolution',evidence:'核对资料',
        source:source('answer-'+e.id,6,'她决定核对资料，放下独自硬撑的姿态。'),completion:report || completion()});
}
test('A01: crossing a gate caps and locks, discarding overflow',()=>{
    const s=state();s.profiles.a.affinity=28;
    score(s,5);assert.equal(s.profiles.a.affinity,30);assert.equal(s.profiles.a.lock.targetRank,1);assert.equal(s.profiles.a.scoreLog[0].actual,2);
});
test('A02/A03: lock rejects both positive and negative changes while pending',()=>{
    const s=state();for(let i=0;i<6;i++) score(s,5,'pending-'+i);
    assert.equal(score(s,5,'blocked-plus').actual,0);assert.equal(score(s,-10,'blocked-minus').actual,0);assert.equal(s.profiles.a.affinity,30);
});
test('A04: repeated user interaction cannot be scored twice',()=>{
    const s=state();score(s,2);assert.throws(()=>score(s,2),{code:'ALREADY_COMMITTED'});
});
test('A05/A06/A37: completion commits rank, summary, traits and unlock once',()=>{
    const s=state(),e=start(s);const h=finish(s,e);
    assert.equal(s.profiles.a.rank,1);assert.equal(s.profiles.a.lock,null);assert.equal(s.profiles.a.affinity,30);
    assert.ok(h.summary.includes('旧画册'));assert.equal(s.profiles.a.history.length,1);assertState(s);
    assert.throws(()=>finish(s,e));assert.equal(s.profiles.a.rank,1);
});
test('A07/A48: delayed report from a locked source stays zero after unlock',()=>{
    const s=state(),e=start(s);finish(s,e);
    const r=applyAffinity(s,{characterId:'a',delta:5,interactionId:'late',lockedAtSource:true,source:{}});
    assert.equal(r.actual,0);assert.equal(s.profiles.a.affinity,30);
});
test('A08: pause and resume preserve the same gate and stage',()=>{
    const s=state(),e=start(s),gate=s.profiles.a.lock.id;
    pauseEvent(s,'a',e.id);assert.equal(s.activeEventId,null);assert.equal(s.profiles.a.lock.id,gate);
    resumeEvent(s,'a',e.id);assert.equal(s.activeEventId,e.id);assert.equal(e.phase,'hook');
});
test('A13: another role can score while one Coop scene owns the stage',()=>{
    const s=state();s.profiles.b=initialState({b:config('b')}).profiles.b;
    const e=start(s);
    applyAffinity(s,{characterId:'b',delta:5,interactionId:'ub',source:{}});
    assert.equal(s.activeEventId,e.id);assert.equal(s.profiles.b.affinity,5);
});
test('A15/A47: one user interaction cannot complete two phases',()=>{
    const s=state(),e=start(s),a=source('same-user',2);
    acceptBeat(s,{characterId:'a',eventId:e.id,eventVersion:e.version,phase:'hook',evidence:'旧画册',source:a});
    assert.throws(()=>acceptBeat(s,{characterId:'a',eventId:e.id,eventVersion:e.version,phase:'dilemma',evidence:'旧画册',source:a}),{code:'WAITING_USER'});
});
test('A15: cannot finish without a real reply after the question',()=>{
    const s=state(),e=start(s);
    assert.throws(()=>acceptBeat(s,{characterId:'a',eventId:e.id,eventVersion:e.version,phase:'resolution',evidence:'旧画册',source:source('same',2),completion:completion()}),{code:'STALE_EVENT'});
});
test('A22/A38/A39: all four ranks retain and inject every previous summary',()=>{
    const s=state();
    for(let rank=1;rank<=4;rank++){
        const e=start(s,rank);finish(s,e);
        assert.equal(s.profiles.a.rank,rank);assert.equal(s.profiles.a.history.length,rank);
        assert.equal(s.profiles.a.affinity,THRESHOLDS[rank-1]);assert.equal(s.profiles.a.lock,null);
        const memory=continuity(s.profiles.a);
        for(let previous=1;previous<=rank;previous++) assert.ok(memory.includes('Rank '+previous+' [事件 e'+previous+']'));
        assertState(s);
    }
    score(s,-3,'after-max');assert.equal(s.profiles.a.affinity,97);assert.equal(s.profiles.a.lock,null);
});
test('A23/A40: future plan cannot replace established seeds or omit history',()=>{
    const s=state(),e=start(s);finish(s,e);const p=s.profiles.a;
    assert.throws(()=>validatePlan({...plan(p),usedHistory:[]},p),{code:'HISTORY_MISSING'});
    const next=plan(p);next.seeds={...next.seeds,friction:'另一个毫无关系的反派'};
    assert.throws(()=>validatePlan(next,p),{code:'CONTINUITY_CONFLICT'});
});
test('A29/A30: unmanaged roles cannot score or get auto-created',()=>{
    const s=state('off');assert.throws(()=>score(s,1),{code:'NOT_MANAGED'});
    assert.throws(()=>applyAffinity(s,{characterId:'unselected',delta:1,interactionId:'u'}),{code:'NOT_MANAGED'});
    assert.equal(Object.keys(s.profiles).length,1);
});
test('A31: affinity-only mode has no rank gates',()=>{
    const s=state('affinity');
    for(let i=0;i<20;i++) score(s,5,'i'+i);
    assert.equal(s.profiles.a.affinity,100);assert.equal(s.profiles.a.lock,null);
});
test('A41/A55: sufficient confirmed fields can supply a summary fallback',()=>{
    const s=state(),e=start(s);
    const report=completion();report.summary='';
    acceptBeat(s,{characterId:'a',eventId:e.id,eventVersion:e.version,phase:'hook',evidence:'旧画册',source:source('u1',2)});
    acceptBeat(s,{characterId:'a',eventId:e.id,eventVersion:e.version,phase:'dilemma',evidence:'提出问题',source:source('u2',4)});
    acceptAnswer(s,{characterId:'a',eventId:e.id,source:{id:'u3',index:5,isUser:true,body:'我愿意帮你处理这件事。'}});
    acceptBeat(s,{characterId:'a',eventId:e.id,eventVersion:e.version,phase:'resolution',evidence:'核对资料',
        source:source('u3',6,'她决定核对资料。'),completion:report});
    assert.ok(s.profiles.a.history[0].summary.includes('用户回应'));
});
test('A54: importing high affinity cannot silently consume progress',()=>{
    const doc=newDocument('scope');const s=initialState();
    assert.throws(()=>configureRoster(doc,s,{id:'a',name:'A',mode:'coop',initialAffinity:80}),{code:'CAP_CONFIRMATION'});
    configureRoster(doc,s,{id:'a',name:'A',mode:'affinity',initialAffinity:80});
    assert.equal(doc.roster.a.initialAffinity,80);
});
test('A57: strict JSON and IDs reject prototype payloads',()=>{
    assert.throws(()=>safeJson('{"__proto__":{"polluted":true}}'));
    assert.throws(()=>initialState({bad:config('__proto__')}));
    assert.equal({}.polluted,undefined);
});
test('report tags are data, malformed reports are not evaluated',()=>{
    assert.deepEqual(parseReports('正文<CoopReport>{"nonce":"n"}</CoopReport>'),[{nonce:'n'}]);
    assert.deepEqual(parseReports('<CoopReport>globalThis.compromised=true</CoopReport>'),[]);
    assert.equal(visibleBody('正文<CoopReport>{"x":1}</CoopReport>'),'正文');
});
test('A17/A18/A42: replay keeps edited sources and rolls back deleted sources',()=>{
    const doc=newDocument('scope');doc.roster.a=config();
    const messages=[{is_user:true,mes:'我帮你整理资料。'},{is_user:false,mes:'她放松了。'}];
    ensureMessageIds(messages);let map=sourceMap(messages),s=project(doc,map);
    const src=[...map.values()][1];
    appendOperation(doc,s,{id:'score',kind:'affinity',characterId:'a',mode:'coop',refs:references(src),
        data:{characterId:'a',delta:5,interactionId:src.userId,source:src}},map);
    assert.equal(project(doc,map).profiles.a.affinity,5);
    messages[0].mes='我拒绝帮助。';map=sourceMap(messages);
    assert.equal(project(doc,map).profiles.a.affinity,5);
    messages.shift();map=sourceMap(messages);
    assert.equal(project(doc,map).profiles.a.affinity,0);assert.equal(project(doc,map).skipped[0].code,'STALE_SOURCE');
});
test('A32: roster mode changes do not erase already earned scores on replay',()=>{
    const doc=newDocument('scope');doc.roster.a=config();
    const map=new Map(),s=project(doc,map);
    appendOperation(doc,s,{id:'old-score',kind:'affinity',characterId:'a',mode:'coop',refs:[],
        data:{characterId:'a',delta:5,interactionId:'past',source:{}}},map);
    doc.roster.a.mode='off';
    assert.equal(project(doc,map).profiles.a.affinity,5);assert.equal(project(doc,map).profiles.a.mode,'off');
});
for(const route of ['friendship','romance']) test('Rank 3 requires explicit route confirmation: '+route,()=>{
    const s=state();for(let r=1;r<3;r++) finish(s,start(s,r));
    const e=start(s,3);
    acceptBeat(s,{characterId:'a',eventId:e.id,eventVersion:e.version,phase:'hook',evidence:'旧画册',source:source('u1',2)});
    acceptBeat(s,{characterId:'a',eventId:e.id,eventVersion:e.version,phase:'dilemma',evidence:'提出问题',source:source('u2',4)});
    acceptAnswer(s,{characterId:'a',eventId:e.id,source:{id:'u3',index:5,isUser:true,body:'我愿意帮你处理这件事。'}});
    assert.equal(e.phase,'waiting_route');assert.equal(s.profiles.a.route,'unset');
    assert.throws(()=>chooseRoute(s,{characterId:'a',eventId:e.id,route:'maybe'}),{code:'INVALID_ROUTE'});
    chooseRoute(s,{characterId:'a',eventId:e.id,route});
    acceptBeat(s,{characterId:'a',eventId:e.id,eventVersion:e.version,phase:'resolution',evidence:'核对资料',source:source('u3',6,'她决定核对资料。'),completion:completion()});
    assert.equal(s.profiles.a.route,route);
});
test('two-round event combines hook and dilemma but still requires a user answer',()=>{
    const s=state(),e=start(s);e.plan.rounds=2;
    acceptBeat(s,{characterId:'a',eventId:e.id,eventVersion:e.version,phase:'hook',evidence:'提出问题',source:source('u1',2)});
    assert.equal(e.phase,'waiting_user');
    assert.throws(()=>acceptAnswer(s,{characterId:'a',eventId:e.id,source:{id:'old',index:1,isUser:true,body:'old'}}),{code:'WAITING_USER'});
    acceptAnswer(s,{characterId:'a',eventId:e.id,source:{id:'u2',index:3,isUser:true,body:'我愿意帮你处理这件事。'}});
    acceptBeat(s,{characterId:'a',eventId:e.id,eventVersion:e.version,phase:'resolution',evidence:'核对资料',source:source('u2',4,'她决定核对资料。'),completion:completion()});
    assert.equal(s.profiles.a.rank,1);
});
test('wrong completion evidence keeps rank and lock unchanged',()=>{
    const s=state(),e=start(s),report=completion();report.choiceEvidence='用户从未说过这句话';
    assert.throws(()=>finish(s,e,'friendship',report),{code:'INVALID_EVIDENCE'});
    assert.equal(s.profiles.a.rank,0);assert.ok(s.profiles.a.lock);
});
test('a completion without character growth is rejected',()=>{
    const s=state(),e=start(s),report=completion();report.traits=[];report.facts=[];report.boundaries=[];
    assert.throws(()=>finish(s,e,'friendship',report),{code:'GROWTH_MISSING'});
    assert.equal(s.profiles.a.history.length,0);
});
test('stale event revision cannot advance even with a real quote',()=>{
    const s=state(),e=start(s);
    assert.throws(()=>acceptBeat(s,{characterId:'a',eventId:e.id,eventVersion:e.version+1,phase:'hook',evidence:'旧画册',source:source('u',2)}),{code:'STALE_EVENT'});
    assert.equal(e.phase,'hook');
});
test('one gate cannot acquire a second unfinished event',()=>{
    const s=state(),e=start(s);pauseEvent(s,'a',e.id);
    assert.throws(()=>adoptPlan(s,{characterId:'a',gateId:s.profiles.a.lock.id,eventId:'duplicate',plan:plan(s.profiles.a)}),{code:'EVENT_EXISTS'});
});
test('shared world facts cannot silently replace a known entity state',()=>{
    const s=state(),report=completion();
    report.sharedFacts=[{entityId:'prop:papers',name:'展览资料',fact:'资料待核对',evidence:'核对资料',knownBy:['user','a']}];
    finish(s,start(s),'friendship',report);
    assert.equal(s.sharedFacts['prop:papers'].fact,'资料待核对');
    const next=completion();next.sharedFacts=[{entityId:'prop:papers',fact:'资料已核对',evidence:'核对资料'}];
    assert.throws(()=>finish(s,start(s,2),'friendship',next),{code:'CONTINUITY_CONFLICT'});
    assert.equal(s.sharedFacts['prop:papers'].fact,'资料待核对');
});
test('known shared fact can evolve with its explicit prior state',()=>{
    const s=state(),report=completion();
    report.sharedFacts=[{entityId:'prop:papers',fact:'资料待核对',evidence:'核对资料'}];
    finish(s,start(s),'friendship',report);
    const next=completion();next.sharedFacts=[{entityId:'prop:papers',fact:'资料正在核对',previousFact:'资料待核对',evidence:'核对资料'}];
    finish(s,start(s,2),'friendship',next);
    assert.equal(s.sharedFacts['prop:papers'].fact,'资料正在核对');
});
test('history budget overflow fails visibly instead of dropping old ranks',()=>{
    const s=state();s.profiles.a.facts=Array.from({length:120},(_,i)=>'事实'+i+'：'+'长'.repeat(300));
    assert.throws(()=>continuity(s.profiles.a),{code:'CONTEXT_BUDGET'});
});
test('invalid or unbounded model scores do not alter affinity',()=>{
    const s=state('affinity');
    for(const delta of [NaN,Infinity,6,-11,1.5,'5']) assert.throws(()=>score(s,delta),{code:'INVALID_NUMBER'});
    assert.equal(s.profiles.a.affinity,0);
});
test('affinity range remains bounded after repeated negative changes',()=>{
    const s=state('affinity');score(s,5,'gain');
    score(s,-10,'loss');assert.equal(s.profiles.a.affinity,0);
});
test('a new reply after Rank 3 route confirmation does not loop back to route choice',()=>{
    const s=state();for(let r=1;r<3;r++) finish(s,start(s,r));const e=start(s,3);
    acceptBeat(s,{characterId:'a',eventId:e.id,eventVersion:e.version,phase:'hook',evidence:'旧画册',source:source('u1',2)});
    acceptBeat(s,{characterId:'a',eventId:e.id,eventVersion:e.version,phase:'dilemma',evidence:'提出问题',source:source('u2',4)});
    acceptAnswer(s,{characterId:'a',eventId:e.id,source:{id:'u3',index:5,isUser:true,body:'我愿意帮你处理这件事。'}});
    chooseRoute(s,{characterId:'a',eventId:e.id,route:'friendship'});
    acceptAnswer(s,{characterId:'a',eventId:e.id,source:{id:'u4',index:7,isUser:true,body:'继续说吧。'}});
    assert.equal(e.phase,'resolution');assert.equal(e.route,'friendship');assert.equal(e.routeSource.id,'u3');
    assert.equal(e.initialAnswerSource.id,'u3');assert.equal(e.answerSource.id,'u4');
    acceptBeat(s,{characterId:'a',eventId:e.id,eventVersion:e.version,phase:'resolution',evidence:'核对资料',source:source('u4',8,'她决定核对资料。'),completion:completion()});
    assert.equal(s.profiles.a.rank,3);
});

for(const phase of ['hook','dilemma','waiting_user','waiting_route','resolution']) test('replan freezes performed material at '+phase,()=>{
    const s=state(),rank=['waiting_route','resolution'].includes(phase)?3:1;
    for(let r=1;r<rank;r++) finish(s,start(s,r));
    const e=start(s,rank);e.plan.rounds=3;
    if(phase!=='hook') acceptBeat(s,{characterId:'a',eventId:e.id,eventVersion:e.version,phase:'hook',evidence:'旧画册',source:source('u1',2)});
    if(!['hook','dilemma'].includes(phase)) acceptBeat(s,{characterId:'a',eventId:e.id,eventVersion:e.version,phase:'dilemma',evidence:'提出问题',source:source('u2',4)});
    if(['waiting_route','resolution'].includes(phase)) acceptAnswer(s,{characterId:'a',eventId:e.id,source:{id:'u3',index:5,isUser:true,body:'我愿意帮你。'}});
    if(phase==='resolution') chooseRoute(s,{characterId:'a',eventId:e.id,route:'friendship'});
    assert.equal(e.phase,phase);pauseEvent(s,'a',e.id);
    const before=clone(e),replacement={...plan(s.profiles.a),rounds:2};
    for(const key of ['title','scene','conflict','goal','hook','dilemma','question','resolution']) replacement[key]='重设：'+replacement[key];
    replanEvent(s,{characterId:'a',eventId:e.id,plan:replacement});
    for(const key of ['title','scene','conflict','goal','hook','rounds']) assert.equal(e.plan[key],phase==='hook'?replacement[key]:before.plan[key]);
    for(const key of ['dilemma','question']) assert.equal(e.plan[key],e.questionSource?before.plan[key]:replacement[key]);
    assert.equal(e.plan.resolution,replacement.resolution);
    for(const key of ['phase','progress','playedUsers','questionSource','initialAnswerSource','answerSource','route','routeSource']) assert.deepEqual(e[key],before[key]);
    resumeEvent(s,'a',e.id);assert.equal(e.phase,phase);assertState(s);
});
test('a performed two-round opening keeps both its dilemma and question when replanned',()=>{
    const s=state(),e=start(s);e.plan.rounds=2;
    acceptBeat(s,{characterId:'a',eventId:e.id,eventVersion:e.version,phase:'hook',evidence:'提出问题',source:source('u1',2)});
    pauseEvent(s,'a',e.id);const before=clone(e.plan);
    replanEvent(s,{characterId:'a',eventId:e.id,plan:{...plan(s.profiles.a),rounds:3,hook:'新开场',dilemma:'新困境',question:'新问题'}});
    assert.equal(e.plan.rounds,2);assert.equal(e.plan.hook,before.hook);
    assert.equal(e.plan.dilemma,before.dilemma);assert.equal(e.plan.question,before.question);
    resumeEvent(s,'a',e.id);
    acceptAnswer(s,{characterId:'a',eventId:e.id,source:{id:'u2',index:3,isUser:true,body:'我愿意帮你处理这件事。'}});
    acceptBeat(s,{characterId:'a',eventId:e.id,eventVersion:e.version,phase:'resolution',evidence:'核对资料',source:source('u2',4,'她决定核对资料。'),completion:completion()});
    assert.equal(s.profiles.a.rank,1);
});
test('consecutive resolution inputs preserve the original choice and bind completion to the latest input',()=>{
    const s=state(),e=start(s);
    acceptBeat(s,{characterId:'a',eventId:e.id,eventVersion:e.version,phase:'hook',evidence:'旧画册',source:source('u1',2)});
    acceptBeat(s,{characterId:'a',eventId:e.id,eventVersion:e.version,phase:'dilemma',evidence:'提出问题',source:source('u2',4)});
    const answer={id:'u3',version:'v3',index:5,isUser:true,body:'我愿意帮你处理这件事。'};
    acceptAnswer(s,{characterId:'a',eventId:e.id,source:answer});const oldVersion=e.version;
    acceptAnswer(s,{characterId:'a',eventId:e.id,source:{id:'u4',version:'v4',index:6,isUser:true,body:'先坐下来吧。'}});
    acceptAnswer(s,{characterId:'a',eventId:e.id,source:{id:'u5',version:'v5',index:7,isUser:true,body:'慢慢来。'}});
    assert.deepEqual(e.initialAnswerSource,answer);assert.equal(e.answerSource.id,'u5');
    assert.throws(()=>acceptBeat(s,{characterId:'a',eventId:e.id,eventVersion:oldVersion,phase:'resolution',evidence:'核对资料',source:source('u3',8,'她决定核对资料。'),completion:completion()}),{code:'STALE_EVENT'});
    acceptBeat(s,{characterId:'a',eventId:e.id,eventVersion:e.version,phase:'resolution',evidence:'核对资料',source:source('u5',8,'她决定核对资料。'),completion:completion()});
    assert.equal(s.profiles.a.rank,1);assert.equal(s.profiles.a.history[0].initialAnswerSource.id,'u3');
    assert.equal(s.profiles.a.history[0].answerSource.id,'u5');
});
test('a grounded Rank 3 route conflict requires explicit confirmation before completion',()=>{
    const s=state();for(let r=1;r<3;r++) finish(s,start(s,r));const e=start(s,3);
    acceptBeat(s,{characterId:'a',eventId:e.id,eventVersion:e.version,phase:'hook',evidence:'旧画册',source:source('u1',2)});
    acceptBeat(s,{characterId:'a',eventId:e.id,eventVersion:e.version,phase:'dilemma',evidence:'提出问题',source:source('u2',4)});
    acceptAnswer(s,{characterId:'a',eventId:e.id,source:{id:'u3',index:5,isUser:true,body:'我愿意成为恋人。'}});
    chooseRoute(s,{characterId:'a',eventId:e.id,route:'romance'});
    acceptAnswer(s,{characterId:'a',eventId:e.id,source:{id:'u4',index:7,isUser:true,body:'我只想和你做朋友。'}});
    const version=e.version,proposal={characterId:'a',eventId:e.id,eventVersion:version,phase:'resolution',routeConflict:true,
        evidence:'尊重你的选择',userEvidence:'只想和你做朋友',source:source('u4',8,'她决定尊重你的选择。')};
    assert.throws(()=>acceptBeat(s,{...proposal,userEvidence:'并未说过的话'}),{code:'INVALID_EVIDENCE'});
    acceptBeat(s,proposal);
    assert.equal(e.phase,'waiting_route');assert.equal(e.route,null);assert.equal(e.routeSource,null);
    assert.equal(s.profiles.a.rank,2);assert.ok(s.profiles.a.lock);
    chooseRoute(s,{characterId:'a',eventId:e.id,route:'friendship'});
    assert.equal(e.routeSource.id,'u4');
    assert.throws(()=>acceptBeat(s,proposal),{code:'STALE_EVENT'});
    const report={...completion(),choice:'做朋友',choiceEvidence:'只想和你做朋友'};
    acceptBeat(s,{characterId:'a',eventId:e.id,eventVersion:e.version,phase:'resolution',evidence:'核对资料',source:source('u4',9,'她决定核对资料。'),completion:report});
    assert.equal(s.profiles.a.rank,3);assert.equal(s.profiles.a.route,'friendship');
});
