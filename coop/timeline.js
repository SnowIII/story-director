import {SCHEMA,MODES,clone,fail,hash,object,thresholds,id,initialState,applyAffinity,activateGate,adoptPlan,pauseEvent,resumeEvent,
    acceptAnswer,chooseRoute,acceptBeat,replanEvent,assertState,activeEvent} from './model.js';
import {matchesSourceVersion} from './messages.js';
export function newDocument(scope) {
    return {schemaVersion:SCHEMA,scope,revision:0,roster:{},journal:[],settings:{autoStart:false,eventRounds:3},updatedAt:null};
}
export function readDocument(raw,scope) {
    if(!raw) return newDocument(scope);
    if(!object(raw) || ![1,SCHEMA].includes(raw.schemaVersion) || !object(raw.roster) || !Array.isArray(raw.journal)) fail('UNSUPPORTED_SCHEMA','Coop 存档版本不兼容，保留原档并停止写入');
    const document=clone(raw);
    if(document.schemaVersion===1) {
        if(document.journal.length) fail('LEGACY_PROGRESS','此聊天已有十阶旧版进度，原档已保留。请先导出旧档并迁移，不能直接按四阶重算');
        for(const config of Object.values(document.roster)) {
            if(!object(config)) fail('INVALID_DOCUMENT');
            config.thresholds=thresholds();
            config.policyRevision=(config.policyRevision || 1)+1;
        }
        document.schemaVersion=SCHEMA;
    }
    for(const [key,config] of Object.entries(document.roster)) {
        if(!object(config) || id(config.id)!==key || !MODES.includes(config.mode)) fail('INVALID_DOCUMENT','角色管理档案结构不完整');
        thresholds(config.thresholds);
    }
    document.scope=scope;
    document.settings={autoStart:false,eventRounds:3,...document.settings};
    return document;
}
export function validRefs(refs,sources) {
    return (refs || []).every(ref=>matchesSourceVersion(sources.get(ref.id),ref.version));
}
export function roleSignature(state,characterId) {
    const p=state.profiles[characterId];
    if(!p) return '';
    return hash(JSON.stringify({rank:p.rank,affinity:p.affinity,lock:p.lock,
        history:p.history.map(h=>h.eventId),events:Object.values(p.events).map(e=>[e.id,e.version,e.phase,e.paused])}));
}
function operationDependencies(state,op) {
    const p=state.profiles[op.characterId],e=p?.events[op.data?.eventId];
    const sourceRef=source=>source?{id:source.id,version:source.version}:null;
    // Recheck thresholds in the model; unrelated totals and events are not prerequisites.
    return {rank:p?.rank,route:p?.route,gate:p?.lock?clone(p.lock):null,history:p?.history.map(h=>h.eventId) || [],
        event:e?hash(JSON.stringify({id:e.id,version:e.version,phase:e.phase,paused:e.paused,plan:e.plan,
            history:e.historySignature,progress:e.progress.map(step=>[step.phase,sourceRef(step.source)]),
            question:sourceRef(e.questionSource),initialAnswer:sourceRef(e.initialAnswerSource),
            answer:sourceRef(e.answerSource),route:e.route,routeSource:sourceRef(e.routeSource)})):null};
}
export function applyOperation(state,op) {
    const p=state.profiles[op.characterId], oldMode=p?.mode;
    if(p && op.mode) p.mode=op.mode;
    let result;
    try {
        switch(op.kind) {
            case 'affinity':result=applyAffinity(state,op.data);break;
            case 'activate':result=activateGate(state,op.characterId,op.id,op.data.thresholds);break;
            case 'plan':result=adoptPlan(state,{...op.data,characterId:op.characterId});break;
            case 'replan':result=replanEvent(state,{...op.data,characterId:op.characterId});break;
            case 'pause':result=pauseEvent(state,op.characterId,op.data.eventId);break;
            case 'resume':result=resumeEvent(state,op.characterId,op.data.eventId);break;
            case 'answer':result=acceptAnswer(state,{...op.data,characterId:op.characterId});break;
            case 'route':result=chooseRoute(state,{...op.data,characterId:op.characterId});break;
            case 'beat':result=acceptBeat(state,{...op.data,characterId:op.characterId});break;
            default:fail('INVALID_OPERATION');
        }
    } finally { if(p) p.mode=oldMode; }
    state.applied.push(op.id);
    return result;
}
export function project(document,sources) {
    const state=initialState(document.roster), skipped=[];
    const ids=new Set(), priorCompletions=new Set();
    for(const op of document.journal) {
        if(ids.has(op.id)) continue;
        ids.add(op.id);
        const hadCompletion=priorCompletions.has(op.characterId);
        if(op.kind==='beat' && op.data?.phase==='resolution') priorCompletions.add(op.characterId);
        if(!validRefs(op.refs,sources)) {skipped.push({id:op.id,code:'STALE_SOURCE'});continue;}
        const p=state.profiles[op.characterId];
        const history=p?.history.map(h=>h.eventId) || [];
        // Points depend on their actual interaction and completed arc, not the old total.
        // Legacy hashes can be rebased before any completion; later ambiguous branches stay protected.
        const dependencyValid=op.kind==='affinity' ?
            (op.affinityHistory!==undefined ? Array.isArray(op.affinityHistory) && JSON.stringify(op.affinityHistory)===JSON.stringify(history) :
                !op.precondition || op.precondition===roleSignature(state,op.characterId) || !hadCompletion && !history.length) :
            op.dependencies!==undefined ? JSON.stringify(op.dependencies)===JSON.stringify(operationDependencies(state,op)) :
                !op.precondition || op.precondition===roleSignature(state,op.characterId);
        if(!dependencyValid) {
            skipped.push({id:op.id,code:'STALE_DEPENDENCY'});continue;
        }
        const before=clone(state);
        try {
            const hydrated=clone(op);
            if(hydrated.data?.source?.id) {
                const source=sources.get(hydrated.data.source.id);
                if(matchesSourceVersion(source,hydrated.data.source.version)) hydrated.data.source=clone(source);
            }
            applyOperation(state,hydrated);
            for(const p of Object.values(state.profiles)) for(const h of p.history) {
                const edit=document.summaryEdits?.[h.eventId];
                if(edit && matchesSourceVersion(sources.get(h.source.id),edit.sourceVersion) && typeof edit.summary==='string' && edit.summary.length>=20) {
                    h.summary=edit.summary.slice(0,1200);h.summaryVersion=edit.version;h.manuallyReviewed=true;
                }
            }
            assertState(state);
        }
        catch(error) {Object.assign(state,before);skipped.push({id:op.id,code:error.code || 'INVALID_OPERATION'});}
    }
    for(const [key,p] of Object.entries(state.profiles)) {
        const config=document.roster[key]; p.mode=config.mode;p.policyRevision=config.policyRevision;p.thresholds=clone(config.thresholds);
    }
    const event=activeEvent(state);
    if(event && state.profiles[event.characterId].mode!=='coop') {event.paused=true;state.activeEventId=null;}
    state.skipped=skipped;
    assertState(state);
    return state;
}
export function appendOperation(document,state,op,sources) {
    if(document.journal.some(x=>x.id===op.id)) fail('ALREADY_COMMITTED');
    if(!validRefs(op.refs,sources)) fail('STALE_SOURCE');
    const candidate=clone(state);
    applyOperation(candidate,op);assertState(candidate);
    const durable=clone(op);
    durable.precondition=roleSignature(state,op.characterId);
    if(op.kind==='affinity') durable.affinityHistory=state.profiles[op.characterId].history.map(h=>h.eventId);
    else durable.dependencies=operationDependencies(state,op);
    if(durable.data?.source?.id) durable.data.source={id:durable.data.source.id,version:durable.data.source.version};
    document.journal.push(durable);
    return candidate;
}
