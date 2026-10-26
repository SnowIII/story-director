import {clone,fail,id,text,hash,thresholds,MODES,activeEvent,rankPolicy} from './model.js';
import {parseAliases,assertIdentityAvailable} from './identity.js';
export function configureRoster(document,state,input) {
    const characterId=id(input.id), mode=input.mode;
    if(!MODES.includes(mode) || !text(input.name,100)) fail('INVALID_CHARACTER');
    const previous=document.roster[characterId], p=state.profiles[characterId];
    const count=previous?rankPolicy(previous).rankCount:rankPolicy(input.rankCount).rankCount;
    if(previous && input.rankCount!==undefined && input.rankCount!==count) fail('RANK_SYSTEM_LOCKED','角色建档后的阶级方案不可更改');
    const config=previous?clone(previous):{id:characterId,initialAffinity:0,thresholds:thresholds(input.thresholds,count)};
    if(input.thresholds!==undefined) thresholds(input.thresholds,count);
    if(!previous && input.initialAffinity!==undefined) {
        if(!Number.isInteger(input.initialAffinity) || input.initialAffinity<0 || input.initialAffinity>100) fail('INVALID_NUMBER');
        config.initialAffinity=input.initialAffinity;
    }
    if(mode==='coop' && (!p || !p.lock) && (p?.affinity ?? config.initialAffinity)>config.thresholds[p?.rank ?? 0] && !input.acceptCap) {
        fail('CAP_CONFIRMATION','启用 Coop 会将好感封顶到下一阶门槛，溢出不补发；请确认后再启用');
    }
    Object.assign(config,{name:text(input.name,100),description:text(input.description ?? config.description,12000),
        cardRef:text(input.cardRef ?? config.cardRef,200),rankCount:count,mode,policyRevision:(previous?.policyRevision || 0)+1});
    config.aliases=parseAliases(input.aliases ?? config.aliases ?? [],config.name);
    assertIdentityAvailable(config,document.roster);
    document.roster[characterId]=config;
    return {config, eventToPause:mode!=='coop' && activeEvent(state)?.characterId===characterId?activeEvent(state):null};
}
export function candidates(context) {
    const cards=context.characters || [];
    const grouped=context.groupId!==undefined && context.groupId!==null && String(context.groupId)!=='';
    const group=grouped ? (context.groups || []).find(g=>String(g.id)===String(context.groupId)):null;
    if(grouped && !group) return [];
    const selected=context.characterId;
    if(!grouped && (selected===undefined || selected===null || selected==='')) return [];
    const result=[];
    cards.forEach((card,index)=>{
        if(group && !(group.members || []).includes(card.avatar)) return;
        if(!group && index!==Number(selected)) return;
        const ref=text(card.avatar,200);
        if(!ref) return;
        result.push({id:'card:'+hash(ref),name:text(card.name || card.data?.name,100),cardRef:ref,description:''});
    });
    return result;
}
