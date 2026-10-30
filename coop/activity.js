import {matchesSourceVersion} from './messages.js';
import {validateAffinityProposal} from './affinity.js';

export function affinityActivity({document,pending,state,sources,messages,outcomes},characterId) {
    const profile=state?.profiles[characterId];
    if(!profile) return [];
    const skipped=new Map((state.skipped || []).map(item=>[item.id,item.code]));
    const labels={NO_REPORT:'未收到本轮好感回报',WAITING_MVU:'等待变量回填',
        INVALID_REQUEST:'回报所属请求无法核对，本轮未计分',INVALID_EVIDENCE:'原文依据不完整，本轮未计分',
        STALE_POLICY:'管理设置已变化，旧回报未采用',STALE_SOURCE:'来源剧情已修改，已撤销',
        STALE_DEPENDENCY:'前置事件已改变，需要核对',SAVE_PENDING:'等待保存确认',INVALID_NUMBER:'回报分数不合法，本轮未计分',
        NOT_PROCESSED:'已有回报，尚未完成结算'};
    const rows=[];
    for(const source of [...sources.values()].filter(s=>!s.isUser && !s.isSystem).slice(-30)) {
        const log=profile.scoreLog.find(item=>item.source.id===source.id);
        const op=document.journal.find(item=>item.kind==='affinity' && item.characterId===characterId && item.data.source?.id===source.id);
        const saved=messages[source.index]?.extra?.sdCoopReports, snapshot=messages[source.index]?.extra?.sdCoopSnapshot;
        const outcome=outcomes.get(source.id+':'+characterId);
        let code='',label='';
        if(pending?.journal.some(item=>item.kind==='affinity' && item.characterId===characterId && item.data.source?.id===source.id)) {
            const committed=document.journal.some(item=>item.kind==='affinity' && item.characterId===characterId && item.data.source?.id===source.id);
            if(!committed) code='SAVE_PENDING';
        }
        if(!code && log) {
            code='APPLIED';
            label=log.reasonCode==='AFFINITY_LOCKED'?'好感锁定，本轮不计分':
                log.requested===0?'正常 0 分':log.actual===0?'已处理，分数保持不变':
                '已入账 '+(log.actual>0?'+':'')+log.actual+'（'+log.before+' → '+log.after+'）';
        } else if(!code && op && skipped.has(op.id)) code=skipped.get(op.id);
        else if(!code && outcome && outcome.version===source.version) code=outcome.code;
        if(!code && matchesSourceVersion(source,saved?.version)) {
            const report=saved.reports?.find(r=>Array.isArray(r.affinity) && r.affinity.some(p=>p.characterId===characterId));
            const proposal=report?.affinity.find(p=>p.characterId===characterId);
            if(proposal) {
                if(snapshot?.nonce!==report.nonce) code='INVALID_REQUEST';
                else try {validateAffinityProposal(proposal,profile,source,snapshot?.roles?.[characterId]);code='NOT_PROCESSED';}
                catch(error) {code=error.code || 'INVALID_EVIDENCE';}
            }
        }
        if(code) rows.push({index:source.index,code,label:label || labels[code] || '本轮未完成结算'});
    }
    return rows.reverse().slice(0,10);
}
