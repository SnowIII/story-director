import {rankPolicy,hash} from './model.js';
import {BLUEPRINTS_BY_RANK} from './blueprints.js';
import {preservePromptEntries} from '../prompt-worldbook.js';

export const COOP_RANK_PROMPTS=Object.fromEntries([4,7,10].map(count=>[count,{
    name:'Coop · '+count+' 阶蓝图',marker:'[coop_rank_'+count+']',
    content:BLUEPRINTS_BY_RANK[count].map((blueprint,index)=>'## Rank '+(index+1)+'\n'+blueprint).join('\n\n')
}]));
const marker=entry=>Number(String(entry?.comment ?? entry?.name ?? '').match(/\[coop_rank_(4|7|10)\]/i)?.[1]);
const enabled=entry=>typeof entry?.disable==='boolean'?!entry.disable:entry?.enabled===true;
const legacyDefaults={4:'1n17raf',7:'hja6vr',10:'9edu5z'};

// 只开放已锁定方案的当前阶蓝图；通用规则、形式库和程序契约仍由代码维护。
export function designTemplates(entries,profile) {
    const policy=rankPolicy(profile),targetRank=profile.rank+1;
    if(!Number.isInteger(targetRank) || targetRank<1 || targetRank>policy.rankCount) return {};
    const selected=(entries || []).find(entry=>marker(entry)===policy.rankCount && enabled(entry)
        && typeof entry.content==='string' && entry.content.trim());
    if(!selected) return {};
    const flow=selected.content.trim(),sections=[...flow.matchAll(/^#{1,6}[ \t]*Rank[ \t]*(\d+)\b[^\r\n]*$/gim)];
    let blueprint=flow;
    if(sections.length) {
        const current=sections.filter(section=>Number(section[1])===targetRank);
        if(current.length!==1) return {};
        const section=current[0],index=sections.indexOf(section);
        const body=flow.slice(section.index+section[0].length,sections[index+1]?.index).trim();
        if(!body) return {};
        blueprint=[flow.slice(0,sections[0].index).trim(),body].filter(Boolean).join('\n');
    }
    const values={rankCount:policy.rankCount,relationshipRank:policy.relationshipRank,thresholds:policy.thresholds.join('、'),targetRank};
    return {blueprint:blueprint.replace(/\{\{coop\.(rankCount|relationshipRank|thresholds|targetRank)\}\}/g,(_all,key)=>String(values[key]))};
}

// 仅恢复三套阶级蓝图的自定义与开关；不带回旧通用规则、形式库或整段提示词。
export function preserveDesignTemplates(bundled,installed) {
    for(const entry of Object.values(bundled.entries || {})) {
        const count=marker(entry);
        if(!Object.hasOwn(COOP_RANK_PROMPTS,count)) continue;
        const previous=installed.find(item=>marker(item)===count);
        if(typeof previous?.content!=='string') continue;
        if(hash(previous.content.trim())!==(previous.sdCoopDefaultHash ?? legacyDefaults[count])) entry.content=previous.content;
        entry.enabled=enabled(previous);entry.disable=!entry.enabled;
    }
    return preservePromptEntries(bundled,installed);
}
