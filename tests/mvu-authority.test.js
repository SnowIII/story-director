import test from 'node:test';
import assert from 'node:assert/strict';
import {CoopRuntime} from '../coop/runtime.js';
import {clone,initialState} from '../coop/model.js';
import {deletedEventIds,pruneDeletedEvents} from '../coop/timeline.js';
import {createHost} from '../coop/host.js';
import {mergeCoopMvu,mvuApiFor} from '../coop/mvu.js';
import {applyNsCommands,setCoopScene,setCoopMvuAuthority} from '../model.js';

async function fixture(t,{initial=5,name='画家',authority=true,rankCount=4,extra=false,legacy=false}={}) {
    const empty=()=>({stat_data:{生命:11,故事导演:{Coop:{角色:{}}}}});
    const metadata={},messages=[{is_user:false,mes:'画家在整理资料。',variables:[empty()]}];
    let baseline=empty(),failSave=false;
    const host={affinityAuthority:authority?'mvu':undefined,scope:()=> 'mvu-owner',metadata:()=>metadata,
        messages:()=>messages,context:()=>({extensionSettings:{mvu_settings:{更新方式:extra?'额外模型解析':'随AI输出'}}}),available:()=>true,autoAllowed:()=>false,contextText:async()=> '画家整理资料。',
        locks:{request:async(name,options,callback)=>callback({name})},persist:async document=>{
            if(failSave) throw new Error('offline');metadata.storyDirectorCoop=clone(document);
        },ask:async()=>JSON.stringify({targetRank:runtime.state().profiles.a.rank+1,title:'旧画册',scene:'画室',
            conflict:'理想与现实',goal:'接受有限的实际帮助',hook:'她拿出旧画册',dilemma:'导师提出疑问',question:'你愿意帮忙吗？',
            resolution:'依据回应核对资料',seeds:{persona:'画家',desire:'展览',shadow:'怕否定',friction:'导师'},
            usedHistory:runtime.state().profiles.a.history.map(h=>h.eventId),references:[],conflicts:[]})};
    const api={getMvuData:target=>target.type==='chat'?baseline:messages[target.message_id==='latest'?messages.length-1:target.message_id]?.variables?.[0] || {},
        replaceMvuData:async(data,target)=>{if(target.type==='chat') baseline=clone(data);else messages[target.message_id].variables=[clone(data)];}};
    host.mvu=()=>api;
    const runtime=new CoopRuntime(host);await runtime.load();t.after(()=>runtime.dispose());
    await runtime.configure({id:'a',name,mode:'coop',rankCount,initialAffinity:initial});await runtime.syncMvu();
    const row=(index=messages.length-1)=>messages[index].variables[0].stat_data.故事导演.Coop.角色[name];
    const write=(value,locked)=>{Object.assign(row(),{好感度:value,好感锁定:locked});runtime.store.reconcile();};
    async function turn({value,locked,user='我愿意帮你核对资料。',body='她放心地交给你资料。',event=null}={}) {
        const old=clone(messages.findLast(message=>message.variables)?.variables[0]);
        messages.push({is_user:true,mes:user});await runtime.prepare();
        const snapshot=runtime.snapshot;
        if(legacy) Object.assign(snapshot,{reportChannel:'mvu',reportProducer:extra?'external':'inline'});
        const report=event?{nonce:snapshot.nonce,event:{...snapshot.event,eventId:snapshot.event.id,
            eventVersion:snapshot.event.version,...event}}:null;
        const patches=report?[{op:'add',path:'/故事导演/Coop/回报',value:report}]:[];
        messages.push({is_user:false,mes:body+(report?(legacy?'<UpdateVariable><JSONPatch>'+JSON.stringify(patches)+'</JSONPatch></UpdateVariable>':
            '<CoopReport>'+JSON.stringify(report)+'</CoopReport>'):''),variables:[old]});
        await runtime.afterMessage(messages.length-1);
        const updated=clone(old),coop=updated.stat_data.故事导演.Coop;
        if(value!==undefined) coop.角色[name].好感度=value;
        if(locked!==undefined) coop.角色[name].好感锁定=locked;
        if(report && legacy) coop.回报=report;
        await runtime.receiveMvu(updated);messages.at(-1).variables=[updated];await runtime.syncMvu();runtime.store.reconcile();
        return snapshot;
    }
    return {runtime,host,metadata,messages,api,row,write,turn,saveFailure:value=>{failSave=value;}};
}

test('the production host selects MVU as the affinity authority',()=>{
    assert.equal(createHost().affinityAuthority,'mvu');
});

test('editing confirmed Coop dialogue keeps Rank and archive while deleting the floor still rolls back',async t=>{
    const h=await fixture(t,{initial:30});h.write(30,true);await h.runtime.generate('a');
    await h.turn({body:'她拿出旧画册。',event:{evidence:'旧画册'}});
    await h.turn({body:'她提出疑问，等待用户回应。',event:{evidence:'提出疑问'}});
    await h.turn({body:'她接受有限帮助，决定核对资料。',event:{evidence:'接受有限帮助',completion:{
        summary:'用户愿意共同核对资料，她接受有限帮助并保留自己的判断，后续展览仍需准备。',outcome:'核对资料',outcomeEvidence:'核对资料',
        choice:'愿意帮忙',choiceEvidence:'愿意帮你',traits:['接受帮助'],facts:[],boundaries:[],openHooks:[],closedHooks:[]}}});
    const history=clone(h.runtime.state().profiles.a.history);
    h.messages[2].mes='玩家改写了开场。';h.messages.at(-2).mes='玩家改写了回应。';h.messages.at(-1).mes='玩家改写了收束正文。';
    h.runtime.store.reconcile();await h.runtime.load();
    assert.equal(h.runtime.state().profiles.a.rank,1);
    assert.equal(h.runtime.state().profiles.a.history[0].summary,history[0].summary);
    assert.equal(h.row().好感度,30);assert.equal(h.row().好感锁定,true);
    h.messages.pop();h.runtime.store.reconcile();assert.equal(h.runtime.state().profiles.a.rank,0);
});

async function autoArchiveFixture(t,rankCount=4) {
    const affinity={4:30,7:15,10:10}[rankCount];
    const h=await fixture(t,{initial:affinity,rankCount});h.write(affinity,true);await h.runtime.generate('a');
    await h.turn({body:'她拿出旧画册。',event:{evidence:'旧画册'}});
    await h.turn({body:'她提出疑问，等待用户回应。',event:{evidence:'提出疑问'}});
    const result={ready:true,evidence:'核对资料',completion:{
        summary:'她说明画册和导师要求之间的矛盾，用户愿意共同核对资料。她接受有限帮助，保留自己的判断，展览问题仍待后续处理。',
        outcome:'核对资料并接受帮助',outcomeEvidence:'接受有限帮助',choice:'愿意帮助核对',choiceEvidence:'愿意帮你',
        traits:['接受有限帮助'],facts:[],boundaries:[],openHooks:['展览'],closedHooks:[]}};
    let calls=0;h.host.autoAllowed=()=>true;h.host.ask=async()=>{calls++;return JSON.stringify(result);};
    return {...h,result,affinity,calls:()=>calls};
}

for(const rankCount of [4,7,10]) test('automatic MVU archive uses one check and preserves values and rollback, ranks='+rankCount,async t=>{
    const h=await autoArchiveFixture(t,rankCount);
    await h.turn({body:'她决定核对资料，接受有限帮助。'});await h.runtime.archiveCheckTask;
    assert.equal(h.calls(),1);assert.equal(h.runtime.state().profiles.a.rank,1);
    assert.equal(h.row().好感度,h.affinity);assert.equal(h.row().好感锁定,true);
    const archived=clone(h.messages.at(-1).variables[0]);
    await h.runtime.receiveMvu(archived);await h.runtime.afterMessage(h.messages.length-1);await h.runtime.archiveCheckTask;
    assert.equal(h.calls(),1);
    h.messages.pop();h.runtime.store.reconcile();
    assert.equal(h.runtime.state().profiles.a.rank,0);assert.equal(h.runtime.state().profiles.a.history.length,0);
});

test('complete and not-ready MVU reports each avoid an automatic archive request',async t=>{
    const h=await autoArchiveFixture(t);
    await h.turn({body:'她还在犹豫。',event:{ready:false}});await h.runtime.archiveCheckTask;
    assert.equal(h.calls(),0);assert.equal(h.runtime.state().profiles.a.rank,0);
    await h.turn({body:'她决定核对资料，接受有限帮助。',event:h.result});await h.runtime.archiveCheckTask;
    assert.equal(h.calls(),0);assert.equal(h.runtime.state().profiles.a.rank,1);
});

test('an automatic archive save can be retried without another model request',async t=>{
    const h=await autoArchiveFixture(t),persist=h.host.persist;let failing=true;
    h.host.persist=async document=>{
        if(failing && document.journal.at(-1)?.id.startsWith('archive:')) throw new Error('offline');
        return persist(document);
    };
    await h.turn({body:'她决定核对资料，接受有限帮助。'});await h.runtime.archiveCheckTask;
    assert.equal(h.calls(),1);assert.ok(h.runtime.store.pending);assert.equal(h.runtime.state().profiles.a.rank,0);
    assert.equal(h.row().好感度,30);assert.equal(h.row().好感锁定,true);
    failing=false;await h.runtime.store.retrySave();
    assert.equal(h.calls(),1);assert.equal(h.runtime.state().profiles.a.rank,1);
});

test('the MVU contract shows only executable character updates without event payloads',async t=>{
    const h=await fixture(t);h.messages.push({is_user:true,mes:'我来帮你。'});await h.runtime.prepare();
    const contract=h.runtime.variableContract();
    const block=contract.match(/<UpdateVariable>\s*<JSONPatch>\s*([\s\S]*?)\s*<\/JSONPatch>\s*<\/UpdateVariable>/);
    assert.ok(block);const patches=JSON.parse(block[1]);
    assert.ok(patches.some(p=>p.path==='/故事导演/Coop/角色/画家/好感度' && p.value===5));
    assert.ok(!/nonce|completion|eventId|CoopReport|\/Coop\/回报/.test(contract));
});

for(const extra of [false,true]) test('director reports advance and archive without an MVU report namespace, extra='+extra,async t=>{
    const h=await fixture(t,{initial:30,extra});h.write(30,true);await h.runtime.generate('a');
    await h.turn({body:'她拿出旧画册。',event:{evidence:'旧画册'}});
    assert.equal(h.runtime.event().phase,'dilemma');
    const first=h.messages.at(-1);
    assert.ok(!first.mes.includes('<CoopReport>'));assert.equal(first.extra.sdCoopReports.reportProducer,'director');
    assert.equal(first.variables[0].stat_data.故事导演.Coop.回报,undefined);
    await h.turn({body:'她提出疑问，等待用户回应。',event:{evidence:'提出疑问'}});
    h.messages.push({is_user:true,mes:'我愿意帮你核对资料。'});await h.runtime.prepare();
    assert.ok(h.runtime.injection().includes('<CoopReport>'));
    assert.ok(h.runtime.injection().includes(h.runtime.snapshot.nonce));
    assert.ok(!/nonce|eventId|completion|CoopReport/.test(h.runtime.variableContract()));
    h.messages.pop();
    await h.turn({body:'她接受有限帮助，决定核对资料。',event:{ready:true,evidence:'接受有限帮助',completion:{
        summary:'用户愿意共同核对资料，她接受有限帮助，保留自己的判断，后续展览仍待准备。',outcome:'接受帮助核对资料',outcomeEvidence:'核对资料',
        choice:'愿意帮忙',choiceEvidence:'愿意帮你',traits:['接受帮助'],facts:[],boundaries:[],openHooks:[],closedHooks:[]}}});
    assert.equal(h.runtime.state().profiles.a.rank,1);assert.equal(h.row().好感度,30);assert.equal(h.row().好感锁定,true);
    assert.equal(h.messages.at(-1).variables[0].stat_data.故事导演.Coop.回报,undefined);
    await h.runtime.load();await h.runtime.afterMessage(h.messages.length-1);
    assert.equal(h.runtime.state().profiles.a.rank,1);assert.equal(h.runtime.state().profiles.a.history.length,1);
    h.messages.pop();h.runtime.store.reconcile();
    assert.equal(h.runtime.state().profiles.a.rank,0);assert.equal(h.runtime.state().profiles.a.history.length,0);
});

test('a new director turn clears legacy MVU reports while keeping character values and wrappers',async t=>{
    const h=await fixture(t),data=h.messages[0].variables[0],row=h.row();
    row.好感度=[9,'说明'];data.stat_data.故事导演.Coop.回报={nonce:'old',event:{completion:{summary:'很长的旧摘要'}}};
    await h.turn();await h.runtime.syncMvu();
    assert.equal(h.messages.at(-1).variables[0].stat_data.故事导演.Coop.回报,undefined);
    assert.deepEqual(h.row().好感度,[9,'说明']);
    const current=h.api.getMvuData({type:'chat'}).stat_data.故事导演.Coop;
    assert.equal(current.回报,undefined);assert.equal(h.runtime.state().profiles.a.affinity,9);
});

for(const extra of [false,true]) test('a new event accepts only director reports and ignores MVU transport, extra='+extra,async t=>{
    const h=await fixture(t,{initial:30,extra});h.write(30,true);await h.runtime.generate('a');
    h.messages.push({is_user:true,mes:'我问起那本旧画册。'});await h.runtime.prepare();
    const snapshot=h.runtime.snapshot,report={nonce:snapshot.nonce,event:{eventId:snapshot.event.id,characterId:'a',
        eventVersion:snapshot.event.version,phase:'hook',evidence:'旧画册'}};
    h.messages.push({is_user:false,mes:'她拿出旧画册。'});const index=h.messages.length-1;
    await h.runtime.afterMessage(index);
    await h.runtime.receiveMvu({stat_data:{故事导演:{Coop:{回报:report}}}});
    assert.equal(h.runtime.event().phase,'hook');
    h.messages[index].mes+='<CoopReport>'+JSON.stringify(report)+'</CoopReport>';
    await h.runtime.afterMessage(index);assert.equal(h.runtime.event().phase,'dilemma');
    assert.equal(h.messages[index].extra.sdCoopReports.reportProducer,'director');
});

test('event design reads the latest editable template on every request without a second model call',async t=>{
    const h=await fixture(t,{initial:30});h.write(30,true);let style='旧车站',calls=0;
    h.host.designTemplates=async()=>({rules:'克制叙事',blueprint:style});
    const ask=h.host.ask;h.host.ask=async(messages,signal)=>{calls++;assert.ok(messages[0].content.includes('克制叙事'));
        assert.ok(messages[1].content.includes(style));return ask(messages,signal);};
    await h.runtime.generate('a');assert.equal(calls,1);
    const id=h.runtime.event().id;await h.runtime.pause('a',id);style='修复钟表';
    await h.runtime.generate('a',{replanEventId:id});assert.equal(calls,2);
});

test('an invalid old MVU event report is rejected once, including after reload; corrected evidence remains usable',async t=>{
    const h=await fixture(t,{initial:30,legacy:true});h.write(30,true);await h.runtime.generate('a');
    await h.turn({body:'她拿出旧画册。',event:{phase:'hook',evidence:'我愿意帮你核对资料。'}});
    const old=clone(h.messages[2].extra.sdCoopReports.reports[0]);
    const count=()=>h.runtime.notices.filter(x=>x.code==='INVALID_EVIDENCE').length;
    assert.equal(count(),1);assert.equal(h.runtime.event().phase,'hook');
    await h.turn({body:'她继续整理档案。'});
    await h.runtime.receiveMvu(clone(h.messages[2].variables[0]));
    await h.runtime.load();await h.runtime.receiveMvu(clone(h.messages[2].variables[0]));
    assert.equal(count(),1);assert.equal(h.runtime.event().phase,'hook');
    old.event.evidence='旧画册';await h.runtime.receive(2,old);
    assert.equal(h.runtime.event().phase,'dilemma');
    assert.equal(h.row().好感度,30);assert.equal(h.row().好感锁定,true);
});

test('failed event saves are not cached as rejected reports and remain retryable',async t=>{
    const h=await fixture(t,{initial:30});h.write(30,true);await h.runtime.generate('a');
    h.saveFailure(true);
    await h.turn({body:'她拿出旧画册。',event:{phase:'hook',evidence:'旧画册'}});
    assert.ok(h.runtime.store.pending);assert.equal(h.messages[2].extra.sdCoopEventRejections,undefined);
    h.saveFailure(false);await h.runtime.store.retrySave();
    assert.equal(h.runtime.event().phase,'dilemma');
});
test('MVU data remains accessible through TavernHelper when the Mvu global is absent',async()=>{
    let variables={stat_data:{故事导演:{Coop:{角色:{画家:{好感度:9,好感锁定:false}}}}}},target;
    const helper={getVariables:options=>{target=options;return clone(variables);},replaceVariables:(data,options)=>{target=options;variables=clone(data);}};
    const hostWindow={TavernHelper:helper},api=mvuApiFor(hostWindow);
    assert.strictEqual(mvuApiFor(hostWindow),api);
    const data=api.getMvuData({type:'message',message_id:3});data.stat_data.故事导演.Coop.角色.画家.好感度=10;
    await api.replaceMvuData(data,{type:'message',message_id:3});
    assert.equal(variables.stat_data.故事导演.Coop.角色.画家.好感度,10);assert.deepEqual(target,{type:'message',message_id:3});
    const native={getMvuData(){},replaceMvuData(){}};hostWindow.Mvu=native;
    assert.strictEqual(mvuApiFor(hostWindow),native);
    assert.equal(mvuApiFor({}),null);
});
test('MVU values and lock flags survive metadata synchronization and manual changes',async t=>{
    const h=await fixture(t);h.write(46,true);
    await h.runtime.syncMvu();
    assert.equal(h.row().好感度,46);assert.equal(h.row().好感锁定,true);
    assert.equal(h.runtime.state().profiles.a.affinity,46);
    h.write(12,false);await h.runtime.syncMvu();
    assert.equal(h.runtime.state().profiles.a.lock,null);assert.equal(h.row().好感度,12);
    assert.ok(h.runtime.store.document.journal.every(op=>op.kind!=='affinity' && op.kind!=='activate'));
});
test('an empty new user floor reads the preceding MVU snapshot and injects direct named fields',async t=>{
    const h=await fixture(t,{name:'画家/~甲'});h.write(9,false);
    h.messages.push({is_user:true,mes:'我来帮你。'});await h.runtime.prepare();
    const contract=h.runtime.variableContract();
    assert.equal(h.runtime.state().profiles.a.affinity,9);
    assert.ok(contract.includes('/故事导演/Coop/角色/画家~1~0甲/好感度'));
    assert.ok(contract.includes('好感锁定'));assert.ok(contract.includes('MVU 为唯一来源'));
    assert.ok(!contract.includes('"delta"'));assert.ok(!contract.includes('"nonce"'));
});
test('MVU updates do not append score operations and historical edits do not revoke the current value',async t=>{
    const h=await fixture(t);
    await h.turn({value:7,locked:false});await h.turn({value:9,locked:false});
    h.messages[1].mes='用户改写了早先的互动。';h.runtime.store.reconcile();
    await h.runtime.load();await h.runtime.syncMvu();
    assert.equal(h.row().好感度,9);assert.equal(h.runtime.state().profiles.a.affinity,9);
    assert.equal(h.runtime.store.document.journal.length,0);
});
test('the before-write hook cannot replace MVU affinity or unlock it from a stale director state',async t=>{
    const h=await fixture(t),live=clone(h.messages[0].variables[0]);
    Object.assign(live.stat_data.故事导演.Coop.角色.画家,{好感度:30,好感锁定:true});
    h.runtime.syncMvu.updateLive(live);
    assert.equal(live.stat_data.故事导演.Coop.角色.画家.好感度,30);
    assert.equal(live.stat_data.故事导演.Coop.角色.画家.好感锁定,true);
});
test('renaming a profile moves its MVU row without losing the MVU score or lock',async t=>{
    const h=await fixture(t);h.write(18,true);
    await h.runtime.configure({id:'a',name:'新称呼',mode:'coop'});await h.runtime.syncMvu();
    const roles=h.messages[0].variables[0].stat_data.故事导演.Coop.角色;
    assert.equal(roles.新称呼.好感度,18);assert.equal(roles.新称呼.好感锁定,true);assert.equal(roles.画家,undefined);
});
test('over-100 MVU values read as 100 and are saved with wrappers and lock intact',async t=>{
    const h=await fixture(t),row=h.row();
    row.好感度=[[101.5,'内层说明'],'好感说明'];row.好感锁定=[true,'锁定说明'];
    const profile=h.runtime.state().profiles.a;
    assert.equal(profile.affinity,100);assert.equal(profile.mvuReady,true);assert.equal(profile.lock.lockedValue,100);
    assert.deepEqual(row.好感度,[[101.5,'内层说明'],'好感说明']);
    await h.runtime.syncMvu();
    assert.deepEqual(h.row().好感度,[[100,'内层说明'],'好感说明']);
    assert.deepEqual(h.row().好感锁定,[true,'锁定说明']);
});
test('MVU update hooks clamp the updated value before the new floor is saved',async t=>{
    const h=await fixture(t),live=clone(h.messages[0].variables[0]);
    live.stat_data.故事导演.Coop.角色.画家.好感度=120;
    live.stat_data.故事导演.Coop.角色.画家.好感锁定=false;
    live.stat_data.故事导演.Coop.角色.画家.额外信息='原样保留';
    live.stat_data.故事导演.Coop.角色.其他角色={好感度:120};
    const updating=h.runtime.receiveMvu(live);
    assert.equal(live.stat_data.故事导演.Coop.角色.画家.好感度,100);
    assert.equal(live.stat_data.故事导演.Coop.角色.画家.好感锁定,false);
    assert.equal(live.stat_data.故事导演.Coop.角色.画家.额外信息,'原样保留');
    assert.deepEqual(live.stat_data.故事导演.Coop.角色.其他角色,{好感度:120});
    await updating;
    live.stat_data.故事导演.Coop.角色.画家.好感度=101;
    h.runtime.syncMvu.updateLive(live);
    assert.equal(live.stat_data.故事导演.Coop.角色.画家.好感度,100);
});
test('capping one managed character preserves other characters and their locks',()=>{
    const state=initialState({a:{id:'a',name:'画家'},b:{id:'b',name:'医生'}});
    const data={stat_data:{故事导演:{Coop:{角色:{
        画家:{角色ID:'a',好感度:150,好感锁定:true},医生:{角色ID:'b',好感度:80,好感锁定:false}},回报:null}}}};
    assert.equal(mergeCoopMvu(data,state,{authority:true}),true);
    const roles=data.stat_data.故事导演.Coop.角色;
    assert.equal(roles.画家.好感度,100);assert.equal(roles.画家.好感锁定,true);
    assert.equal(roles.医生.好感度,80);assert.equal(roles.医生.好感锁定,false);
    assert.equal(mergeCoopMvu(data,state,{authority:true}),false);
});
test('valid MVU values are preserved while other invalid values remain errors',async t=>{
    const h=await fixture(t);
    for(const value of [99,100]) {
        h.write(value,false);await h.runtime.syncMvu();
        assert.equal(h.row().好感度,value);assert.equal(h.runtime.state().profiles.a.affinity,value);
    }
    for(const value of [-1,99.5,'101']) {
        h.write(value,true);await h.runtime.syncMvu();
        assert.equal(h.row().好感度,value);assert.equal(h.runtime.state().profiles.a.mvuReady,false);
        assert.match(h.runtime.state().profiles.a.mvuError,/0～100/);
        await assert.rejects(h.runtime.generate('a'),{code:'NOT_READY'});
    }
});
test('deleting a capped floor restores the previous MVU snapshot',async t=>{
    const h=await fixture(t);await h.turn({value:20,locked:false});
    await h.turn({value:120,locked:false});
    assert.equal(h.row().好感度,100);assert.equal(h.runtime.state().profiles.a.affinity,100);
    h.messages.splice(3);h.runtime.store.reconcile();await h.runtime.syncMvu();
    assert.equal(h.row().好感度,20);assert.equal(h.runtime.state().profiles.a.affinity,20);
});
test('MVU unavailability never falls back to applying legacy affinity reports',async t=>{
    const h=await fixture(t);h.host.mvu=()=>null;
    h.messages.push({is_user:true,mes:'我愿意帮你核对资料。'});await h.runtime.prepare();
    const report={nonce:h.runtime.snapshot.nonce,affinity:[{characterId:'a',delta:5,reason:'接受帮助',userEvidence:'帮你',evidence:'放心'}]};
    h.messages.push({is_user:false,mes:'她放心地交给你资料。<CoopReport>'+JSON.stringify(report)+'</CoopReport>'});
    await h.runtime.afterMessage(h.messages.length-1);
    assert.equal(h.runtime.store.document.journal.length,0);
    assert.equal(h.runtime.state().profiles.a.mvuReady,false);
});

test('a surviving duplicate-name row is identified by its stable ID rather than a deleted namesake',()=>{
    const state=initialState({b:{id:'b',name:'画家'}}),data={stat_data:{故事导演:{Coop:{角色:{
        画家:{角色ID:'a',好感度:7,好感锁定:false},画家_2:{角色ID:'b',好感度:11,好感锁定:true}}}}}};
    mergeCoopMvu(data,state,{authority:true});
    assert.equal(data.stat_data.故事导演.Coop.角色.画家.角色ID,'b');
    assert.equal(data.stat_data.故事导演.Coop.角色.画家.好感度,11);
});

async function completeCurrent(h) {
    if(!h.runtime.event()) await h.runtime.generate('a');
    const rank=h.runtime.event().targetRank;
    await h.turn({body:'她拿出旧画册。',event:{evidence:'旧画册'}});
    await h.turn({body:'她提出疑问，等待用户回应。',event:{evidence:'提出疑问'}});
    await h.turn({body:'她接受有限帮助，决定先核对资料。',event:{evidence:'接受有限帮助',completion:{
        summary:'用户愿意一起核对资料，她接受有限的实际帮助并保留自己的判断，展览的问题留待后续处理。',
        outcome:'核对资料',outcomeEvidence:'核对资料',choice:'愿意帮忙',choiceEvidence:'愿意帮你',
        traits:['第'+rank+'阶成长'],facts:['第'+rank+'阶事实'],boundaries:[],openHooks:[],closedHooks:[],
        sharedFacts:[{entityId:'fact-'+rank,fact:'第'+rank+'阶事实',evidence:'核对资料',knownBy:['a']}]}}});
}

test('existing legacy rank archives remain valid when switching to MVU ownership',async t=>{
    const h=await fixture(t,{initial:30,authority:false});await completeCurrent(h);
    assert.equal(h.runtime.state().profiles.a.rank,1);
    h.runtime.dispose();h.host.affinityAuthority='mvu';
    const migrated=new CoopRuntime(h.host);t.after(()=>migrated.dispose());await migrated.load();
    assert.equal(migrated.state().profiles.a.rank,1);assert.equal(migrated.state().profiles.a.history.length,1);
    assert.equal(migrated.state().profiles.a.affinity,30);
});

test('deleting the creation floor removes the event and reads affinity from the preceding MVU floor',async t=>{
    const h=await fixture(t);await h.turn({value:30,locked:true});await h.runtime.generate('a');
    const event=clone(h.runtime.event()),anchor=h.messages.at(-1).sd_coop_id;
    assert.deepEqual(event.createdAt,{id:anchor,index:2});
    h.messages.splice(2);h.runtime.store.reconcile();await h.runtime.store.pruneEvents();
    assert.equal(h.runtime.event(),null);assert.deepEqual(h.runtime.state().profiles.a.events,{});
    assert.equal(h.runtime.state().profiles.a.seeds,null);assert.equal(h.runtime.state().profiles.a.affinity,5);
    assert.equal(h.runtime.state().profiles.a.lock,null);
    assert.ok(h.runtime.store.document.journal.every(op=>op.data?.eventId!==event.id));
    assert.ok(h.metadata.storyDirectorCoop.journal.every(op=>op.data?.eventId!==event.id));
});

test('bulk deletion clears multiple dependent ranks, summaries, growth and cached reports',async t=>{
    const h=await fixture(t,{initial:29});h.write(30,true);await completeCurrent(h);
    await h.turn({locked:false});h.write(60,true);await h.runtime.generate('a');
    const second=clone(h.runtime.event());await completeCurrent(h);
    await h.turn({locked:false});h.write(90,true);await h.runtime.generate('a');
    const third=clone(h.runtime.event());
    h.runtime.store.document.summaryEdits={[second.id]:{summary:'待清理的第二阶摘要修正'}};
    h.messages[0].extra={sdCoopSnapshot:{event:{id:third.id}},sdCoopReports:{reports:[{event:{eventId:second.id}}]}};
    h.runtime.snapshots.set('old',{event:{id:third.id}});h.runtime.pendingMvuReports.set('old',{event:{eventId:third.id}});
    h.messages.splice(second.createdAt.index);h.runtime.store.reconcile();await h.runtime.store.pruneEvents();
    const p=h.runtime.state().profiles.a;
    assert.equal(p.rank,1);assert.equal(p.history.length,1);assert.equal(Object.keys(p.events).length,1);
    assert.equal(p.affinity,30);assert.equal(h.runtime.event(),null);
    assert.ok(p.traits.includes('第1阶成长'));assert.ok(!p.traits.includes('第2阶成长'));
    assert.ok(p.facts.includes('第1阶事实'));assert.ok(!p.facts.includes('第2阶事实'));
    assert.equal(h.runtime.state().sharedFacts['fact-2'],undefined);
    assert.ok(h.runtime.store.document.journal.every(op=>![second.id,third.id].includes(op.data?.eventId)));
    assert.equal(h.runtime.store.document.summaryEdits[second.id],undefined);
    assert.equal(h.messages[0].extra.sdCoopSnapshot.event,null);
    assert.equal(h.messages[0].extra.sdCoopReports.reports[0].event,undefined);
    assert.equal(h.runtime.snapshots.get('old').event,null);assert.equal(h.runtime.pendingMvuReports.has('old'),false);
    await h.runtime.load();assert.equal(h.runtime.state().profiles.a.rank,1);
});

test('renumbering retained creation floors does not delete their events',async t=>{
    const h=await fixture(t,{initial:29});h.write(30,true);
    h.messages.unshift({is_system:true,mes:'与事件无关的旧系统楼层。'});
    await h.runtime.generate('a');const event=clone(h.runtime.event());
    assert.equal(event.createdAt.index,1);
    h.messages.splice(0,1);h.runtime.store.reconcile();await h.runtime.store.pruneEvents();
    assert.equal(h.runtime.event().id,event.id);assert.equal(h.runtime.event().createdAt.index,1);
    assert.equal(h.messages[0].sd_coop_id,event.createdAt.id);
});

test('temporarily excluding a reply for regeneration does not physically delete its event',async t=>{
    const h=await fixture(t,{initial:29});h.write(30,true);await h.runtime.generate('a');
    const event=clone(h.runtime.event()),source=h.runtime.store.sources().get(event.createdAt.id);
    h.runtime.store.excluded.set(source.id,source.version);h.runtime.store.reconcile();await h.runtime.store.pruneEvents();
    assert.ok(h.runtime.store.document.journal.some(op=>op.data.eventId===event.id));
    h.runtime.store.excluded.clear();h.runtime.store.reconcile();assert.equal(h.runtime.event().id,event.id);
});

test('event cleanup remains retryable when saving after floor deletion fails',async t=>{
    const h=await fixture(t);await h.turn({value:30,locked:true});await h.runtime.generate('a');
    const event=clone(h.runtime.event());h.saveFailure(true);
    h.messages.splice(event.createdAt.index);h.runtime.store.reconcile();await h.runtime.store.pruneEvents();
    assert.ok(h.runtime.store.pending);assert.match(h.runtime.store.error.message,/offline/);
    assert.equal(h.runtime.event(),null);
    h.saveFailure(false);await h.runtime.store.retrySave();
    assert.ok(h.runtime.store.document.journal.every(op=>op.data.eventId!==event.id));
    await h.runtime.load();assert.equal(h.runtime.event(),null);
});

test('a chat switch cannot make another chat look like deleted origin floors',async t=>{
    const h=await fixture(t,{initial:29});h.write(30,true);await h.runtime.generate('a');
    const before=clone(h.runtime.store.document);
    h.host.scope=()=> 'other-chat';h.messages.splice(0);
    h.runtime.store.reconcile();assert.deepEqual(await h.runtime.store.pruneEvents(),[]);
    assert.deepEqual(h.runtime.store.document,before);assert.equal(h.runtime.store.pending,null);
});

test('deleting the origin floor cancels an in-flight event design and rejects its late result',async t=>{
    const h=await fixture(t);await h.turn({value:30,locked:true});
    const raw=await h.host.ask();let release,entered;
    const started=new Promise(resolve=>{entered=resolve;});
    h.host.ask=async()=>{entered();return new Promise(resolve=>{release=resolve;});};
    const generating=h.runtime.generate('a');await started;
    h.messages.splice(2);h.runtime.store.reconcile();assert.equal(h.runtime.job,null);
    release(raw);await assert.rejects(generating,{code:'STALE_TASK'});
    assert.equal(h.runtime.store.document.journal.length,0);
});

test('deleting a floor used by an in-flight archive recovery cancels that recovery immediately',async t=>{
    const h=await fixture(t,{initial:29});h.write(30,true);await h.runtime.generate('a');
    await h.turn({body:'她拿出旧画册。',event:{evidence:'旧画册'}});
    await h.turn({body:'她提出疑问，等待用户回应。',event:{evidence:'提出疑问'}});
    await h.turn({body:'她接受有限帮助，决定先核对资料。',event:{evidence:'接受有限帮助'}});
    assert.equal(h.runtime.event().phase,'resolution');
    let release,entered;const started=new Promise(resolve=>{entered=resolve;});
    h.host.ask=async()=>{entered();return new Promise(resolve=>{release=resolve;});};
    const recovering=h.runtime.recoverArchive();await started;
    h.messages.pop();h.runtime.store.reconcile();assert.equal(h.runtime.job,null);
    release('{"ready":false}');await assert.rejects(recovering,{code:'STALE_TASK'});
});

test('deleted event pruning cascades within one character and preserves independent characters',()=>{
    const plan=(id,characterId,targetRank,anchor)=>({kind:'plan',characterId,data:{eventId:id,plan:{targetRank},createdAt:{id:anchor,index:10}},refs:[]});
    const document={journal:[plan('a1','a',1,'deleted'),plan('a2','a',2,'kept-a'),plan('b1','b',1,'kept-b'),
        {kind:'beat',characterId:'a',data:{eventId:'a2'}},{kind:'affinity',affinityHistory:['a1'],data:{}}],
        summaryEdits:{a1:{},a2:{},b1:{}}};
    const sources=new Map([['kept-a',{}],['kept-b',{}]]);
    assert.deepEqual([...deletedEventIds(document,sources)],['a1','a2']);
    pruneDeletedEvents(document,sources);
    assert.deepEqual(document.journal.map(op=>op.data.eventId),['b1']);
    assert.deepEqual(Object.keys(document.summaryEdits),['b1']);
});

for(const unlockInCompletion of [false,true]) test('MVU gates retain event archives across reload, early unlock='+unlockInCompletion,async t=>{
    const h=await fixture(t,{initial:29});h.write(30,true);await h.runtime.generate('a');
    assert.equal(h.runtime.event().phase,'hook');
    await h.turn({body:'她拿出旧画册。',event:{evidence:'旧画册'}});
    await h.turn({body:'她提出疑问，等待用户回应。',event:{evidence:'提出疑问'}});
    assert.equal(h.runtime.event().phase,'waiting_user');
    await h.turn({body:'她接受有限帮助，决定先核对资料。',locked:!unlockInCompletion,event:{evidence:'接受有限帮助',
        completion:{summary:'用户愿意一起核对资料，她接受有限的实际帮助并保留自己的判断，展览的问题留待后续处理。',
            outcome:'核对资料',outcomeEvidence:'核对资料',choice:'愿意帮忙',choiceEvidence:'愿意帮你',
            traits:['接受有限帮助'],facts:[],boundaries:[],openHooks:[],closedHooks:[]}}});
    assert.equal(h.runtime.state().profiles.a.rank,1);
    assert.equal(h.row().好感度,30);assert.equal(h.row().好感锁定,!unlockInCompletion);
    if(!unlockInCompletion) {
        assert.equal(h.runtime.state().profiles.a.unlockAfterArchive,true);
        await h.turn({locked:false});
    }
    await h.runtime.load();
    assert.equal(h.runtime.state().profiles.a.rank,1);assert.equal(h.runtime.state().profiles.a.history.length,1);
    assert.equal(h.runtime.state().profiles.a.affinity,30);assert.equal(h.runtime.state().profiles.a.lock,null);
    assert.ok(h.runtime.store.document.journal.every(op=>op.kind!=='affinity'));
});

test('direct affinity and lock commands reach MVU while event-owned fields remain protected',t=>{
    setCoopMvuAuthority(true);setCoopScene(true);t.after(()=>{setCoopMvuAuthority(false);setCoopScene(false);});
    const commands=['好感度','好感锁定','Rank'].map(field=>({type:'set',args:['故事导演.Coop.角色["画家"].'+field,'30']}));
    const data={故事导演:{Coop:{角色:{画家:{好感度:5,好感锁定:false,Rank:0}}}}};
    applyNsCommands(data,commands);
    assert.deepEqual(commands.map(command=>command.args[0]),['故事导演.Coop.角色["画家"].好感度','故事导演.Coop.角色["画家"].好感锁定']);
    assert.equal(data.故事导演.Coop.角色.画家.Rank,0);
});
