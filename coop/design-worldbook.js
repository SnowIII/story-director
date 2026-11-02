import {rankPolicy,hash} from './model.js';

const marker=entry=>String(entry?.comment ?? entry?.name ?? '').match(/\[coop_(design|forms|rank_(?:4|7|10))\]/i)?.[1].toLowerCase();
const enabled=entry=>typeof entry?.disable==='boolean'?!entry.disable:entry?.enabled===true;
// 0.41.0～0.41.4 尚未记录默认文本指纹；只迁移这些未改过的内置模板。
const legacyDefaults={design:'qpbb7b',rank_4:'1n17raf',rank_7:'hja6vr',rank_10:'9edu5z'};

export function designTemplates(entries,profile) {
    const policy=rankPolicy(profile),find=key=>entries.find(entry=>marker(entry)===key && enabled(entry))?.content?.trim() || '';
    const expand=value=>value.replace(/\{\{coop\.(rankCount|relationshipRank|thresholds)\}\}/g,(_all,key)=>
        key==='thresholds'?policy.thresholds.join('、'):String(policy[key]));
    const flow=find('rank_'+policy.rankCount),sections=[...flow.matchAll(/^##\s+Rank\s+(\d+)\b[^\n]*$/gim)];
    const current=sections.findIndex(section=>Number(section[1])===profile.rank+1);
    const blueprint=sections.length?(current<0?'':flow.slice(0,sections[0].index).trim()+'\n'+
        flow.slice(sections[current].index+sections[current][0].length,sections[current+1]?.index).trim()):flow;
    const forms=expand(find('forms'));
    return {rules:expand(find('design')),blueprint:expand(blueprint).trim(),...(forms?{forms}:{})};
}

// 未改过的默认模板随版本升级；自定义文本和所有开关状态保留。
export function preserveDesignTemplates(bundled,installed) {
    for(const entry of Object.values(bundled.entries || {})) {
        const key=marker(entry),previous=key && installed.find(item=>marker(item)===key);
        if(typeof previous?.content==='string') {
            if(hash(previous.content.trim())!==(previous.sdCoopDefaultHash || legacyDefaults[key])) entry.content=previous.content;
            entry.enabled=enabled(previous);entry.disable=!entry.enabled;
        }
    }
    return bundled;
}
