import test from 'node:test';
import assert from 'node:assert/strict';
import {CoopRuntime} from '../coop/runtime.js';
import {clone} from '../coop/model.js';
import {candidates} from '../coop/roster.js';
import {STORAGE_KEY} from '../coop/store.js';

const cards=[{name:'画家',avatar:'painter.png'},{name:'医生',avatar:'doctor.png'},{name:'路人',avatar:'other.png'}];
function setup(t,{context={},scope='chat-a',save=null,writable=true}={}) {
    const meta={},messages=[],saved=[];
    const host={context:()=>context,scope:()=>scope,metadata:()=>meta,messages:()=>messages,
        locks:{request:async(name,options,callback)=>callback(writable?{name}:null)},
        persist:async(document,target)=>{if(save) await save(document,target);meta[STORAGE_KEY]=clone(document);saved.push(clone(document));},
        available:()=>true,autoAllowed:()=>false};
    const runtime=new CoopRuntime(host);t.after(()=>runtime.dispose());
    return {runtime,meta,messages,saved,context,setScope:value=>{scope=value;},setWritable:value=>{writable=value;}};
}

test('the current card is discovered but cannot score before its rank scheme is chosen',async t=>{
    const h=setup(t,{context:{characters:cards,characterId:1}});await h.runtime.load();
    assert.equal(Object.keys(h.runtime.state().profiles).length,0);assert.equal(h.saved.length,0);
    assert.equal(h.runtime.pendingCharacters[0].cardRef,'doctor.png');
    await h.runtime.enrollCard(h.runtime.pendingCharacters[0].id,7);
    const profiles=Object.values(h.runtime.state().profiles);
    assert.equal(profiles.length,1);assert.equal(profiles[0].cardRef,'doctor.png');
    assert.equal(profiles[0].mode,'coop');assert.equal(profiles[0].affinity,0);assert.equal(profiles[0].rankCount,7);
    h.messages.push({is_user:true,mes:'我来帮你。'});await h.runtime.prepare();
    assert.deepEqual(Object.keys(h.runtime.snapshot.roles),[profiles[0].id]);
    assert.equal(h.saved.length,1);
});

test('repeated and overlapping loads do not recreate or rewrite a managed card',async t=>{
    const h=setup(t,{context:{characters:cards,characterId:0}});await h.runtime.load();
    await h.runtime.enrollCard(h.runtime.pendingCharacters[0].id,4);
    const before=clone(h.runtime.store.document);
    await Promise.all([h.runtime.load(),h.runtime.load(),h.runtime.load()]);
    assert.deepEqual(h.runtime.store.document,before);assert.equal(h.saved.length,1);
});

test('automatic management preserves an existing renamed card, NPC, score, gate and policy',async t=>{
    const context={characters:cards},h=setup(t,{context});await h.runtime.load();
    const card=candidates({...context,characterId:0})[0];
    await h.runtime.configure({...card,name:'英妮缇雅',aliases:['维赛塔'],description:'自定义补充',mode:'coop',initialAffinity:30});
    await h.runtime.configure({id:'npc:friend',name:'朋友',mode:'coop',initialAffinity:12});
    const before=clone(h.runtime.store.document),profiles=clone(h.runtime.state().profiles),writes=h.saved.length;
    context.characterId=0;await h.runtime.load();
    assert.deepEqual(h.runtime.store.document,before);assert.deepEqual(clone(h.runtime.state().profiles),profiles);
    assert.equal(h.runtime.state().profiles[card.id].affinity,30);assert.ok(h.runtime.state().profiles[card.id].lock);
    assert.equal(h.saved.length,writes);
});

test('group members independently choose rank schemes and only confirmed members enter the turn',async t=>{
    const context={characters:cards,groupId:'g',groups:[{id:'g',members:['painter.png']}]},h=setup(t,{context});
    await h.runtime.load();await h.runtime.enrollCard(h.runtime.pendingCharacters[0].id,4);
    const first=Object.values(h.runtime.state().profiles)[0];
    context.groups[0].members.push('doctor.png');h.messages.push({is_user:true,mes:'大家好。'});
    await Promise.all([h.runtime.prepare(),h.runtime.prepare(),h.runtime.prepare()]);
    assert.equal(Object.keys(h.runtime.snapshot.roles).length,1);assert.equal(h.saved.length,1);
    await h.runtime.enrollCard(h.runtime.pendingCharacters[0].id,10);await h.runtime.prepare();
    assert.deepEqual(Object.values(h.runtime.state().profiles).map(p=>p.cardRef).sort(),['doctor.png','painter.png']);
    assert.equal(h.runtime.state().profiles[first.id].policyRevision,1);
    assert.equal(Object.keys(h.runtime.snapshot.roles).length,2);assert.equal(h.saved.length,2);
});

test('missing selection, missing group and no chat do not add arbitrary cards',async t=>{
    for(const options of [{context:{characters:cards}},{context:{characters:cards,groupId:'missing',characterId:0}},
        {context:{characters:cards,characterId:0},scope:''}]) {
        const h=setup(t,options);await h.runtime.load();
        assert.deepEqual(Object.keys(h.runtime.store.document?.roster || {}),[]);assert.equal(h.saved.length,0);
    }
});

test('read-only windows cannot select a scheme and takeover enables an explicit choice',async t=>{
    const h=setup(t,{context:{characters:cards,characterId:0},writable:false});await h.runtime.load();
    assert.equal(h.runtime.store.readonly,true);assert.equal(h.saved.length,0);
    assert.deepEqual(Object.keys(h.runtime.state().profiles),[]);
    h.setWritable(true);await h.runtime.takeover();
    assert.equal(h.saved.length,0);await h.runtime.enrollCard(h.runtime.pendingCharacters[0].id,10);
    assert.equal(h.runtime.store.readonly,false);assert.equal(h.saved.length,1);
    assert.equal(Object.values(h.runtime.state().profiles)[0].mode,'coop');
});

test('a failed enrollment stays pending until retry without confirming a different rank scheme',async t=>{
    let offline=true;
    const h=setup(t,{context:{characters:cards,characterId:0},save:async()=>{if(offline) throw new Error('offline');}});
    await h.runtime.load();await assert.rejects(h.runtime.enrollCard(h.runtime.pendingCharacters[0].id,7),/offline/);
    assert.ok(h.runtime.store.pending);assert.equal(h.saved.length,0);
    assert.deepEqual(Object.keys(h.runtime.state().profiles),[]);
    await h.runtime.ensureCurrentCharacters();assert.equal(h.saved.length,0);
    offline=false;await h.runtime.store.retrySave();await h.runtime.ensureCurrentCharacters();
    const profiles=Object.values(h.runtime.state().profiles);
    assert.equal(profiles.length,1);assert.equal(profiles[0].policyRevision,1);assert.equal(h.saved.length,1);assert.equal(profiles[0].rankCount,7);
});

test('queued automatic additions cannot write into a chat selected after the request',async t=>{
    const context={characters:cards},h=setup(t,{context});await h.runtime.load();
    let release;const gate=new Promise(resolve=>{release=resolve;});
    const blocked=h.runtime.store.enqueue(async()=>{await gate;});
    context.characterId=0;await h.runtime.ensureCurrentCharacters();const adding=h.runtime.enrollCard(h.runtime.pendingCharacters[0].id,7);
    h.setScope('chat-b');release();
    await assert.rejects(blocked,{code:'STALE_SCOPE'});await assert.rejects(adding,{code:'STALE_SCOPE'});
    assert.equal(h.saved.length,0);
    context.characterId=1;await h.runtime.load();
    await h.runtime.enrollCard(h.runtime.pendingCharacters[0].id,10);
    assert.equal(h.saved.length,1);assert.equal(h.saved[0].scope,'chat-b');
    assert.deepEqual(Object.values(h.runtime.state().profiles).map(p=>p.cardRef),['doctor.png']);
});

test('a name conflict never overwrites a manually managed NPC',async t=>{
    const context={characters:cards},h=setup(t,{context});await h.runtime.load();
    await h.runtime.configure({id:'npc:painter',name:'画家',mode:'coop',initialAffinity:18});
    const before=clone(h.runtime.store.document);context.characterId=0;await h.runtime.load();
    await assert.rejects(h.runtime.enrollCard(h.runtime.pendingCharacters[0].id,7),{code:'AMBIGUOUS_IDENTITY'});
    assert.deepEqual(h.runtime.store.document,before);assert.equal(h.saved.length,1);
    assert.equal(h.runtime.state().profiles['npc:painter'].affinity,18);
});
