import {hash,object} from './model.js';
export const REPORT_TAG='CoopReport';
export function stripReport(body) {
    return String(body || '').replace(/<CoopReport\b[^>]*>[\s\S]*?<\/CoopReport>/gi,'')
        .replace(/<CoopReport\b[^>]*>[\s\S]*$/gi,'').trim();
}
export function visibleBody(body) {
    return stripReport(body).replace(/<UpdateVariable>[\s\S]*?<\/UpdateVariable>/gi,'')
        .replace(/<story_director_status>[\s\S]*?<\/story_director_status>/gi,'')
        .replace(/<!--\s*故事导演自检[\s\S]*?-->/g,'')
        .replace(/<故事导演(?:自检|审查|审查说明)>[\s\S]*?<\/故事导演(?:自检|审查|审查说明)>/g,'').trim();
}
export function uuid() { return globalThis.crypto?.randomUUID?.() || 'c-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2); }
export function ensureMessageIds(messages) {
    for(const message of messages) if(message && !message.sd_coop_id) message.sd_coop_id=uuid();
}
export function sourceMap(messages) {
    const sources=new Map();let user=null;
    messages.forEach((message,index)=>{
        if(!message || !message.sd_coop_id) return;
        const body=visibleBody(message.mes);
        const source={id:message.sd_coop_id,version:hash(body+'|'+(message.swipe_id ?? 0)+'|'+!!message.is_user),
            index,body,isUser:!!message.is_user,isSystem:!!message.is_system};
        if(source.isUser) user=source;
        if(user) Object.assign(source,{userId:user.id,userVersion:user.version,userIndex:user.index,userBody:user.body});
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
