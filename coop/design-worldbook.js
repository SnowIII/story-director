import {rankPolicy} from './model.js';

const marker=entry=>String(entry?.comment ?? entry?.name ?? '').match(/\[coop_(design|rank_(?:4|7|10))\]/i)?.[1].toLowerCase();
const enabled=entry=>typeof entry?.disable==='boolean'?!entry.disable:entry?.enabled===true;

export function designTemplates(entries,profile) {
    const policy=rankPolicy(profile),find=key=>entries.find(entry=>marker(entry)===key && enabled(entry))?.content?.trim() || '';
    const expand=value=>value.replace(/\{\{coop\.(rankCount|relationshipRank|thresholds)\}\}/g,(_all,key)=>
        key==='thresholds'?policy.thresholds.join('、'):String(policy[key]));
    const flow=find('rank_'+policy.rankCount),sections=[...flow.matchAll(/^##\s+Rank\s+(\d+)\b[^\n]*$/gim)];
    const current=sections.findIndex(section=>Number(section[1])===profile.rank+1);
    const blueprint=sections.length?(current<0?'':flow.slice(0,sections[0].index).trim()+'\n'+
        flow.slice(sections[current].index+sections[current][0].length,sections[current+1]?.index).trim()):flow;
    return {rules:expand(find('design')),blueprint:expand(blueprint).trim()};
}

// 自动升级保留用户的 Coop 设计文本与开关状态。
export function preserveDesignTemplates(bundled,installed) {
    for(const entry of Object.values(bundled.entries || {})) {
        const key=marker(entry),previous=key && installed.find(item=>marker(item)===key);
        if(typeof previous?.content==='string') {
            entry.content=previous.content;entry.enabled=enabled(previous);entry.disable=!entry.enabled;
        }
    }
    return bundled;
}
