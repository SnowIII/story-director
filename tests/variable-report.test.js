import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {CoopRuntime} from '../coop/runtime.js';
import {parseReports,sourceMap} from '../coop/messages.js';
import {visibleBody} from '../coop/body.js';
import {clone} from '../coop/model.js';
import {reportContract} from '../coop/prompts.js';
import {renderContractSection} from '../model.js';

const block=report=>'<UpdateVariable><Analysis>核对实际互动。</Analysis><JSONPatch>'+JSON.stringify([
    {op:'replace',path:'/故事导演/间章/可回主线',value:true},
    {op:'add',path:'/故事导演/Coop/回报',value:report}])+'</JSONPatch></UpdateVariable>';
const proposal=delta=>({affinity:[{characterId:'a',delta,reason:'实际支持',userEvidence:'帮你',evidence:'放松'}]});
test('JSONPatch report shares UpdateVariable with other director updates',()=>{
    const report={nonce:'current',...proposal(2)},body='她放松了。'+block(report);
    assert.deepEqual(parseReports(body),[report]);
    assert.equal(visibleBody(body),'她放松了。');
    assert.ok(body.includes('/故事导演/间章/可回主线'));
});
test('legacy MVU set syntax can submit the same variable report',()=>{
    const report={nonce:'current',...proposal(2)};
    assert.deepEqual(parseReports('她放松了。<UpdateVariable>_.set(\'故事导演.Coop.回报\', '+JSON.stringify(report)+');</UpdateVariable>'),[report]);
});
test('variable reports use the last assignment, including replacing a zero placeholder',()=>{
    const zero={nonce:'n',...proposal(0)},actual={nonce:'n',...proposal(2)};
    assert.deepEqual(parseReports(block(zero)+block(actual)),[actual]);
});
test('analysis examples, narrative tag mentions and unfinished blocks cannot report scores',()=>{
    const report={nonce:'n',...proposal(2)},payload=block(report);
    assert.deepEqual(parseReports('<build>'+payload+'</build><content>她拒绝了。</content>'),[]);
    assert.deepEqual(parseReports('<content>纸上印着 '+payload+'</content>'),[]);
    assert.deepEqual(parseReports(payload.replace('</UpdateVariable>','')),[]);
});
test('a variable opener mentioned in analysis cannot swallow the real report block',()=>{
    const report={nonce:'n',...proposal(2)};
    assert.deepEqual(parseReports('<build>结尾要有 <UpdateVariable>。</build><content>她放松了。</content>'+block(report)),[report]);
});
test('direct score writes, unrelated namespaces and remove operations are not score reports',()=>{
    for(const patch of [{op:'replace',path:'/故事导演/Coop/角色/a/好感度',value:100},
        {op:'add',path:'/其他插件/Coop/回报',value:{nonce:'n',...proposal(2)}},
        {op:'remove',path:'/故事导演/Coop/回报'}]) {
        assert.deepEqual(parseReports('<UpdateVariable><JSONPatch>'+JSON.stringify([patch])+'</JSONPatch></UpdateVariable>'),[]);
    }
});
test('report parser accepts only data and rejects prototype keys or executable expressions',()=>{
    assert.deepEqual(parseReports('<UpdateVariable>_.set(\'故事导演.Coop.回报\', (()=>{throw new Error("executed")})());</UpdateVariable>'),[]);
    assert.deepEqual(parseReports('<UpdateVariable><JSONPatch>[{"op":"add","path":"/故事导演/Coop/回报","value":{"__proto__":{},"nonce":"n"}}]</JSONPatch></UpdateVariable>'),[]);
});

test('director transport accepts complete tags only outside analysis, story, variables and code examples',()=>{
    const report={nonce:'current',event:{eventId:'event',phase:'hook'}},tag='<CoopReport>'+JSON.stringify(report)+'</CoopReport>';
    assert.deepEqual(parseReports('她放下画册。'+tag,{directorOnly:true}),[report]);
    for(const hidden of ['<build>'+tag+'</build>','<analysis>'+tag+'</analysis>','<content>'+tag+'</content>',
        '<UpdateVariable>'+tag+'</UpdateVariable>','```json\n'+tag+'\n```',tag.replace('</CoopReport>','')]) {
        assert.deepEqual(parseReports(hidden,{directorOnly:true}),[]);
    }
    assert.deepEqual(parseReports('<CoopReport>{"__proto__":{},"nonce":"n"}</CoopReport>',{directorOnly:true}),[]);
});

async function setup(t,{extra=false,initial=0,mode='affinity'}={}) {
    const messages=[],metadata={},context={extensionSettings:{mvu_settings:{更新方式:extra?'额外模型解析':'随AI输出'}}};
    const host={scope:()=> 'variable-fixture',metadata:()=>metadata,messages:()=>messages,context:()=>context,
        available:()=>true,autoAllowed:()=>false,locks:{request:async(name,options,fn)=>fn({name})},
        persist:async document=>{metadata.storyDirectorCoop=clone(document);}};
    const runtime=new CoopRuntime(host);await runtime.load();t.after(()=>runtime.dispose());
    await runtime.configure({id:'a',name:'画家',mode,initialAffinity:initial});
    async function begin(){messages.push({is_user:true,mes:'画家，我来帮你。'});await runtime.prepare();return runtime.snapshot;}
    async function send(delta,{body='她放松了。',via='inline',nonce=null}={}){
        const snapshot=await begin(),report={nonce:nonce || snapshot.nonce,...proposal(delta)};
        messages.push({is_user:false,mes:body+(via==='inline'?block(report):'')});
        const index=messages.length-1;
        if(via==='early') await runtime.receiveMvu({stat_data:{故事导演:{Coop:{回报:report}}}});
        await runtime.afterMessage(index);
        if(via==='late') await runtime.receiveMvu({stat_data:{故事导演:{Coop:{回报:report}}}});
        return {index,report};
    }
    return {runtime,host,messages,metadata,begin,send,profile:()=>runtime.state().profiles.a};
}
for(const extra of [false,true]) for(const via of ['early','late']) test('MVU variable delivery settles once, extra='+extra+', delivery='+via,async t=>{
    const h=await setup(t,{extra});const {index,report}=await h.send(2,{via});
    assert.equal(h.profile().affinity,2);assert.equal(h.profile().scoreLog.length,1);
    await h.runtime.receiveMvu({stat_data:{故事导演:{Coop:{回报:report}}}});
    await h.runtime.afterMessage(index);
    assert.equal(h.profile().affinity,2);assert.equal(h.profile().scoreLog.length,1);
});
test('inline variable output remains visible and is idempotent after MVU events and reload',async t=>{
    const h=await setup(t),{index,report}=await h.send(2);
    assert.ok(h.messages[index].mes.includes('<JSONPatch>'));
    assert.ok(!h.messages[index].mes.includes('<CoopReport>'));
    await h.runtime.receiveMvu({stat_data:{故事导演:{Coop:{回报:report}}}});
    await h.runtime.load();await h.runtime.afterMessage(index);
    assert.equal(h.profile().affinity,2);assert.equal(h.profile().scoreLog.length,1);
});
test('inline-mode MVU completion can recover a report appended after rendering even when schema drops its field',async t=>{
    const h=await setup(t),{index,report}=await h.send(2,{via:'none'});
    assert.equal(h.profile().affinity,0);
    h.messages[index].mes+=block(report);
    await h.runtime.receiveMvu({stat_data:{生命:10}});
    assert.equal(h.profile().affinity,2);
    await h.runtime.receiveMvu({stat_data:{生命:10}});assert.equal(h.profile().scoreLog.length,1);
});
test('stale nonce and missing narrative evidence do not create score operations',async t=>{
    const h=await setup(t);
    await h.send(2,{nonce:'previous-turn'});assert.equal(h.profile().affinity,0);
    await h.send(2,{body:'她拒绝了。'});assert.equal(h.profile().affinity,0);
    assert.equal(h.runtime.store.document.journal.length,0);
});
test('variable report respects the 30-point gate and locked negative changes',async t=>{
    const h=await setup(t,{initial:29,mode:'coop'});
    await h.send(5);assert.equal(h.profile().affinity,30);assert.ok(h.profile().lock);
    await h.send(-5);assert.equal(h.profile().affinity,30);
    assert.equal(h.profile().scoreLog.at(-1).reasonCode,'AFFINITY_LOCKED');
});
test('editing an earlier variable-report story preserves later independent valid points',async t=>{
    const h=await setup(t),first=await h.send(2);await h.send(3);
    assert.equal(h.profile().affinity,5);
    h.messages[first.index].mes='她拒绝了。';h.runtime.store.reconcile();
    assert.equal(h.profile().affinity,5);
    h.messages.splice(first.index-1,2);h.runtime.store.reconcile();assert.equal(h.profile().affinity,3);
});
test('variable payload cannot supply its own evidence and changing only patches preserves source version',async t=>{
    const h=await setup(t),{index}=await h.send(2,{body:'她拒绝了。'});
    assert.equal(h.profile().affinity,0);
    const id=h.messages[index].sd_coop_id,version=sourceMap(h.messages).get(id).version;
    h.messages[index].mes=h.messages[index].mes.replace('实际支持','另一种说明');
    assert.equal(sourceMap(h.messages).get(id).version,version);
});
test('round contract includes current state, nonce and both MVU output syntaxes',async t=>{
    const h=await setup(t,{initial:7});const snapshot=await h.begin(),contract=h.runtime.variableContract();
    assert.ok(contract.includes(snapshot.nonce));assert.ok(contract.includes('"affinity":7'));
    assert.ok(contract.includes('/故事导演/Coop/回报'));assert.ok(contract.includes('_.set('));
    assert.ok(!h.runtime.injection().includes(snapshot.nonce));
    h.messages.push({is_user:true,mes:'新的互动。'});assert.equal(h.runtime.variableContract(),'');
});
for(const injectContract of [false,true]) test('shared variable slot receives Coop rules even without a main beat, main contract='+injectContract,()=>{
    const profile={id:'a',name:'画家',aliases:[],mode:'coop',affinity:7,rank:0,lock:null,traits:[],boundaries:[]};
    const report=reportContract([profile],null,{nonce:'current-turn'},false),slots={};
    const source=fs.readFileSync(new URL('../index.js',import.meta.url),'utf8');
    const start=source.indexOf('function syncMainInjection() {'),end=source.indexOf('\n}\n',start)+2;
    const context=vm.createContext({settings:()=>({injectContract,injectDepth:4}),toNumber:(value,fallback)=>Number.isFinite(Number(value))?Number(value):fallback,syncInterludeWrites:()=>{},buildInjection:()=>'',
        substitute:value=>value,renderContractSection,currentMode:()=> 'main',currentBeatLine:()=>'',landingByExtraModel:()=>false,
        SLOT:{main:'main',threads:'threads',interludes:'interludes',contract:'contract',coop:'coop'},
        setExtensionPrompt:(name,value)=>{slots[name]=value;},extension_prompt_types:{IN_CHAT:1},extension_prompt_roles:{SYSTEM:1},
        coop:{variableContract:()=>report,injection:()=> 'scene'},panel:null,console});
    vm.runInContext(source.slice(start,end),context);context.syncMainInjection();
    assert.ok(slots.contract.includes('current-turn'));assert.ok(slots.contract.includes('/故事导演/Coop/回报'));
    assert.ok(!slots.contract.includes('不要写任何 `故事导演.*` 回报'));
    assert.equal(slots.coop,'scene');
});
