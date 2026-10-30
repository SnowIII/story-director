import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createHost,contextScope} from '../coop/host.js';
import {applyNsCommand,setCoopScene,renderContractSection} from '../model.js';
import {newDocument,readDocument} from '../coop/timeline.js';
import {candidates} from '../coop/roster.js';
import {readMvuReport,bindingCapability} from '../coop/mvu.js';
function context(group=false) {
    return {chatId:'test-chat',getCurrentChatId:()=> 'test-chat',characterId:0,groupId:group?'group-1':null,
        characters:[{name:'测试角色',avatar:'中文角色.png'}],chatMetadata:{integrity:'test',unrelated:{keep:true}},
        chat:[{is_user:true,mes:'test'}],getRequestHeaders:()=>({'Content-Type':'application/json'})};
}
function install(t,ctx,fetcher) {
    const oldWindow=globalThis.window,oldFetch=globalThis.fetch;
    globalThis.window={SillyTavern:{getContext:()=>ctx}};globalThis.fetch=fetcher;
    t.after(()=>{globalThis.window=oldWindow;globalThis.fetch=oldFetch;});
}
for(const group of [false,true]) test('acknowledged host persistence preserves metadata and targets correct chat, group='+group,async t=>{
    const ctx=context(group);let payload,url;
    install(t,ctx,async(u,request)=>{url=u;payload=JSON.parse(request.body);return {ok:true,json:async()=>({result:'ok'})};});
    const host=createHost(),doc=newDocument(host.scope());
    await host.persist(doc,host.scope());
    assert.equal(url,group?'/api/chats/group/save':'/api/chats/save');
    assert.deepEqual(payload.chat[0].chat_metadata.unrelated,{keep:true});
    assert.equal(payload.chat[0].chat_metadata.storyDirectorCoop.scope,host.scope());
    assert.equal(payload.force,false);
    assert.equal(group?payload.id:payload.file_name,'test-chat');
});
test('HTTP save failure restores prior metadata and throws',async t=>{
    const ctx=context();ctx.chatMetadata.storyDirectorCoop={old:true};
    install(t,ctx,async()=>({ok:false,status:503}));
    const host=createHost();await assert.rejects(host.persist(newDocument(host.scope()),host.scope()),{code:'SAVE_PENDING'});
    assert.deepEqual(ctx.chatMetadata.storyDirectorCoop,{old:true});
});
test('a server error in a successful HTTP response is not treated as saved',async t=>{
    const ctx=context();install(t,ctx,async()=>({ok:true,json:async()=>({error:'integrity'})}));
    const host=createHost();await assert.rejects(host.persist(newDocument(host.scope()),host.scope()),{code:'SAVE_PENDING'});
    assert.equal(ctx.chatMetadata.storyDirectorCoop,undefined);
});
test('a changed host chat cannot receive another chat document',async t=>{
    const ctx=context();let called=false;install(t,ctx,async()=>{called=true;});
    const host=createHost();await assert.rejects(host.persist(newDocument('wrong'),'wrong'),{code:'STALE_SCOPE'});
    assert.equal(called,false);
});
test('scope distinguishes cards with equal chat names and group chat',()=>{
    const a=context(),b=context();b.characters[0].avatar='另一角色.png';
    assert.notEqual(contextScope(a),contextScope(b));assert.notEqual(contextScope(a),contextScope(context(true)));
});
test('Chinese card names produce stable IDs even when display name changes',()=>{
    const ctx=context(),a=candidates(ctx)[0];ctx.characters[0].name='重命名';
    assert.equal(candidates(ctx)[0].id,a.id);assert.equal(a.cardRef,'中文角色.png');
});
test('unknown future schema is preserved rather than reset',()=>{
    const raw={schemaVersion:999,roster:{},journal:[]};
    assert.throws(()=>readDocument(raw,'scope'),{code:'UNSUPPORTED_SCHEMA'});assert.equal(raw.schemaVersion,999);
});
test('Coop scene rejects all legacy plot progress writes',()=>{
    setCoopScene(true);
    for(const field of ['主线.本拍已落','间章.可回主线','支线.t1.已落','插曲.i1.状态']) {
        const data={'故事导演':{}};
        applyNsCommand(data,{type:'set',args:['path','true']},'故事导演.'+field);
        assert.deepEqual(data,{'故事导演':{}});
    }
    setCoopScene(false);
});
test('Coop owned fields stay protected outside an event',()=>{
    setCoopScene(false);
    for(const type of ['set','add','insert','assign','delete']) {
        const data={'故事导演':{}};
        applyNsCommand(data,{type,args:['path','100']},'故事导演.Coop.好感');
        assert.deepEqual(data,{'故事导演':{}});
    }
});
test('Coop contract contains no legacy mainline completion command',()=>{
    assert.ok(!renderContractSection({mode:'coop',beat:'test'}).join('\n').includes("_.set('故事导演.主线"));
});
test('ordinary mainline progress still works outside Coop',()=>{
    setCoopScene(false);const data={'故事导演':{主线:{本拍已落:false}}};
    applyNsCommand(data,{type:'set',args:['path','true']},'故事导演.主线.本拍已落');
    assert.equal(data['故事导演'].主线.本拍已落,true);
});
test('MVU wrapped report retains nonce and protected binding stays disabled',()=>{
    const report={nonce:'turn-a',affinity:[]};
    assert.deepEqual(readMvuReport({stat_data:{故事导演:{Coop:[{回报:[report,'说明']},'说明']}}}),report);
    assert.equal(bindingCapability().available,false);
});
function generationSandbox() {
    const source=fs.readFileSync(new URL('../index.js',import.meta.url),'utf8');
    const begin=source.slice(source.indexOf('function beginGenerate('),source.indexOf('/**\n * 用户点了「中断」'));
    const abort=source.slice(source.indexOf('function abortGenerate()'),source.indexOf('/**\n * ★ 0.27.13',source.indexOf('function abortGenerate()')));
    const abortFunction=abort.slice(0,abort.indexOf('\n\n\n/**'));
    const context=vm.createContext({setInterval:()=>1,clearInterval:()=>{},console,Date,AbortController});
    vm.runInContext("let coop=null; let storyGenerating=false, storyGeneratingSince=0, genId=0, genAborted=false, genLabel='', genStartedAt=0, genChars=0, genTicker=null, genCtl=null, genAbortedAt=0; const GENERATE_WATCHDOG=240000; function renderBusyBar(){} function toast(){};\n"+begin+'\n'+abortFunction,context);
    return context;
}
test('old generation cleanup cannot clear a newer active task',()=>{
    const ctx=generationSandbox();
    const result=vm.runInContext("const first=beginGenerate('first');abortGenerate();const second=beginGenerate('second');endGenerate(first);({busy:storyGenerating,id:genId,second})",ctx);
    assert.equal(result.busy,true);assert.equal(result.id,result.second);
});
test('only the generation owner can release the task gate',()=>{
    const ctx=generationSandbox();
    assert.equal(vm.runInContext("const token=beginGenerate('first');endGenerate(token);storyGenerating",ctx),false);
});
test('legacy manual generation is rejected while Coop owns the scene',()=>{
    const ctx=generationSandbox();
    assert.equal(vm.runInContext("coop={occupies:()=>true};beginGenerate('主线')",ctx),false);
    assert.ok(vm.runInContext("beginGenerate('Coop 事件')",ctx)>0);
});
test('a backed-off legacy generation does not acquire the shared gate',async()=>{
    const ctx=generationSandbox();
    const src=fs.readFileSync(new URL('../index.js',import.meta.url),'utf8');
    const fn=src.slice(src.indexOf('async function generateThread('),src.indexOf('async function generateInterlude(',src.indexOf('async function generateThread(')));
    vm.runInContext("function chatKey(){return 'test'} function isBackingOff(){return true}\n"+fn,ctx);
    assert.equal(await vm.runInContext('generateThread()',ctx),false);
    assert.equal(vm.runInContext('storyGenerating',ctx),false);
});
