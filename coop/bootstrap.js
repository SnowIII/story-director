import {createHost} from './host.js';
import {CoopRuntime} from './runtime.js';
import {mountCoopUI} from './ui.js';
import {sourceForId} from './messages.js';
export function createCoopSystem(hooks={}) {
    const host=createHost(hooks), runtime=new CoopRuntime(host);
    const ui=mountCoopUI(runtime,{container:hooks.uiContainer,onOpen:hooks.openPanel});
    const ctx=host.context(), events=ctx.eventSource, types=ctx.eventTypes || ctx.event_types || {};
    const on=(name,handler)=>{
        if(!name) return;
        events?.on?.(name,async(...args)=>{try {await handler(...args);}catch(error){runtime.notice(error);}});
    };
    const ready=()=>runtime.store.scope===host.scope()?(runtime.loading || Promise.resolve()):runtime.load();
    on(types.CHAT_CHANGED || 'chat_id_changed',async()=>{await runtime.load();});
    on(types.GENERATION_STARTED || 'generation_started',async(type,options,dryRun)=>{
        if(dryRun || ['quiet','impersonate'].includes(type)) return;
        await ready();
        if(['swipe','regenerate','continue'].includes(type) && runtime.store.document) {
            const index=host.messages().findLastIndex(m=>!m.is_user && !m.is_system);
            const source=sourceForId(host.messages(),index);
            if(source) runtime.store.excluded.set(source.id,source.version);
            runtime.store.reconcile();
        }
    });
    on(types.GENERATION_AFTER_COMMANDS || 'GENERATION_AFTER_COMMANDS',async(type,options,dryRun)=>{
        if(dryRun || ['quiet','impersonate'].includes(type)) return;
        await ready();await runtime.prepare();
    });
    on(types.MESSAGE_SENT || 'message_sent',async()=>{await ready();await runtime.prepare();});
    on(types.CHARACTER_MESSAGE_RENDERED || 'character_message_rendered',async(index,type)=>{
        if(type==='first_message') return;
        await ready();await runtime.afterMessage(index);
    });
    for(const name of [types.MESSAGE_EDITED,types.MESSAGE_SWIPED,types.MESSAGE_SWIPE_DELETED,types.MESSAGE_DELETED].filter(Boolean)) {
        on(name,async()=>{await ready();runtime.store.reconcile();});
    }
    on(types.GENERATION_ENDED || 'generation_ended',async()=>{
        runtime.store.excluded.clear();
        if(runtime.store.document) runtime.store.reconcile();
    });
    const helper=globalThis.window?.TavernHelper;
    const mvuOn=(name,handler)=>{
        on(name,handler);
        if(typeof helper?.eventOn==='function') helper.eventOn(name,async(...args)=>{
            try {await handler(...args);}catch(error){runtime.notice(error);}
        });
    };
    mvuOn('mag_variable_update_ended',async variables=>{await runtime.receiveMvu(variables);void runtime.syncMvu();});
    mvuOn('mag_before_message_update',context=>{runtime.syncMvu.updateLive(context?.variables);});
    for(const name of ['mag_variable_initiailized','mag_variable_initialized']) mvuOn(name,()=>{void runtime.syncMvu();});
    void runtime.load();
    globalThis.window.__storyDirectorCoop={
        open:ui.open,state:()=>runtime.state(),
        diagnostics:()=>({notices:runtime.notices,pending:!!runtime.store.pending,readonly:runtime.store.readonly,mvuError:runtime.syncMvu.error?.message || null}),runtime
    };
    return runtime;
}
