import test from 'node:test';
import assert from 'node:assert/strict';
import {CoopStore,STORAGE_KEY} from '../coop/store.js';
import {clone,THRESHOLDS} from '../coop/model.js';
import {ensureMessageIds,references} from '../coop/messages.js';

function deferred() {
    let resolve,reject;
    const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});
    return {promise,resolve,reject};
}
async function setup() {
    const messages=[{is_user:true,mes:'我来帮你。'},{is_user:false,mes:'她接受了帮助。'}],metadata={},broadcasts=[];
    ensureMessageIds(messages);
    const host={scope:()=> 'store-test',metadata:()=>metadata,messages:()=>messages,
        persist:async document=>{metadata[STORAGE_KEY]=clone(document);},broadcast:document=>broadcasts.push(clone(document))};
    const store=new CoopStore(host);store.load();
    await store.enqueue(document=>{document.roster.a={id:'a',name:'画家',mode:'coop',initialAffinity:29,thresholds:THRESHOLDS,policyRevision:1};});
    const source=[...store.sources().values()].at(-1);
    const score=()=>store.operation('affinity','a',{characterId:'a',delta:1,interactionId:source.userId,source},references(source));
    return {store,host,messages,metadata,broadcasts,source,score};
}
function holdSave(host) {
    const entered=deferred(),finished=deferred(),persist=host.persist;
    host.persist=async document=>{entered.resolve();await finished.promise;await persist(document);};
    return {entered:entered.promise,finish:finished.resolve,fail:finished.reject};
}
for(const change of ['edit','delete','swipe','exclude']) test('save confirmation rechecks current sources after '+change,async()=>{
    const h=await setup(),save=holdSave(h.host),published=[];
    h.store.onChange=()=>published.push(h.store.state.profiles.a.affinity);
    h.host.broadcast=()=>published.push(h.store.state.profiles.a.affinity);
    const pending=h.score();await save.entered;
    if(change==='edit') h.messages[1].mes='她没有接受帮助。';
    if(change==='delete') h.messages.pop();
    if(change==='swipe') h.messages[1].swipe_id=1;
    if(change==='exclude') h.store.excluded.set(h.source.id,h.source.version);
    h.store.reconcile();save.finish();await pending;
    assert.equal(h.store.state.profiles.a.affinity,29);
    assert.equal(h.store.state.profiles.a.lock,null);
    assert.equal(h.store.state.skipped[0].code,'STALE_SOURCE');
    assert.ok(published.every(value=>value===29),'an obsolete gate was published');
    assert.equal(h.store.pending,null);
    assert.equal(h.metadata[STORAGE_KEY].journal.length,1);
});
test('failed save, retry, source edit and reload retain only the valid projection',async()=>{
    const h=await setup(),persist=h.host.persist;
    h.host.persist=async()=>{throw new Error('offline');};
    await assert.rejects(h.score(),/offline/);
    assert.equal(h.store.state.profiles.a.affinity,29);
    h.host.persist=persist;
    const save=holdSave(h.host),retry=h.store.retrySave();await save.entered;
    const original=h.messages[1].mes;
    h.messages[1].mes='她没有接受帮助。';save.finish();await retry;
    assert.equal(h.store.state.profiles.a.affinity,29);
    h.store.load();assert.equal(h.store.state.profiles.a.affinity,29);
    h.messages[1].mes=original;h.store.reconcile();
    assert.equal(h.store.state.profiles.a.affinity,30);
    h.store.load();assert.equal(h.store.state.profiles.a.affinity,30);
    assert.equal(h.store.document.journal.length,1);
});
for(const fails of [false,true]) test('a save from before reload cannot change the reloaded store, failure='+fails,async()=>{
    const h=await setup(),save=holdSave(h.host),pending=h.score();await save.entered;
    h.store.load();const loaded=h.store.document,broadcasts=h.broadcasts.length;
    if(fails) {save.fail(new Error('old failure'));await assert.rejects(pending,/old failure/);}
    else {save.finish();await pending;}
    assert.equal(h.store.document,loaded);
    assert.equal(h.store.state.profiles.a.affinity,29);
    assert.equal(h.store.pending,null);assert.equal(h.store.error,null);
    assert.equal(h.broadcasts.length,broadcasts);
});
