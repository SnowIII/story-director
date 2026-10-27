import {object,clone,fail,rankPolicy,gateFor} from './model.js';
const mvuAdapters=new WeakMap();
/** MVU 的变量表由酒馆助手持有；部分安装方式不会把 Mvu 接口挂到主窗口。 */
export function mvuApiFor(hostWindow=globalThis.window) {
    if(typeof hostWindow?.Mvu?.getMvuData==='function' && typeof hostWindow.Mvu.replaceMvuData==='function') return hostWindow.Mvu;
    const helper=hostWindow?.TavernHelper;
    if(typeof helper?.getVariables!=='function' || typeof helper.replaceVariables!=='function') return null;
    if(!mvuAdapters.has(helper)) mvuAdapters.set(helper,{
        getMvuData:options=>helper.getVariables(options),
        replaceMvuData:async(data,options)=>helper.replaceVariables(data,options),
    });
    return mvuAdapters.get(helper);
}
export function unwrap(value) {
    if(Array.isArray(value) && (value.length===1 || value.length===2 && typeof value[1]==='string')) return unwrap(value[0]);
    return value;
}
function capAffinity(value) {
    return typeof value==='number' && value>100?100:value;
}
function ensureWrappedObject(parent,key) {
    let value=parent[key];
    while(Array.isArray(value) && (value.length===1 || value.length===2 && typeof value[1]==='string')) {
        parent=value;key=0;value=value[0];
    }
    if(value==null) parent[key]={};
    return parent[key];
}
// 保留 MVU 的说明数组与元数据，只替换 Coop 拥有的镜像字段。
function mirrorValue(previous,value) {
    if(Array.isArray(previous) && (previous.length===1 || previous.length===2 && typeof previous[1]==='string')) {
        return [mirrorValue(previous[0],value),...previous.slice(1)];
    }
    if(object(previous) && object(value)) {
        const entries=Object.entries(value).map(([key,item])=>
            [key,mirrorValue(Object.hasOwn(previous,key)?previous[key]:undefined,item)]);
        if(Object.hasOwn(previous,'$meta')) entries.push(['$meta',previous.$meta]);
        return Object.fromEntries(entries);
    }
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
export function mvuCharacterKeys(state) {
    const profiles=Object.values(state.profiles),reserved=new Set(profiles.map(p=>p.name || '未命名角色')),used=new Set(['$meta']);
    return new Map(profiles.map(p=>{
        const name=p.name || '未命名角色';
        let key=name,suffix=2;
        while(used.has(key) || key!==name && reserved.has(key)) key=name+'_'+suffix++;
        used.add(key);
        return [p.id,key];
    }));
}
function roleTable(variables) {
    return unwrap(unwrap(unwrap(variables?.stat_data?.故事导演)?.Coop)?.角色);
}
function roleRow(roles,key,id) {
    if(!object(roles)) return null;
    if(typeof key==='string' && Object.hasOwn(roles,key)) {
        const row=unwrap(roles[key]);
        const rowId=unwrap(row?.角色ID);
        if(!object(row) || typeof rowId!=='string' || !rowId || rowId===id) return row;
    }
    return Object.entries(roles).filter(([name])=>name!=='$meta').map(([,row])=>unwrap(row))
        .find(row=>unwrap(row?.角色ID)===id) || null;
}
function capLiveAffinities(variables,state) {
    const roles=roleTable(variables),keys=mvuCharacterKeys(state);
    let changed=false;
    for(const p of Object.values(state.profiles)) {
        const row=roleRow(roles,keys.get(p.id),p.id),value=unwrap(row?.好感度);
        if(typeof value==='number' && value>100) {
            row.好感度=mirrorValue(row.好感度,100);changed=true;
        }
    }
    return changed;
}
export function readMvuAffinity(host,state,{live=null,previous=null}={}) {
    let roles=roleTable(live);
    const api=host.mvu?.();
    if(!object(roles) && api?.getMvuData) {
        for(let index=host.messages().length-1;index>=-1;index--) {
            try {roles=roleTable(api.getMvuData(index<0?{type:'chat'}:{type:'message',message_id:index}));} catch {continue;}
            if(object(roles)) break;
        }
    }
    const keys=mvuCharacterKeys(state),oldKeys=previous?mvuCharacterKeys(previous):new Map();
    for(const p of Object.values(state.profiles)) {
        const row=roleRow(roles,keys.get(p.id),p.id) || roleRow(roles,oldKeys.get(p.id),p.id);
        p.mvuReady=false;p.mvuError='';p.scoreLog=[];
        if(!row) continue;
        const value=capAffinity(unwrap(row.好感度)),locked=unwrap(row.好感锁定);
        if(!Number.isInteger(value) || value<0 || value>100 || typeof locked!=='boolean') {
            p.mvuError='MVU 好感度须为 0～100 的整数，好感锁定须为布尔值。';continue;
        }
        p.affinity=value;p.mvuReady=true;
        const unfinished=Object.values(p.events).find(event=>event.phase!=='completed');
        p.lock=locked?{...gateFor(p,'mvu'),...(unfinished?{id:unfinished.gateId}:{}),lockedValue:value}:null;
        p.unlockAfterArchive=locked && !unfinished && p.rank>0 && (p.rank===p.rankCount || value<p.thresholds[p.rank]);
    }
    return state;
}
export function mergeCoopMvu(variables,state,{authority=false}={}) {
    if(!state || !object(variables?.stat_data)) return false;
    const keys=mvuCharacterKeys(state);
    let profiles=Object.fromEntries(Object.values(state.profiles).map(p=>[keys.get(p.id),
        {名称:p.name,好感度:p.affinity,Rank:p.rank,阶级上限:rankPolicy(p).rankCount,关系确认阶级:rankPolicy(p).relationshipRank,
            好感锁定:!!p.lock,路线:p.route,管理模式:p.mode}]));
    const root=variables.stat_data;
    let ns=unwrap(root['故事导演']),coop=unwrap(ns?.Coop);
    if(!Object.keys(profiles).length && !coop?.角色) return false;
    if(ns!=null && !object(ns) || coop!=null && !object(coop)) fail('INVALID_MVU_NAMESPACE','MVU 的故事导演／Coop 字段不是对象，已停止同步');
    if(authority) for(const p of Object.values(state.profiles)) {
        const row=roleRow(unwrap(coop?.角色),keys.get(p.id),p.id),target=profiles[keys.get(p.id)];
        target.角色ID=p.id;
        // 只在字段缺失时初始化；已有好感超过 100 时封顶，锁定状态归 MVU 所有。
        for(const field of ['好感度','好感锁定']) if(object(row) && Object.hasOwn(row,field)) {
            const value=unwrap(row[field]);
            target[field]=field==='好感度'?capAffinity(value):value;
        }
    }
    profiles=mirrorValue(coop?.角色,profiles);
    if(JSON.stringify(coop?.角色)===JSON.stringify(profiles) && Object.hasOwn(coop,'回报')) return false;
    if(!ns) ns=ensureWrappedObject(root,'故事导演');
    if(!coop) coop=ensureWrappedObject(ns,'Coop');
    if(!Object.hasOwn(coop,'回报')) coop.回报=null;
    coop.角色=profiles;
    return true;
}
export function createMvuSync(host,store,canWrite) {
    let task=null,queued=false;
    const authority=host.affinityAuthority==='mvu';
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
                let failure=null;
                for(const target of targets) {
                    if(!current()) return false;
                    try {
                        const raw=api.getMvuData(target);
                        if(!object(raw?.stat_data)) continue;
                        const data=clone(raw);
                        if(mergeCoopMvu(data,state,{authority})) await api.replaceMvuData(data,target);
                        ready.push(target.type==='message'?'最新楼层':'聊天变量');
                    } catch(error) {failure=failure || error;}
                }
                if(failure) {
                    sync.error=failure;
                    sync.status=ready.length?'已同步至'+ready.join('、')+'；部分同步失败，可重试':'同步失败，可重试';
                    return false;
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
    sync.capLive=variables=>allowed() && authority?capLiveAffinities(variables,store.state):false;
    sync.updateLive=variables=>allowed()?mergeCoopMvu(variables,store.state,{authority}):false;
    return sync;
}
export function bindingCapability(api) {
    const available=!!(api?.getMvuData && api?.replaceMvuData);
    return {available,reason:available?'已连接 MVU；好感度与好感锁定以「故事导演.Coop.角色」中的变量为准，每轮直接更新。':
        '尚未检测到 MVU 读写接口；等待 MVU 就绪后读取好感度与锁定状态。'};
}
