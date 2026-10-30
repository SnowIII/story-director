/** Pure Coop rules. Model reports are proposals; only these transitions own progress. */
import {parseAliases} from './identity.js';
import {hasEvidence} from './body.js';
import {RANK_POLICIES} from './ranks.js';
export {RANK_COUNTS} from './ranks.js';
export const SCHEMA = 2;
export const MODES = ['off', 'affinity', 'coop'];
export const THRESHOLDS = RANK_POLICIES[4].thresholds;
export const RANK_COUNT = THRESHOLDS.length;
export const RELATIONSHIP_RANK = 3;
export const PHASES = ['hook','dilemma','waiting_user','waiting_route','resolution','completed'];
export const clone = value => JSON.parse(JSON.stringify(value));
export const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
export const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
export function fail(code, detail = '') { const error = new Error(detail || code); error.code = code; throw error; }
export function text(value, max = 1200) { return typeof value === 'string' ? value.trim().slice(0, max) : ''; }
export function id(value) {
    const result = text(value, 180);
    if (!result || ['__proto__','prototype','constructor'].includes(result) || !/^[\w:./ -]+$/u.test(result)) fail('INVALID_ID');
    return result;
}
export function hash(value) {
    let a = 2166136261;
    for (const char of String(value)) a = Math.imul(a ^ char.codePointAt(0), 16777619);
    return (a >>> 0).toString(36);
}
export function integer(value, min, max) { if (!Number.isInteger(value) || value < min || value > max) fail('INVALID_NUMBER'); return value; }
export function rankPolicy(value=4) {
    const count=object(value)?value.rankCount ?? 4:value;
    if(!Number.isInteger(count) || !Object.hasOwn(RANK_POLICIES,count)) fail('INVALID_RANK_SYSTEM','请选择 4、7 或 10 阶方案');
    return RANK_POLICIES[count];
}
export function thresholds(value,rankCount=4) {
    const expected=rankPolicy(rankCount).thresholds;
    value=value ?? expected;
    if (!Array.isArray(value) || value.length !== expected.length || value.some((v,i)=>v!==expected[i])) {
        fail('INVALID_THRESHOLDS','门槛必须与已选的 '+rankCount+' 阶方案一致，不可单独修改');
    }
    return value.slice();
}
export function lines(value, limit = 8) {
    if (!Array.isArray(value)) return [];
    return [...new Set(value.map(v=>text(v,300)).filter(Boolean))].slice(0,limit);
}
export function newProfile(config) {
    return { id:id(config.id), name:text(config.name,100), aliases:parseAliases(config.aliases || [],config.name),description:text(config.description,12000),
        cardRef:text(config.cardRef,200), mode:config.mode || 'off', policyRevision:config.policyRevision || 1,
        affinity:integer(config.initialAffinity ?? 0,0,100), rank:0, route:'unset', lock:null,
        rankCount:rankPolicy(config).rankCount,thresholds:thresholds(config.thresholds,rankPolicy(config).rankCount), seeds:null, traits:[], facts:[], boundaries:[],
        openHooks:[], history:[], events:{}, scoreLog:[], revision:0 };
}
export function initialState(roster = {}) {
    const profiles = Object.create(null);
    for (const config of Object.values(roster)) profiles[id(config.id)] = newProfile(config);
    return { profiles, activeEventId:null, historyRevision:0, sharedFacts:Object.create(null), applied:[] };
}
export function profileOf(state, characterId) {
    if (!own(state.profiles, characterId)) fail('NOT_MANAGED');
    return state.profiles[characterId];
}
export function gateFor(profile, sourceKey) {
    return { id:'gate-' + hash(profile.id + ':' + (profile.rank+1) + ':' + sourceKey),
        targetRank:profile.rank+1, lockedValue:profile.affinity };
}
export function applyAffinity(state, input) {
    const p = profileOf(state,input.characterId);
    if (p.mode === 'off') fail('NOT_MANAGED');
    const delta = integer(input.delta,-10,5);
    if (!input.interactionId) fail('INVALID_SOURCE');
    if (p.scoreLog.some(x=>x.interactionId === input.interactionId)) fail('ALREADY_COMMITTED');
    let actual = 0, reasonCode = '';
    const before = p.affinity;
    if (p.lock || input.lockedAtSource) reasonCode = 'AFFINITY_LOCKED';
    else {
        const proposed = Math.max(0,Math.min(100,before+delta));
        const gates = thresholds(input.thresholds || p.thresholds,p.rankCount);
        if (p.mode === 'coop' && p.rank < p.rankCount && proposed >= gates[p.rank]) {
            p.affinity = gates[p.rank];
            p.lock = gateFor(p,input.interactionId);
        } else p.affinity = proposed;
        actual = p.affinity-before;
    }
    p.scoreLog.push({interactionId:input.interactionId,requested:delta,actual,reason:text(input.reason,300),
        reasonCode, before,after:p.affinity,source:clone(input.source || {})});
    p.revision++;
    return {actual,reasonCode,locked:!!p.lock};
}
export function activateGate(state, characterId, token, gateThresholds=null) {
    const p=profileOf(state,characterId);
    const gates=thresholds(gateThresholds || p.thresholds,p.rankCount);
    if (p.mode !== 'coop' || p.lock || p.rank >= p.rankCount || p.affinity < gates[p.rank]) return false;
    p.affinity=gates[p.rank]; p.lock=gateFor(p,token); p.revision++; return true;
}
export function activeEvent(state) {
    if (!state.activeEventId) return null;
    for (const p of Object.values(state.profiles)) if (own(p.events,state.activeEventId)) return p.events[state.activeEventId];
    return null;
}
export const historySignature=p=>hash(JSON.stringify(p.history.map(h=>[h.eventId,h.summary,h.summaryVersion])));
/** A paused Rank still owns the queue until it is actually completed. */
export function unfinishedEvent(state) {
    return Object.values(state.profiles).flatMap(p=>Object.values(p.events)).filter(e=>e.phase!=='completed')
        .sort((a,b)=>(a.createdAt?.index ?? a.progress[0]?.source.index ?? Infinity)-(b.createdAt?.index ?? b.progress[0]?.source.index ?? Infinity))[0] || null;
}
export function validatePlan(raw, profile) {
    if (!object(raw)) fail('INVALID_PLAN');
    const plan = {};
    for (const key of ['title','scene','conflict','goal','hook','dilemma','question','resolution']) {
        plan[key]=text(raw[key],key==='title'?100:1600);
        if (!plan[key]) fail('INVALID_PLAN','事件缺少字段：'+key);
    }
    if (raw.targetRank !== profile.rank+1 || raw.targetRank>rankPolicy(profile).rankCount) fail('INVALID_RANK');
    plan.targetRank=raw.targetRank;
    plan.rounds=raw.rounds===2?2:3;
    const expected=profile.history.map(h=>h.eventId);
    if (!Array.isArray(raw.usedHistory) || JSON.stringify(raw.usedHistory)!==JSON.stringify(expected)) fail('HISTORY_MISSING','事件未引用完整有效历阶摘要');
    plan.usedHistory=expected;
    plan.references=lines(raw.references);
    if (Array.isArray(raw.conflicts) && raw.conflicts.length) fail('CONTINUITY_CONFLICT',lines(raw.conflicts).join('；'));
    if (!object(raw.seeds)) fail('INVALID_SEEDS');
    plan.seeds={};
    for (const key of ['persona','desire','shadow','friction']) {
        plan.seeds[key]=text(raw.seeds[key],600);
        if (!plan.seeds[key]) fail('INVALID_SEEDS','角色种子缺少 '+key);
        if (profile.seeds && plan.seeds[key]!==profile.seeds[key]) fail('CONTINUITY_CONFLICT','不可替换已经固定的角色种子：'+key);
    }
    return plan;
}
export function adoptPlan(state, input,{replay=false}={}) {
    const p=profileOf(state,input.characterId);
    if (p.mode!=='coop') fail('NOT_MANAGED');
    if (!p.lock || p.lock.id!==input.gateId) fail('INVALID_GATE');
    const owner=unfinishedEvent(state);
    if (activeEvent(state) || !replay && owner && owner.characterId!==p.id) fail('SCENE_BUSY','当前 Rank 事件尚未结束，其他角色的事件需要排队');
    const plan=validatePlan(input.plan,p);
    const eventId=id(input.eventId);
    if (own(p.events,eventId)) fail('ALREADY_COMMITTED');
    if (Object.values(p.events).some(e=>e.phase!=='completed' && (!replay || e.gateId===p.lock.id))) fail('EVENT_EXISTS','该阶已有未完成事件，请继续原事件');
    p.seeds=p.seeds || clone(plan.seeds);
    p.events[eventId]={id:eventId,characterId:p.id,gateId:p.lock.id,targetRank:p.rank+1,plan,
        ...(input.createdAt?{createdAt:clone(input.createdAt)}:{}),
        phase:'hook',paused:false,version:1,playedUsers:[],questionSource:null,initialAnswerSource:null,answerSource:null,
        route:null,historyIds:p.history.map(h=>h.eventId),historySignature:input.historySignature || historySignature(p),progress:[]};
    state.activeEventId=eventId; p.revision++;
    return p.events[eventId];
}
export function eventOf(state, characterId, eventId) {
    const p=profileOf(state,characterId), e=p.events[eventId];
    if (!e || (!p.lock || e.gateId!==p.lock.id) && !state.mvuAuthority || e.phase==='completed') fail('STALE_EVENT');
    return {p,e};
}
export function pauseEvent(state,characterId,eventId) {
    const {p,e}=eventOf(state,characterId,eventId); e.paused=true; e.version++; p.revision++;
    if (state.activeEventId===e.id) state.activeEventId=null;
}
export function resumeEvent(state,characterId,eventId,{replay=false}={}) {
    const {p,e}=eventOf(state,characterId,eventId);
    if(p.mode!=='coop') fail('NOT_MANAGED');
    if(e.historySignature!==historySignature(p)) fail('HISTORY_CHANGED','历阶摘要已修正，请先重设尚未演出的部分');
    if(activeEvent(state) && state.activeEventId!==e.id) fail('SCENE_BUSY');
    if(!replay && unfinishedEvent(state)?.id!==e.id) fail('SCENE_BUSY','请先完成队列中较早的 Rank 事件');
    e.paused=false; e.version++; state.activeEventId=e.id; p.revision++;
}
export function replanEvent(state,input,{replay=false}={}) {
    const {p,e}=eventOf(state,input.characterId,input.eventId);
    if(!e.paused || p.mode!=='coop') fail('NOT_PAUSED');
    if(!replay && unfinishedEvent(state)?.id!==e.id) fail('SCENE_BUSY','请先完成队列中较早的 Rank 事件');
    const plan=validatePlan(input.plan,p);
    if(e.progress.length) for(const key of ['title','scene','conflict','goal','hook','rounds']) plan[key]=e.plan[key];
    if(e.questionSource) for(const key of ['dilemma','question']) plan[key]=e.plan[key];
    e.plan=plan;e.historySignature=input.historySignature || historySignature(p);e.version++;p.revision++;
}
export function acceptAnswer(state,input,{replay=false}={}) {
    const {p,e}=eventOf(state,input.characterId,input.eventId);
    if (e.paused || !['waiting_user','waiting_route','resolution'].includes(e.phase) || !input.source?.isUser ||
        input.source.index<=e.questionSource?.index || !replay && !text(input.source.body)) fail('WAITING_USER');
    e.initialAnswerSource=e.initialAnswerSource || clone(input.source);
    e.answerSource=clone(input.source);
    e.phase=e.targetRank===rankPolicy(p).relationshipRank && !e.route ? 'waiting_route':'resolution'; e.version++; p.revision++;
}
export function chooseRoute(state,input) {
    const {p,e}=eventOf(state,input.characterId,input.eventId);
    if (e.targetRank!==rankPolicy(p).relationshipRank || !['waiting_route','resolution'].includes(e.phase) || !e.answerSource || !['friendship','romance'].includes(input.route)) fail('INVALID_ROUTE');
    e.route=input.route; e.routeSource=clone(e.answerSource); e.phase='resolution'; e.version++; p.revision++;
}
export function acceptBeat(state,input,{replay=false}={}) {
    const {p,e}=eventOf(state,input.characterId,input.eventId), s=input.source;
    if(p.mode!=='coop' || e.paused || state.activeEventId!==e.id) fail('NOT_ACTIVE');
    if(e.version!==input.eventVersion || input.phase!==e.phase) fail('STALE_EVENT');
    if(!s || s.isUser || !s.userId || !replay && !hasEvidence(s.body,text(input.evidence))) fail('INVALID_EVIDENCE');
    if(e.playedUsers.includes(s.userId)) fail('WAITING_USER','同一用户互动只能完成一个演出阶段');
    if(input.routeConflict===true) {
        if(e.phase!=='resolution' || e.targetRank!==rankPolicy(p).relationshipRank || !e.route ||
            s.userId!==e.answerSource?.id || (s.userVersion && s.userVersion!==e.answerSource.version) ||
            e.answerSource.id===e.routeSource?.id && e.answerSource.version===e.routeSource.version) fail('INVALID_ROUTE');
        if(!replay && !hasEvidence(e.answerSource.body,text(input.userEvidence))) fail('INVALID_EVIDENCE');
        e.route=null;e.routeSource=null;e.phase='waiting_route';e.version++;p.revision++;
        return e;
    }
    if(e.phase==='resolution') return completeEvent(state,input,{replay});
    if(!['hook','dilemma'].includes(e.phase)) fail('WAITING_USER');
    e.playedUsers.push(s.userId); e.progress.push({phase:e.phase,evidence:text(input.evidence,500),source:clone(s)});
    if(e.phase==='hook' && e.plan.rounds!==2) e.phase='dilemma';
    else {e.phase='waiting_user'; e.questionSource=clone(s);}
    e.version++; p.revision++;
    return e;
}
export function completeEvent(state,input,{replay=false}={}) {
    const {p,e}=eventOf(state,input.characterId,input.eventId), report=input.completion, s=input.source;
    if(e.phase!=='resolution' || !e.answerSource || s.userIndex<=e.questionSource.index) fail('WAITING_USER');
    if(s.userId!==e.answerSource.id || (s.userVersion && e.answerSource.version && s.userVersion!==e.answerSource.version)) fail('STALE_SOURCE');
    if(e.targetRank!==p.rank+1 || e.targetRank>p.rankCount) fail('INVALID_RANK');
    if(e.targetRank===rankPolicy(p).relationshipRank && !e.route) fail('WAITING_ROUTE');
    if(!object(report)) fail('SUMMARY_MISSING');
    if(input.requireSceneClosure && !replay) {
        const scene=report.scene;
        if(!object(scene) || scene.goalAchieved!==true || scene.closed!==true || scene.awaitingUser!==false ||
            !Array.isArray(scene.blockingConflicts) || scene.blockingConflicts.length || !hasEvidence(s.body,text(scene.evidence))) {
            fail('NOT_COMPLETE','本阶目标或现场危机尚未收束；继续当前事件，其他 Rank 事件保持排队');
        }
    }
    const outcome=text(report.outcome,600), choice=text(report.choice,600);
    const choiceSources=e.targetRank===rankPolicy(p).relationshipRank?[e.routeSource]:[e.initialAnswerSource,e.answerSource];
    if(!outcome || !choice || !replay && (!hasEvidence(s.body,text(report.outcomeEvidence)) ||
        !choiceSources.some(source=>hasEvidence(source?.body,text(report.choiceEvidence))))) fail('INVALID_EVIDENCE');
    let summary=text(report.summary,1200);
    const traits=lines(report.traits), facts=lines(report.facts), boundaries=lines(report.boundaries);
    const openHooks=lines(report.openHooks), closedHooks=lines(report.closedHooks);
    if(!traits.length && !facts.length && !boundaries.length) fail('GROWTH_MISSING');
    if(!summary) summary='经过：'+outcome+'；用户回应：'+choice+'；人物变化：'+[...traits,...facts,...boundaries].join('；')+
        (openHooks.length?'；尚待处理：'+openHooks.join('；'):'');
    if(summary.length<20) fail('SUMMARY_MISSING');
    if(Array.isArray(report.conflicts) && report.conflicts.length) fail('CONTINUITY_CONFLICT');
    const shared=[];
    for(const item of (Array.isArray(report.sharedFacts)?report.sharedFacts:[]).slice(0,12)) {
        if(!object(item) || !text(item.entityId) || !text(item.fact) || !replay && !hasEvidence(s.body,text(item.evidence))) fail('INVALID_EVIDENCE');
        const key=id(item.entityId), old=state.sharedFacts[key];
        if(old && old.fact!==text(item.fact,600) && item.previousFact!==old.fact) fail('CONTINUITY_CONFLICT','共享实体状态发生冲突：'+key);
        shared.push({entityId:key,name:text(item.name,120),fact:text(item.fact,600),knownBy:lines(item.knownBy,30),
            source:clone(s),rank:e.targetRank,characterId:p.id});
    }
    const history={rank:e.targetRank,eventId:e.id,summary,summaryVersion:1,outcome,choice,traits,facts,boundaries,openHooks,closedHooks,
        ...(e.createdAt?{createdAt:clone(e.createdAt)}:{}),
        route:e.route || p.route,source:clone(s),initialAnswerSource:clone(e.initialAnswerSource || e.answerSource),
        answerSource:clone(e.answerSource),sharedFacts:shared};
    if(p.history.some(h=>h.rank===e.targetRank || h.eventId===e.id)) fail('ALREADY_COMMITTED');
    p.history.push(history); p.rank=e.targetRank; p.lock=null;
    if(e.route) p.route=e.route;
    p.traits=lines([...p.traits,...traits],80); p.facts=lines([...p.facts,...facts],100);
    p.boundaries=lines([...p.boundaries,...boundaries],60);
    p.openHooks=lines([...p.openHooks.filter(h=>!closedHooks.includes(h)),...openHooks],50);
    e.phase='completed'; e.version++; e.progress.push({phase:'resolution',source:clone(s)});
    shared.forEach(item=>{state.sharedFacts[item.entityId]=item;});
    state.activeEventId=null; state.historyRevision++; p.revision++;
    return history;
}
export function assertState(state) {
    let active=0;
    for(const p of Object.values(state.profiles)) {
        const policy=rankPolicy(p);
        integer(p.affinity,0,100); integer(p.rank,0,policy.rankCount); thresholds(p.thresholds,policy.rankCount);
        if(p.history.length!==p.rank || p.history.some((h,i)=>h.rank!==i+1 || !h.summary)) fail('HISTORY_MISSING');
        if(p.lock && (p.affinity!==p.lock.lockedValue || p.lock.targetRank!==p.rank+1)) fail('INVALID_GATE');
        for(const e of Object.values(p.events)) {
            integer(e.targetRank,1,policy.rankCount);
            if(!PHASES.includes(e.phase)) fail('INVALID_PHASE');
            if(!e.paused && e.phase!=='completed') {
                active++;
                if(e.id!==state.activeEventId) fail('INVALID_ACTIVE_EVENT');
            }
        }
    }
    if(state.activeEventId?active!==1:active!==0) fail('INVALID_ACTIVE_EVENT');
    return true;
}
