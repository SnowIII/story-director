import test from 'node:test';
import assert from 'node:assert/strict';
import {CoopRuntime} from '../coop/runtime.js';
import {clone,initialState,activateGate,adoptPlan,pauseEvent,assertState} from '../coop/model.js';

const plan=p=>({targetRank:p.rank+1,rounds:2,title:'核对旧画册',scene:'画室',conflict:'资料真伪尚未查明',goal:'完成核对并解除眼前误会',
    hook:'她拿出旧画册',dilemma:'她询问是否一起核对',question:'你愿意帮忙吗？',resolution:'实际核对资料并确认结果后结束现场',
    seeds:p.seeds || {persona:'画家',desire:'展览',shadow:'怕否定',friction:'导师'},usedHistory:p.history.map(h=>h.eventId),references:[],conflicts:[]});
const closed=evidence=>({goalAchieved:true,closed:true,awaitingUser:false,blockingConflicts:[],evidence});
const completion=(scene=closed('核对完毕'))=>({summary:'用户愿意共同核对画册资料，两人完成核对并澄清眼前误会。她接受有限帮助，约定下次再准备展览，当前现场已经告一段落。',
    outcome:'核对资料并澄清误会',outcomeEvidence:'核对',choice:'愿意帮忙',choiceEvidence:'愿意帮你',traits:['主动核实信息'],facts:[],boundaries:[],openHooks:['后续展览'],closedHooks:[],scene});

async function fixture(t) {
    const messages=[{is_user:true,mes:'我想先了解画册。'}],metadata={};let calls=0,automatic=false,runtime;
    const host={scope:()=> 'serialized',metadata:()=>metadata,messages:()=>messages,
        context:()=>({extensionSettings:{mvu_settings:{更新方式:'随AI输出'}}}),available:()=>true,contextText:async()=> '画室',
        autoAllowed:()=>automatic,locks:{request:async(name,options,fn)=>fn({name})},
        persist:async doc=>{metadata.storyDirectorCoop=clone(doc);},
        ask:async()=>{calls++;return JSON.stringify(plan(runtime.state().profiles[runtime.job.characterId]));}};
    runtime=new CoopRuntime(host);await runtime.load();t.after(()=>runtime.dispose());
    for(const id of ['a','b']) await runtime.configure({id,name:'画家'+id,mode:'coop',rankCount:4,initialAffinity:30});
    await runtime.configureSettings({eventRounds:2});
    async function turn(body,reportEvent=null,user='我愿意帮你核对资料。',sceneClearance=null) {
        messages.push({is_user:true,mes:user});await runtime.prepare();
        const snapshot=runtime.snapshot, report={nonce:snapshot.nonce,affinity:[],...(snapshot.sceneCheckRequired?{sceneClearance:sceneClearance || closed(body)}:{}),...(reportEvent?{event:{...snapshot.event,
            eventId:snapshot.event.id,eventVersion:snapshot.event.version,evidence:'核对',...reportEvent}}:{})};
        messages.push({is_user:false,mes:body+'<UpdateVariable><JSONPatch>'+JSON.stringify([{op:'add',path:'/故事导演/Coop/回报',value:report}])+'</JSONPatch></UpdateVariable>'});
        await runtime.afterMessage(messages.length-1);
    }
    async function start() {await runtime.generate('a');await turn('她拿出画册，询问是否一起核对。',{},'我问起画册。');}
    return {runtime,host,messages,metadata,turn,start,calls:()=>calls,auto:value=>{automatic=value;}};
}

test('paused unfinished Rank keeps the global queue and blocks both automatic and manual starts',async t=>{
    const h=await fixture(t);await h.start();const eventId=h.runtime.event().id;
    await h.runtime.pause('a',eventId);h.auto(true);await h.runtime.maybeAuto();
    assert.equal(h.calls(),1,'paused A must not generate B');
    await assert.rejects(h.runtime.generate('b'),{code:'SCENE_BUSY'});
    await h.runtime.resume('a',eventId);assert.equal(h.runtime.event().id,eventId);
});

test('the model itself refuses a second plan while the first Rank is paused',()=>{
    const state=initialState({a:{id:'a',name:'A',mode:'coop',initialAffinity:30},b:{id:'b',name:'B',mode:'coop',initialAffinity:30}});
    for(const id of ['a','b']) activateGate(state,id,id);
    adoptPlan(state,{characterId:'a',eventId:'event-a',gateId:state.profiles.a.lock.id,plan:plan(state.profiles.a)});
    pauseEvent(state,'a','event-a');
    assert.throws(()=>adoptPlan(state,{characterId:'b',eventId:'event-b',gateId:state.profiles.b.lock.id,plan:plan(state.profiles.b)}),{code:'SCENE_BUSY'});
});

test('the state invariant detects two unpaused unfinished Rank events',()=>{
    const state=initialState({a:{id:'a',name:'A',mode:'coop',initialAffinity:30},b:{id:'b',name:'B',mode:'coop',initialAffinity:30}});
    for(const id of ['a','b']) activateGate(state,id,id);
    adoptPlan(state,{characterId:'a',eventId:'event-a',gateId:state.profiles.a.lock.id,plan:plan(state.profiles.a)});
    pauseEvent(state,'a','event-a');
    adoptPlan(state,{characterId:'b',eventId:'event-b',gateId:state.profiles.b.lock.id,plan:plan(state.profiles.b)},{replay:true});
    state.profiles.a.events['event-a'].paused=false;
    assert.throws(()=>assertState(state),{code:'INVALID_ACTIVE_EVENT'});
});

for(const [name,scene] of [
    ['the immediate objective is not achieved',{...closed('核对'),goalAchieved:false}],
    ['the scene is still open',{...closed('核对'),closed:false}],
    ['the next crucial user choice is pending',{...closed('核对'),awaitingUser:true}],
    ['an immediate conflict remains',{...closed('核对'),blockingConflicts:['现场救援仍在进行']}],
    ['the closure quote was invented',closed('不存在的收束原文')],
    ['the closure report is missing',null],
]) test('ready:true cannot end the Rank when '+name,async t=>{
    const h=await fixture(t);await h.start();
    await h.turn('她开始核对资料，仍在等待你的下一步决定。',{ready:true,completion:completion(scene)});
    assert.equal(h.runtime.state().profiles.a.rank,0);
    assert.ok(h.runtime.state().profiles.a.lock);
    assert.equal(h.runtime.event()?.characterId,'a');
    assert.equal(h.runtime.event()?.phase,'resolution');
    assert.equal(Object.keys(h.runtime.state().profiles.b.events).length,0);
});

test('valid completion archives once but does not start another Rank in the same interaction',async t=>{
    const h=await fixture(t);await h.start();h.auto(true);
    await h.turn('两人核对完毕，误会澄清，离开画室。',{ready:true,completion:completion()});
    assert.equal(h.runtime.state().profiles.a.rank,1);assert.equal(h.runtime.state().profiles.a.history.length,1);
    assert.equal(h.runtime.event(),null);assert.equal(h.calls(),1,'new Rank must wait for a fresh user interaction');
    await h.runtime.maybeAuto();assert.equal(h.calls(),1);
    await h.turn('第二天她们在街上打招呼。',null,'第二天我去看看另一位画家。');
    assert.equal(h.runtime.event()?.characterId,'b');assert.equal(h.calls(),2);
});

test('a legacy early archive cannot start another Rank while its actual scene is still ongoing',async t=>{
    const h=await fixture(t);await h.start();
    await h.turn('两人核对完毕，误会澄清，离开画室。',{ready:true,completion:completion()});
    // Old versions considered the personal arc done before the surrounding rescue ended.
    delete h.runtime.store.document.journal.at(-1).data.completion.scene;
    h.metadata.storyDirectorCoop=clone(h.runtime.store.document);await h.runtime.load();h.auto(true);
    await h.turn('援军刚到，救援仍在继续，大家等待下一步决定。',null,'我先组织援军。',
        {closed:false,awaitingUser:true,blockingConflicts:['救援尚未结束'],evidence:'救援仍在继续'});
    assert.equal(h.runtime.event(),null);assert.equal(h.calls(),1);
    assert.equal(Object.keys(h.runtime.state().profiles.b.events).length,0);
    await h.turn('救援结束，众人回到安全的画室休息。',null,'等救援结束再回画室。',
        {closed:true,awaitingUser:false,blockingConflicts:[],evidence:'救援结束'});
    assert.equal(h.runtime.event()?.characterId,'b');assert.equal(h.calls(),2);
});

test('a failed archive save keeps the original scene and queue until confirmation',async t=>{
    const h=await fixture(t);await h.start();const persist=h.host.persist;
    h.host.persist=async document=>{if(document.journal.at(-1)?.data?.phase==='resolution') throw new Error('offline');await persist(document);};h.auto(true);
    await h.turn('两人核对完毕，误会澄清，离开画室。',{ready:true,completion:completion()});
    assert.equal(h.runtime.state().profiles.a.rank,0);assert.equal(h.runtime.event()?.characterId,'a');
    assert.equal(h.calls(),1);assert.ok(h.runtime.store.pending);
    h.host.persist=persist;await h.runtime.store.retrySave();await h.runtime.maybeAuto();
    assert.equal(h.runtime.state().profiles.a.rank,1);assert.equal(h.calls(),1);
});
