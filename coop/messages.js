import {hash,object} from './model.js';
import {visibleBody,fingerprintBody,legacyBodyVariants} from './body.js';
export {visibleBody,stripReport} from './body.js';
export const REPORT_TAG='CoopReport';
const sourceCache=new WeakMap();
export const matchesSourceVersion=(source,version)=>!!source && (source.version===version || source.versions?.includes(version));
export const matchesUserVersion=(source,version)=>source?.userVersion===version || !!source?.userVersions?.includes(version);
export function uuid() { return globalThis.crypto?.randomUUID?.() || 'c-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2); }
export function ensureMessageIds(messages) {
    for(const message of messages) if(message && !message.sd_coop_id) message.sd_coop_id=uuid();
}
export function sourceMap(messages) {
    const sources=new Map();let user=null;
    messages.forEach((message,index)=>{
        if(!message || !message.sd_coop_id) return;
        const salt='|'+(message.swipe_id ?? 0)+'|'+!!message.is_user;
        let cached=sourceCache.get(message);
        if(!cached || cached.raw!==message.mes || cached.salt!==salt) {
            const options={keepImagePlaceholders:!!message.is_user};
            const body=visibleBody(message.mes,options), version='v2:'+hash(fingerprintBody(message.mes,options)+salt);
            cached={raw:message.mes,salt,body,version,versions:[...new Set([
                'v2:'+hash(fingerprintBody(message.mes,{keepImagePlaceholders:true})+salt),
                ...legacyBodyVariants(message.mes,128,options).map(value=>hash(value+salt))])]};
            sourceCache.set(message,cached);
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
export function parseReports(body) {
    const reports=[];
    for(const match of String(body || '').matchAll(/<CoopReport\b[^>]*>([\s\S]*?)<\/CoopReport>/gi)) {
        try {const value=safeJson(match[1].trim());if(object(value)) reports.push(value);} catch { /* Never execute model output. */ }
    }
    return reports;
}
export function sourceForId(messages,messageId) {
    const message=messages[messageId];
    return message?.sd_coop_id ? sourceMap(messages).get(message.sd_coop_id):null;
}
