import test from 'node:test';
import assert from 'node:assert/strict';
import {createCoopSystem} from '../coop/bootstrap.js';
import {clone} from '../coop/model.js';
import {setCoopMvuAuthority} from '../model.js';
import {STORAGE_KEY} from '../coop/store.js';

async function fixture(t) {
    const previousWindow=globalThis.window,previousDocument=globalThis.document;
    globalThis.window={};
    // Reuse an existing panel so this fixture exercises real bootstrap events
    // and persistence without making layout part of the lifecycle regression.
    globalThis.document={querySelectorAll:()=>[],getElementById:()=>({hidden:false})};
    const handlers=new Map(),messages=[{is_user:true,mes:'今天有空吗？'},
        {is_user:false,mes:'她在画室里整理画册。'}],metadata={};
    const types=Object.fromEntries(['CHAT_CHANGED','MESSAGE_EDITED','MESSAGE_SWIPED','MESSAGE_SWIPE_DELETED',
        'MESSAGE_DELETED','GENERATION_STARTED','GENERATION_ENDED'].map(name=>[name,name.toLowerCase()]));
    const context={eventTypes:types,eventSource:{on(name,handler){
        handlers.set(name,[...(handlers.get(name) || []),handler]);
    }}};
    let runtime,scope='deletion-lifecycle';
    const host={affinityAuthority:undefined,scope:()=>scope,metadata:()=>metadata,
        messages:()=>messages,context:()=>context,available:()=>true,autoAllowed:()=>false,
        locks:{request:async(name,options,callback)=>callback({name})},
        contextText:async()=>messages.map(message=>message.mes).join('\n'),
        persist:async document=>{metadata[STORAGE_KEY]=clone(document);},
        ask:async()=>JSON.stringify({targetRank:1,title:'旧画册',scene:'画室',conflict:'理想与现实',
            goal:'形成新的应对方式',hook:'她带来旧画册',dilemma:'她面对导师的疑问',
            question:'你愿意如何面对？',resolution:'依据回应解决眼前的事',
            seeds:{persona:'画家',desire:'举办展览',shadow:'害怕否定',friction:'导师的要求'},
            usedHistory:[],references:[],conflicts:[]})};
    runtime=createCoopSystem(host);
    t.after(()=>{
        runtime.dispose();setCoopMvuAuthority(false);
        globalThis.window=previousWindow;globalThis.document=previousDocument;
    });
    await runtime.loading;
    await runtime.configure({id:'a',name:'画家',mode:'coop',rankCount:7,initialAffinity:15});
    await runtime.generate('a');
    const eventId=runtime.event().id;
    async function turn(user,body,event) {
        messages.push({is_user:true,mes:user});await runtime.prepare();
        const current=runtime.snapshot.event;
        const report={nonce:runtime.snapshot.nonce,affinity:[],event:{eventId:current.id,characterId:'a',
            eventVersion:current.version,phase:current.phase,...event}};
        messages.push({is_user:false,mes:body+'<CoopReport>'+JSON.stringify(report)+'</CoopReport>'});
        await runtime.afterMessage(messages.length-1);
    }
    await turn('请让我看看画册。','她带来了旧画册。',{evidence:'旧画册'});
    await turn('请继续说。','她提出疑问，等待回应。',{evidence:'等待回应'});
    await turn('我愿意帮你核对资料。','她决定先核对资料，接受了有限帮助。',{evidence:'核对资料',
        completion:{summary:'她坦白对导师要求的顾虑，用户愿意一起核对资料。她接受了有限帮助，决定保留自己的判断，展览的问题继续推进。',
            outcome:'决定核对资料',outcomeEvidence:'核对资料',choice:'愿意帮忙核对',choiceEvidence:'愿意帮你',
            traits:['接受有限帮助'],facts:[],boundaries:[],openHooks:[],closedHooks:[],
            scene:{goalAchieved:true,closed:true,awaitingUser:false,blockingConflicts:[],evidence:'核对资料'}}});
    const profile=()=>runtime.state().profiles.a;
    assert.equal(profile().rank,1);assert.equal(profile().history.length,1);
    const emit=async(type,...args)=>{
        for(const handler of handlers.get(types[type]) || []) await handler(...args);
        await runtime.store.queue;
        if(runtime.store.eventPruneTask) await runtime.store.eventPruneTask;
    };
    return {runtime,messages,metadata,eventId,profile,emit,setScope:value=>{scope=value;}};
}

for(const missing of ['all','origin']) test('a same-chat temporary '+missing+' message gap retains archived event records',async t=>{
    const h=await fixture(t),before=clone(h.runtime.store.document.journal),original=h.messages.slice();
    if(missing==='all') h.messages.splice(0);
    else h.messages.splice(h.messages.findIndex(message=>message.sd_coop_id===h.profile().events[h.eventId].createdAt.id),1);
    // A reload or renderer callback is not evidence that the user deleted a floor.
    await h.emit(missing==='all'?'CHAT_CHANGED':'MESSAGE_EDITED');
    assert.deepEqual(h.runtime.store.document.journal,before);
    assert.deepEqual(h.metadata[STORAGE_KEY].journal,before);
    h.messages.splice(0,h.messages.length,...original);
    await h.emit('CHAT_CHANGED');
    assert.equal(h.profile().rank,1);assert.equal(h.profile().history.length,1);
    assert.equal(h.profile().events[h.eventId].phase,'completed');assert.equal(h.profile().affinity,15);
});

test('an explicit deleted origin floor permanently prunes its event through bootstrap',async t=>{
    const h=await fixture(t),original=h.messages.slice(),origin=h.profile().events[h.eventId].createdAt.id;
    h.messages.splice(h.messages.findIndex(message=>message.sd_coop_id===origin),1);
    await h.emit('MESSAGE_DELETED');
    assert.equal(h.profile().rank,0);assert.equal(h.profile().history.length,0);
    assert.equal(h.profile().events[h.eventId],undefined);
    assert.ok(h.metadata[STORAGE_KEY].journal.every(operation=>operation.data?.eventId!==h.eventId));
    // Restoring the old in-memory array cannot undo a confirmed deletion.
    h.messages.splice(0,h.messages.length,...original);await h.emit('CHAT_CHANGED');
    assert.equal(h.profile().rank,0);assert.equal(h.profile().events[h.eventId],undefined);
});

test('deleting only the closing reply rolls back promotion and retains the unfinished event',async t=>{
    const h=await fixture(t);
    h.messages.pop();await h.emit('MESSAGE_DELETED');
    assert.equal(h.profile().rank,0);assert.equal(h.profile().history.length,0);
    assert.equal(h.runtime.event().id,h.eventId);assert.equal(h.runtime.event().phase,'resolution');
    assert.ok(h.runtime.store.document.journal.some(operation=>operation.kind==='plan' && operation.data.eventId===h.eventId));
    await h.emit('CHAT_CHANGED');
    assert.equal(h.profile().rank,0);assert.equal(h.runtime.event().id,h.eventId);
});

test('a deletion notification captures its own scope before later transient chat changes',async t=>{
    const h=await fixture(t);
    await h.runtime.configure({id:'b',name:'另一位画家',mode:'coop',rankCount:7,initialAffinity:15});
    await h.runtime.generate('b');const secondId=h.runtime.event().id;
    // The second event starts on the first event's closing floor. Removing that
    // floor should roll back the first completion and prune only the second plan.
    h.messages.pop();const retained=h.messages.slice();
    const deleted=h.emit('MESSAGE_DELETED');
    h.messages.splice(0);await deleted;
    h.messages.push(...retained);await h.emit('MESSAGE_EDITED');
    assert.ok(h.runtime.store.document.journal.some(operation=>operation.kind==='plan' && operation.data.eventId===h.eventId));
    assert.ok(h.runtime.store.document.journal.every(operation=>operation.data?.eventId!==secondId));
    assert.equal(h.runtime.event().id,h.eventId);assert.equal(h.runtime.event().phase,'resolution');
});

test('a deletion notification waiting for another chat cannot prune a later chat',async t=>{
    const h=await fixture(t),before=clone(h.runtime.store.document.journal),original=h.messages.slice();
    h.setScope('chat-loading-when-delete-arrives');
    const deleted=h.emit('MESSAGE_DELETED');
    h.setScope('later-chat');h.messages.splice(0);await deleted;
    assert.equal(h.runtime.store.scope,'later-chat');
    assert.deepEqual(h.runtime.store.document.journal,before);
    assert.deepEqual(h.metadata[STORAGE_KEY].journal,before);
    h.messages.push(...original);await h.emit('CHAT_CHANGED');
    assert.equal(h.profile().rank,1);assert.equal(h.profile().history.length,1);
});
