import {rankPolicy,hash} from './model.js';
import {BLUEPRINTS_BY_RANK} from './blueprints.js';
import {EVENT_FORM_GUIDE} from './event-forms.js';
import {preservePromptEntries} from '../prompt-worldbook.js';

export const COOP_RANK_PROMPTS=Object.fromEntries([4,7,10].map(count=>[count,{
    name:'Coop · '+count+' 阶蓝图',marker:'[coop_rank_'+count+']',
    content:BLUEPRINTS_BY_RANK[count].map((blueprint,index)=>'## Rank '+(index+1)+'\n'+blueprint).join('\n\n')
}]));
export const COOP_FORM_PROMPTS={name:'Coop · 事件形式素材库',marker:'[coop_forms]',content:EVENT_FORM_GUIDE};
const marker=entry=>String(entry?.comment ?? entry?.name ?? '').match(/\[coop_(forms|rank_(?:4|7|10))\]/i)?.[1]?.toLowerCase();
const rankMarker=entry=>Number(marker(entry)?.match(/^rank_(\d+)$/)?.[1]);
const enabled=entry=>typeof entry?.disable==='boolean'?!entry.disable:entry?.enabled===true;
const legacyDefaults={rank_4:'1n17raf',rank_7:'hja6vr',rank_10:'9edu5z',forms:'1jymrt9'};

// 只开放事件形式素材库和已锁定方案的当前阶蓝图；通用规则与程序契约仍由代码维护。
export function designTemplates(entries,profile) {
    const policy=rankPolicy(profile),targetRank=profile.rank+1;
    if(!Number.isInteger(targetRank) || targetRank<1 || targetRank>policy.rankCount) return {};
    const list=entries || [],result={},values={rankCount:policy.rankCount,relationshipRank:policy.relationshipRank,thresholds:policy.thresholds.join('、'),targetRank};
    const expand=value=>value.replace(/\{\{coop\.(rankCount|relationshipRank|thresholds|targetRank)\}\}/g,(_all,key)=>String(values[key]));
    const formEntry=list.find(entry=>marker(entry)==='forms' && enabled(entry)
        && typeof entry.content==='string' && entry.content.trim());
    if(formEntry) result.forms=expand(formEntry.content.trim());
    const selected=list.find(entry=>rankMarker(entry)===policy.rankCount && enabled(entry)
        && typeof entry.content==='string' && entry.content.trim());
    if(!selected) return result;
    const flow=selected.content.trim(),sections=[...flow.matchAll(/^#{1,6}[ \t]*Rank[ \t]*(\d+)\b[^\r\n]*$/gim)];
    let blueprint=flow;
    if(sections.length) {
        const current=sections.filter(section=>Number(section[1])===targetRank);
        if(current.length!==1) return result;
        const section=current[0],index=sections.indexOf(section);
        const body=flow.slice(section.index+section[0].length,sections[index+1]?.index).trim();
        if(!body) return result;
        blueprint=[flow.slice(0,sections[0].index).trim(),body].filter(Boolean).join('\n');
    }
    result.blueprint=expand(blueprint);
    return result;
}

// 仅恢复事件形式素材库与三套阶级蓝图的自定义和开关；不带回旧通用规则或整段提示词。
export function preserveDesignTemplates(bundled,installed) {
    for(const entry of Object.values(bundled.entries || {})) {
        const key=marker(entry);
        if(key!=='forms' && !Object.hasOwn(COOP_RANK_PROMPTS,rankMarker(entry))) continue;
        const previous=installed.find(item=>marker(item)===key);
        if(typeof previous?.content!=='string') continue;
        if(hash(previous.content.trim())!==(previous.sdCoopDefaultHash ?? legacyDefaults[key])) entry.content=previous.content;
        entry.enabled=enabled(previous);entry.disable=!entry.enabled;
    }
    return preservePromptEntries(bundled,installed);
}
