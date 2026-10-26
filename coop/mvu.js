import {object,clone,fail} from './model.js';
export function unwrap(value) {
    if(Array.isArray(value) && (value.length===1 || value.length===2 && typeof value[1]==='string')) return unwrap(value[0]);
    return value;
}
export function extraModel(context) {
    const box=context.extensionSettings?.mvu_settings || context.extension_settings?.mvu_settings || {};
    return /额外模型/.test(String(box['更新方式'] ?? box.updateMode ?? ''));
}
export function readMvuReport(variables) {
    const data=unwrap(unwrap(variables?.stat_data?.['故事导演'])?.Coop);
    const report=unwrap(data?.['回报']);
    return object(report)?report:null;
}
export function isProtectedCoopPath(path) {
    const normalized=String(path || '').replace(/\[['"]?([^'"\]]+)['"]?\]/g,'.$1').replace(/^(stat_data|status_current_variables)\./,'');
    return normalized==='故事导演.Coop' || normalized.startsWith('故事导演.Coop.');
}
export function mergeCoopMvu(variables,state) {
    if(!state || !object(variables?.stat_data)) return false;
    const profiles=Object.fromEntries(Object.values(state.profiles).map(p=>[p.id,
        {名称:p.name,好感度:p.affinity,Rank:p.rank,好感锁定:!!p.lock,路线:p.route,管理模式:p.mode}]));
    const root=variables.stat_data;
    let ns=unwrap(root['故事导演']),coop=unwrap(ns?.Coop);
    if(!Object.keys(profiles).length && !coop?.角色) return false;
    if(ns!=null && !object(ns) || coop!=null && !object(coop)) fail('INVALID_MVU_NAMESPACE','MVU 的故事导演／Coop 字段不是对象，已停止同步');
    if(JSON.stringify(coop?.角色)===JSON.stringify(profiles) && Object.hasOwn(coop,'回报')) return false;
    if(!ns) ns=root['故事导演']={};
    if(!coop) coop=ns.Coop={};
    if(!Object.hasOwn(coop,'回报')) coop.回报=null;
    coop.角色=profiles;
    return true;
}
export function createMvuSync(host,store,canWrite) {
    let task=null,queued=false;
    const allowed=()=>!!store.state && !!store.scope && store.scope===host.scope() && !store.readonly && canWrite();
    const sync=()=>{
        queued=true;
        if(task) return task;
        task=(async()=>{
            while(queued) {
                queued=false;
                const api=host.mvu?.();
                if(!allowed()) {sync.status='等待当前聊天写入权';return false;}
                if(!api?.getMvuData || !api?.replaceMvuData) {sync.status='等待 MVU 就绪';return false;}
                const {scope,generation,state}=store,messages=host.messages(),index=messages.length-1,message=messages[index],swipe=message?.swipe_id;
                const current=()=>allowed() && scope===store.scope && generation===store.generation && host.messages()[index]===message && message?.swipe_id===swipe;
                const targets=[...(message?[{type:'message',message_id:index}]:[]),{type:'chat'}];
                const ready=[];
                for(const target of targets) {
                    if(!current()) return false;
                    const raw=api.getMvuData(target);
                    if(!object(raw?.stat_data)) continue;
                    ready.push(target.type==='message'?'最新楼层':'聊天变量');
                    const data=clone(raw);
                    if(mergeCoopMvu(data,state)) await api.replaceMvuData(data,target);
                }
                sync.error=null;
                sync.status=ready.length?'已同步至'+ready.join('、'):'等待 MVU 初始化变量';
            }
            return true;
        })().catch(error=>{sync.error=error;sync.status='同步失败，可重试';return false;}).finally(()=>{task=null;if(queued) void sync();});
        return task;
    };
    sync.error=null;
    sync.status='尚未同步';
    sync.updateLive=variables=>allowed()?mergeCoopMvu(variables,store.state):false;
    return sync;
}
export function bindingCapability(api) {
    const available=!!(api?.getMvuData && api?.replaceMvuData);
    return {available,reason:available?'已启用 Coop → MVU 同步；好感度、Rank 和锁定状态位于「故事导演.Coop.角色」。计分仍由 Coop 校验。':
        '尚未检测到 MVU 读写接口；Coop 可独立计分，MVU 就绪后自动同步。'};
}
