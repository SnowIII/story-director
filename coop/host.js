import {clone,fail,text} from './model.js';
import {STORAGE_KEY} from './store.js';
import {visibleBody} from './messages.js';
import {stripScriptChunks} from '../model.js';
import {mentionsProfile} from './identity.js';
import {mvuApiFor} from './mvu.js';
export function hostContext() { return globalThis.SillyTavern?.getContext?.() || globalThis.window?.SillyTavern?.getContext?.() || {}; }
export function contextScope(ctx=hostContext()) {
    const chatId=ctx.getCurrentChatId?.() || ctx.chatId;
    const card=(ctx.characters || [])[ctx.characterId];
    if(!chatId || (!ctx.groupId && !card?.avatar)) return '';
    return JSON.stringify([ctx.groupId?'group':'card',ctx.groupId || card.avatar,String(chatId)]);
}
export function createHost(hooks={}) {
    return {
        affinityAuthority:'mvu',
        context:hostContext,
        scope:()=>contextScope(),
        metadata:()=>hostContext().chatMetadata,
        messages:()=>hostContext().chat || [],
        mvu:()=>mvuApiFor(),
        reload:()=>hostContext().reloadCurrentChat?.(),
        async persist(document,scope) {
            const ctx=hostContext();
            if(contextScope(ctx)!==scope || !ctx.chatMetadata || !ctx.getRequestHeaders) fail('STALE_SCOPE');
            const previous=ctx.chatMetadata[STORAGE_KEY], metadata=ctx.chatMetadata;
            metadata[STORAGE_KEY]=clone(document);
            const header={chat_metadata:clone(metadata),user_name:'unused',character_name:'unused'};
            const chat=[header,...clone(ctx.chat || [])];
            const card=ctx.characters?.[ctx.characterId];
            const body=ctx.groupId?{id:ctx.chatId,chat,force:false}:
                {ch_name:card.name,file_name:ctx.chatId || ctx.getCurrentChatId(),avatar_url:card.avatar,chat,force:false};
            try {
                const response=await fetch(ctx.groupId?'/api/chats/group/save':'/api/chats/save',{
                    method:'POST',headers:ctx.getRequestHeaders(),body:JSON.stringify(body)});
                if(!response.ok) fail('SAVE_PENDING','聊天保存失败（HTTP '+response.status+'），进度尚未确认');
                const result=await response.json();
                if(result?.error) fail('SAVE_PENDING','服务器拒绝保存：'+String(result.error));
            } catch(error) {
                if(metadata[STORAGE_KEY]?.revision===document.revision) {
                    if(previous===undefined) delete metadata[STORAGE_KEY];else metadata[STORAGE_KEY]=previous;
                }
                throw error;
            }
        },
        async contextText(profile) {
            const ctx=hostContext(), api=globalThis.window?.StoryOracleAPI?.context;
            const card=(ctx.characters || []).find(c=>c.avatar===profile.cardRef);
            const group=ctx.groupId?(ctx.groups || []).find(g=>String(g.id)===String(ctx.groupId)):null;
            const cards=card?[card]:group?(ctx.characters || []).filter(c=>(group.members || []).includes(c.avatar)):
                [ctx.characters?.[ctx.characterId]].filter(Boolean);
            const cardText=cards.map(c=>'【角色卡／故事背景：'+String(c.name || c.data?.name || '')+'】\n'+
                [...new Set([c.description,c.data?.description,c.personality,c.data?.personality,c.scenario,c.data?.scenario]
                    .filter(v=>typeof v==='string' && v.trim()))].join('\n\n')).join('\n\n');
            let world='';
            if(typeof api?.buildWorldInfo==='function') {
                const result=await api.buildWorldInfo({forceMode:'char',excludeBooks:['故事导演'],extraScanText:[profile.name,...(profile.aliases || [])].join(' ')});
                world=typeof result==='string'?result:JSON.stringify(result || '');
                world=stripScriptChunks(world).text;
            }
            const transcript=(ctx.chat || []).slice(-24).filter(m=>!m.is_system).map(m=>
                (m.is_user?'用户':m.name || '角色')+'：'+visibleBody(m.mes)).join('\n');
            return ['自动读取的角色卡／故事背景：'+text(cardText,18000),
                '相关世界书：'+text(world,18000),'近期真实对话：'+transcript.trim().slice(-16000)].join('\n\n');
        },
        available(profile,profiles=[profile]) {
            const ctx=hostContext(), group=ctx.groupId?(ctx.groups || []).find(g=>String(g.id)===String(ctx.groupId)):null;
            if(profile.cardRef && (group?.members?.includes(profile.cardRef) || ctx.characters?.[ctx.characterId]?.avatar===profile.cardRef)) return true;
            return (ctx.chat || []).slice(-10).some(m=>!m.is_system &&
                (mentionsProfile(profile,m.name,profiles) || mentionsProfile(profile,visibleBody(m.mes),profiles)));
        },
        ...hooks
    };
}
