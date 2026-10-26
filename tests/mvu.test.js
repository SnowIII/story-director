import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {initialState,clone} from '../coop/model.js';
import {mergeCoopMvu,createMvuSync,bindingCapability} from '../coop/mvu.js';

function setup() {
    const state=initialState({a:{id:'a',name:'画家',mode:'coop',initialAffinity:7}});
    const store={scope:'s',generation:1,readonly:false,state},messages=[{id:'reply'}],calls=[];
    const tables={message:{stat_data:{生命:11,故事导演:{主线:{当前拍:2},Coop:{回报:{nonce:'turn'}}}}},
        chat:{stat_data:{生命:12,故事导演:{间章:{进行中:false}}}}};
    const host={scope:()=>store.scope,messages:()=>messages};
    const api={getMvuData:target=>tables[target.type],replaceMvuData:async(data,target)=>{calls.push({...target});tables[target.type]=clone(data);}};
    host.mvu=()=>api;
    const sync=createMvuSync(host,store,()=>true);
    const affinity=type=>tables[type].stat_data.故事导演.Coop.角色.a.好感度;
    return {store,host,api,messages,tables,calls,sync,affinity};
}
test('MVU mirror preserves other fields and reports while exposing stable character IDs',()=>{
    const h=setup(),data=clone(h.tables.message);
    assert.equal(mergeCoopMvu(data,h.store.state),true);
    assert.equal(data.stat_data.生命,11);assert.equal(data.stat_data.故事导演.主线.当前拍,2);
    assert.deepEqual(data.stat_data.故事导演.Coop.回报,{nonce:'turn'});
    assert.deepEqual(data.stat_data.故事导演.Coop.角色.a,{名称:'画家',好感度:7,Rank:0,阶级上限:4,关系确认阶级:3,好感锁定:false,路线:'unset',管理模式:'coop'});
    assert.equal(mergeCoopMvu(data,h.store.state),false);
    h.store.state.profiles.a.name='新称呼';mergeCoopMvu(data,h.store.state);
    assert.deepEqual(Object.keys(data.stat_data.故事导演.Coop.角色),['a']);
});
test('MVU wrapped namespaces retain their wrappers and report',()=>{
    const h=setup(),data={stat_data:{故事导演:[{Coop:[{回报:{nonce:'turn'}},'Coop 说明']},'命名空间说明']}};
    mergeCoopMvu(data,h.store.state);
    assert.equal(data.stat_data.故事导演[1],'命名空间说明');
    assert.equal(data.stat_data.故事导演[0].Coop[1],'Coop 说明');
    assert.equal(data.stat_data.故事导演[0].Coop[0].角色.a.好感度,7);
    assert.equal(data.stat_data.故事导演[0].Coop[0].回报.nonce,'turn');
});
test('sync writes both the concrete message snapshot and chat baseline without duplicate writes',async()=>{
    const h=setup();assert.equal(await h.sync(),true);
    assert.deepEqual(h.calls,[{type:'message',message_id:0},{type:'chat'}]);
    assert.equal(h.affinity('message'),7);assert.equal(h.affinity('chat'),7);
    assert.equal(h.tables.message.stat_data.生命,11);assert.equal(h.tables.chat.stat_data.生命,12);
    await h.sync();assert.equal(h.calls.length,2);
});
test('sync coalesces recursive notifications and publishes the latest confirmed state',async()=>{
    const h=setup(),replace=h.api.replaceMvuData;
    h.api.replaceMvuData=async(data,target)=>{
        await replace(data,target);
        assert.ok(h.calls.length<8,'MVU feedback loop did not stop');
        if(h.calls.length===1) h.store.state={...h.store.state,profiles:{a:{...h.store.state.profiles.a,affinity:9}}};
        void h.sync();
    };
    await h.sync();assert.equal(h.affinity('message'),9);assert.equal(h.affinity('chat'),9);
    assert.equal(h.calls.length,4);
});
test('read-only windows and windows without a writer lease cannot mirror or mutate live MVU data',async()=>{
    const h=setup();h.store.readonly=true;
    assert.equal(await h.sync(),false);assert.equal(h.sync.updateLive(h.tables.message),false);
    h.store.readonly=false;
    const noLease=createMvuSync(h.host,h.store,()=>false);
    assert.equal(await noLease(),false);assert.equal(noLease.updateLive(h.tables.message),false);
    assert.equal(h.calls.length,0);assert.equal(h.tables.message.stat_data.故事导演.Coop.角色,undefined);
});
for(const change of ['scope','reload','swipe']) test('old MVU sync stops its remaining writes after '+change,async()=>{
    const h=setup(),replace=h.api.replaceMvuData;let release,entered;
    const started=new Promise(resolve=>{entered=resolve;});
    h.api.replaceMvuData=async(data,target)=>{entered();await new Promise(resolve=>{release=resolve;});await replace(data,target);};
    const pending=h.sync();await started;
    if(change==='reload') h.store.generation++;
    if(change==='scope') h.store.scope='other';
    if(change==='swipe') h.messages[0].swipe_id=1;
    release();assert.equal(await pending,false);
    assert.deepEqual(h.calls,[{type:'message',message_id:0}]);
    assert.equal(h.tables.chat.stat_data.故事导演.Coop,undefined);
});
test('an MVU write failure is retryable without changing Coop progress',async()=>{
    const h=setup(),replace=h.api.replaceMvuData,before=clone(h.store.state);
    h.api.replaceMvuData=async()=>{throw new Error('MVU unavailable');};
    assert.equal(await h.sync(),false);assert.match(h.sync.error.message,/MVU unavailable/);
    assert.deepEqual(clone(h.store.state),before);
    h.api.replaceMvuData=replace;await h.sync();
    assert.equal(h.sync.error,null);assert.equal(h.affinity('message'),7);
});
test('MVU update hooks repair a model-written total using the confirmed Coop state',()=>{
    const h=setup(),live={stat_data:{故事导演:{Coop:{角色:{a:{好感度:99}},回报:{nonce:'new'}}}}};
    assert.equal(h.sync.updateLive(live),true);
    assert.equal(live.stat_data.故事导演.Coop.角色.a.好感度,7);
    assert.equal(live.stat_data.故事导演.Coop.回报.nonce,'new');
    assert.equal(h.sync.updateLive(live),false);
});
test('missing MVU and uninitialized tables are left intact and can sync when ready',async()=>{
    const h=setup();h.host.mvu=()=>null;
    assert.equal(await h.sync(),false);assert.equal(h.sync.error,null);
    assert.equal(bindingCapability().available,false);assert.equal(bindingCapability(h.api).available,true);
    h.host.mvu=()=>h.api;h.tables.message={other:'not initialized'};
    await h.sync();assert.deepEqual(h.tables.message,{other:'not initialized'});
    assert.equal(h.affinity('chat'),7);
    assert.equal(mergeCoopMvu({stat_data:{}},initialState()),false);
});
test('director token writes preserve the confirmed Coop mirror even with an older namespace snapshot',async()=>{
    const h=setup(),source=fs.readFileSync(new URL('../index.js',import.meta.url),'utf8');
    const start=source.indexOf('async function writeMvu(d) {'),end=source.indexOf('\n}\n',start)+2;
    const context=vm.createContext({mvu:()=>h.api,isPlainObject:value=>!!value && typeof value==='object' && !Array.isArray(value),
        NS:'故事导演',coop:{syncMvu:h.sync},console});
    vm.runInContext(source.slice(start,end),context);
    await context.writeMvu({stat_data:{故事导演:{主线:{当前拍:3}}}});
    assert.equal(h.affinity('message'),7);assert.equal(h.affinity('chat'),7);
    assert.equal(h.tables.chat.stat_data.生命,12);
    assert.equal(h.tables.chat.stat_data.故事导演.主线.当前拍,3);
});
