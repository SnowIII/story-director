import {hash,object} from './model.js';
import {visibleBody,fingerprintBody,legacyBodyVariants,updateVariableBlocks,directorReportBlocks,instructionBlocks,instructionSourceVariants} from './body.js';
import {extractNsCommands,parseCommandLiteral} from '../model.js';
export {visibleBody,stripReport} from './body.js';
export const REPORT_TAG='CoopReport';
const sourceCache=new WeakMap();
const legacySourceCache=new WeakMap();
export const matchesSourceVersion=(source,version)=>!!source && (source.version===version || source.versions?.includes(version));
export const matchesUserVersion=(source,version)=>source?.userVersion===version || !!source?.userVersions?.includes(version);
export function uuid() { return globalThis.crypto?.randomUUID?.() || 'c-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2); }
export function ensureMessageIds(messages) {
    for(const message of messages) if(message && !message.sd_coop_id) message.sd_coop_id=uuid();
}
export function sourceMap(messages,{legacyStatus=false}={}) {
    const sources=new Map();let user=null;
    const cache=legacyStatus?legacySourceCache:sourceCache;
    const blocks=[...new Set(messages.filter(message=>message?.is_user).flatMap(message=>instructionBlocks(message.mes)))].slice(-8);
    const instructions=JSON.stringify(blocks);
    messages.forEach((message,index)=>{
        if(!message || !message.sd_coop_id) return;
        const salt='|'+(message.swipe_id ?? 0)+'|'+!!message.is_user;
        let cached=cache.get(message);
        if(!cached || cached.raw!==message.mes || cached.salt!==salt || cached.instructions!==instructions) {
            const options={keepImagePlaceholders:!!message.is_user,keepStatusPlaceholders:legacyStatus};
            const body=visibleBody(message.mes,options), version='v2:'+hash(fingerprintBody(message.mes,options)+salt);
            const variants=message.is_user?instructionSourceVariants(message.mes,blocks):[message.mes];
            cached={raw:message.mes,salt,instructions,body,version,versions:[...new Set([
                'v2:'+hash(fingerprintBody(message.mes,{keepImagePlaceholders:true,keepStatusPlaceholders:legacyStatus})+salt),
                // 旧版曾把状态栏占位符计入指纹；只重建已知显示标记，不信任缓存声称的旧哈希。
                ...(legacyStatus?[]:[message.mes,String(message.mes || '')+'\n<StatusPlaceHolderImpl/>'].flatMap(value=>[false,true].map(keepImagePlaceholders=>
                    'v2:'+hash(fingerprintBody(value,{...options,keepImagePlaceholders:keepImagePlaceholders || options.keepImagePlaceholders,keepStatusPlaceholders:true})+salt)))),
                ...variants.map(value=>'v2:'+hash(fingerprintBody(value,{...options,keepInstructions:true})+salt)),
                ...legacyBodyVariants(message.mes,128,options).map(value=>hash(value+salt))])]};
            cache.set(message,cached);
        }
        const source={id:message.sd_coop_id,version:cached.version,versions:cached.versions,
            index,body:cached.body,isUser:!!message.is_user,isSystem:!!message.is_system};
        if(source.isUser) user=source;
        if(user) Object.assign(source,{userId:user.id,userVersion:user.version,userVersions:user.versions,userIndex:user.index,userBody:user.body});
        sources.set(source.id,source);
    });
    return sources;
}
export const ref=source=>({id:source.id,version:source.version});
export function references(source) {
    const refs=[ref(source)];
    if(source.userId && source.userId!==source.id) refs.push({id:source.userId,version:source.userVersion});
    return refs;
}
export function safeJson(value,maxLength=60000) {
    if(String(value).length>maxLength) throw new Error('数据超出允许长度');
    return JSON.parse(value,(key,item)=>{
        if(['__proto__','constructor','prototype'].includes(key)) throw new Error('非法报告字段');
        return item;
    });
}
export function modelJson(value) {
    let body=String(value || '').trim();
    const tagged=body.match(/<CoopEvent>([\s\S]*?)<\/CoopEvent>/i);
    if(tagged) body=tagged[1].trim();
    const fence=String.fromCharCode(96).repeat(3);
    if(body.startsWith(fence)) body=body.slice(body.indexOf('\n')+1).replace(new RegExp(fence+'\\s*$'),'').trim();
    return safeJson(body);
}
export function parseReports(body,{directorOnly=false}={}) {
    const reports=[];
    const add=value=>{if(object(value) && !reports.some(report=>JSON.stringify(report)===JSON.stringify(value))) reports.push(value);};
    if(directorOnly) {
        for(const block of directorReportBlocks(body)) try {add(safeJson(block.trim()));} catch { /* Only complete data reports outside narrative and analysis are accepted. */ }
        return reports;
    }
    let variableReport=null;
    for(const block of updateVariableBlocks(body)) {
        for(const match of block.matchAll(/<JSONPatch\b[^>]*>([\s\S]*?)<\/JSONPatch\s*>/gi)) {
            try {
                const patches=safeJson(match[1].trim());
                if(!Array.isArray(patches) || patches.length>128) continue;
                for(const patch of patches) if(object(patch) && ['add','replace'].includes(patch.op) &&
                    /^\/(?:stat_data\/)?故事导演\/Coop\/回报$/.test(patch.path) && object(patch.value)) variableReport=patch.value;
            } catch { /* Malformed or unsafe model JSON is never executed. */ }
        }
        for(const command of extractNsCommands(block)) {
            if(command.type!=='set' || command.args.length<2) continue;
            const path=parseCommandLiteral(command.args[0]);
            if(!/^(?:stat_data\.)?故事导演\.Coop\.回报$/.test(String(path))) continue;
            try {const value=safeJson(command.args.at(-1));if(object(value)) variableReport=value;} catch { /* Only strict JSON report objects are accepted. */ }
        }
    }
    // This is one MVU variable: repeated assignments have last-write semantics.
    if(variableReport) return [variableReport];
    // Existing archives and in-flight replies may still contain the old transport.
    for(const match of String(body || '').matchAll(/<CoopReport\b[^>]*>([\s\S]*?)<\/CoopReport>/gi)) {
        try {add(safeJson(match[1].trim()));} catch { /* Never execute model output. */ }
    }
    return reports;
}
export function sourceForId(messages,messageId) {
    const message=messages[messageId];
    return message?.sd_coop_id ? sourceMap(messages).get(message.sd_coop_id):null;
}
