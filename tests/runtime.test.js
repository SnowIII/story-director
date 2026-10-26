import test from 'node:test';
import assert from 'node:assert/strict';
import {CoopRuntime} from '../coop/runtime.js';
import {clone} from '../coop/model.js';
import {sourceMap} from '../coop/messages.js';
import {STORAGE_KEY} from '../coop/store.js';
function eventPlan(p) {
    return {targetRank:p.rank+1,title:'旧画册',scene:'画室',conflict:'理想与现实',goal:'形成新的应对方式',
        hook:'她带来旧画册',dilemma:'她面对导师的疑问',question:'你愿意如何面对？',resolution:'依据回应解决眼前的事',
        seeds:p.seeds || {persona:'画家',desire:'举办展览',shadow:'害怕否定',friction:'导师的要求'},
        usedHistory:p.history.map(h=>h.eventId),references:[],conflicts:[]};
}
async function setup(t,{extra=false,save=null,locks=null}={}) {
    const messages=[],meta={},context={extensionSettings:{mvu_settings:{'更新方式':extra?'额外模型解析':'模型自己输出'}}};
    const persisted=[];let runtime,scope='test-scope';
    const host={scope:()=>scope,metadata:()=>meta,messages:()=>messages,context:()=>context,
        available:()=>true,contextText:async()=>messages.map(m=>m.mes).join('\n'),autoAllowed:()=>false,
        locks:locks || {request:async(name,opts,fn)=>fn({name})},
        persist:async doc=>{if(save) await save(doc);meta[STORAGE_KEY]=clone(doc);persisted.push(clone(doc));},
        ask:async()=>JSON.stringify(eventPlan(Object.values(runtime.state().profiles).find(p=>p.lock)))};
    runtime=new CoopRuntime(host);await runtime.load();
    t.after(()=>runtime.dispose());
    const configure=(mode='coop',initialAffinity=29)=>runtime.configure({id:'a',name:'画家',description:'有自己的画室',mode,initialAffinity});
    async function reply(body,proposal={}) {
        const snapshot=runtime.snapshot;
        const report={nonce:snapshot.nonce,affinity:[],...proposal};
        const message={is_user:false,name:'画家',mes:body+(extra?'':'<CoopReport>'+JSON.stringify(report)+'</CoopReport>')};
        messages.push(message);const index=messages.length-1;
        await runtime.afterMessage(index);
        if(extra) await runtime.receiveMvu({stat_data:{'故事导演':{Coop:{'回报':report}}}});
        return index;
    }
    async function send(user,body,proposal={}) {
        messages.push({is_user:true,mes:user});await runtime.prepare();
        const input=typeof proposal==='function'?proposal(runtime.snapshot):proposal;
        return reply(body,input);
    }
    const score=delta=>({affinity:[{characterId:'a',delta,reason:'实际支持',userEvidence:'帮你',evidence:'放松'}]});
    return {runtime,host,messages,meta,persisted,configure,send,reply,score,setScope:value=>{scope=value;}};
}
async function unlockAndStart(h) {
    await h.configure();await h.send('我来帮你。','她放松了。',h.score(1));
    await h.runtime.generate('a');
}
async function progressToResolution(h) {
    await h.send('我问起画册。','她带来了旧画册。',snapshot=>({event:{...snapshot.event,eventId:snapshot.event.id,phase:'hook',eventVersion:snapshot.event.version,evidence:'旧画册'}}));
    await h.send('我继续听她说。','她提出疑问，等待回应。',snapshot=>({event:{...snapshot.event,eventId:snapshot.event.id,phase:'dilemma',eventVersion:snapshot.event.version,evidence:'等待回应'}}));
    assert.equal(h.runtime.event().phase,'waiting_user');
}
test('runtime default empty roster produces no score or model call',async t=>{
    const h=await setup(t);let calls=0;h.host.ask=async()=>{calls++;};
    await h.send('我来帮你。','她放松了。',{affinity:[{characterId:'stranger',delta:5,evidence:'放松',userEvidence:'帮你'}]});
    assert.equal(Object.keys(h.runtime.state().profiles).length,0);assert.equal(calls,0);
});
for(const extra of [false,true]) test('end-to-end rank completion and persistent summary, extra='+extra,async t=>{
    const h=await setup(t,{extra});await unlockAndStart(h);
    assert.equal(h.runtime.state().profiles.a.affinity,30);assert.ok(h.runtime.state().profiles.a.lock);
    await progressToResolution(h);
    await h.send('我愿意帮你核对资料。','她决定先核对资料，接受了有限的帮助。',snapshot=>({
        affinity:[{characterId:'a',delta:5,reason:'支持',userEvidence:'帮你',evidence:'接受'}],
        event:{eventId:snapshot.event.id,characterId:'a',eventVersion:snapshot.event.version,phase:'resolution',evidence:'核对资料',
            completion:{summary:'她坦白对导师要求的顾虑，用户愿意一起核对资料。她接受了有限的帮助，决定保留自己的判断，展览的问题继续推进。',
                outcome:'决定核对资料',outcomeEvidence:'核对资料',choice:'愿意帮忙核对',choiceEvidence:'愿意帮你',
                traits:['紧张时会整理画册'],facts:['旧画册属于她'],boundaries:['愿意接受有限帮助'],openHooks:['展览尚待推进'],closedHooks:[]}}
    }));
    const p=h.runtime.state().profiles.a;
    assert.equal(p.rank,1);assert.equal(p.affinity,30);assert.equal(p.lock,null);assert.equal(p.history.length,1);
    assert.ok(h.meta[STORAGE_KEY].journal.some(op=>op.kind==='beat' && op.data.phase==='resolution'));
    const restarted=new CoopRuntime(h.host);await restarted.load();t.after(()=>restarted.dispose());
    assert.equal(restarted.state().profiles.a.rank,1);assert.equal(restarted.state().profiles.a.history[0].summary,p.history[0].summary);
    // A source edit invalidates completion, its summary and the unlock together.
    h.messages.at(-1).mes='这件事并没有解决。';restarted.store.reconcile();
    assert.equal(restarted.state().profiles.a.rank,0);assert.ok(restarted.state().profiles.a.lock);assert.equal(restarted.state().profiles.a.history.length,0);
});
test('locked pending event rejects negative as well as positive source reports',async t=>{
    const h=await setup(t);await h.configure();await h.send('我来帮你。','她放松了。',h.score(1));
    await h.send('我不会帮你。','她不再放松。',h.score(-5));
    assert.equal(h.runtime.state().profiles.a.affinity,30);assert.equal(h.runtime.state().profiles.a.scoreLog.at(-1).actual,0);
});
test('removing and re-enabling a role preserves its event and gate',async t=>{
    const h=await setup(t);await unlockAndStart(h);
    const eventId=h.runtime.event().id,gate=h.runtime.state().profiles.a.lock.id;
    await h.runtime.configure({...h.runtime.state().profiles.a,mode:'off'});
    assert.equal(h.runtime.event(),null);assert.equal(h.runtime.state().profiles.a.lock.id,gate);
    await h.runtime.configure({...h.runtime.state().profiles.a,mode:'coop'});
    assert.equal(h.runtime.state().profiles.a.events[eventId].paused,true);
    await h.runtime.resume('a',eventId);assert.equal(h.runtime.event().id,eventId);
});
test('save failure does not publish a rank, and an explicit retry is idempotent',async t=>{
    let broken=true;
    const h=await setup(t,{save:async()=>{if(broken) throw new Error('offline');}});
    await assert.rejects(h.configure(),/offline/);
    assert.equal(Object.keys(h.runtime.state().profiles).length,0);assert.ok(h.runtime.store.pending);
    await assert.rejects(h.configure(),{code:'SAVE_PENDING'});
    broken=false;await h.runtime.store.retrySave();
    assert.equal(h.runtime.state().profiles.a.mode,'coop');assert.equal(h.runtime.store.pending,null);
});
test('generation result is rejected after the role is disabled',async t=>{
    const h=await setup(t);await h.configure();await h.send('我来帮你。','她放松了。',h.score(1));
    let release;h.host.ask=()=>new Promise(resolve=>{release=resolve;});
    const pending=h.runtime.generate('a');await new Promise(resolve=>setTimeout(resolve,0));
    const plan=eventPlan(h.runtime.state().profiles.a);
    await h.runtime.configure({...h.runtime.state().profiles.a,mode:'off'});
    release(JSON.stringify(plan));await assert.rejects(pending,{code:'STALE_TASK'});
    assert.equal(Object.keys(h.runtime.state().profiles.a.events).length,0);
});
test('generation is rejected if the visible scene changes while awaiting model',async t=>{
    const h=await setup(t);await h.configure();await h.send('我来帮你。','她放松了。',h.score(1));
    let release;h.host.ask=()=>new Promise(resolve=>{release=resolve;});
    const pending=h.runtime.generate('a');await new Promise(resolve=>setTimeout(resolve,0));
    h.messages.push({is_user:true,mes:'我们已经离开了画室。'});
    const plan=eventPlan(h.runtime.state().profiles.a);
    release(JSON.stringify(plan));await assert.rejects(pending,{code:'STALE_TASK'});
});
test('same-interaction group reply gets a hold instruction, not the next act',async t=>{
    const h=await setup(t);await unlockAndStart(h);
    await h.send('我问起画册。','她带来了旧画册。',snapshot=>({event:{eventId:snapshot.event.id,characterId:'a',eventVersion:snapshot.event.version,phase:'hook',evidence:'旧画册'}}));
    await h.runtime.prepare();
    assert.ok(h.runtime.injection().includes('本次用户互动已推进过一幕'));
    assert.equal(h.runtime.event().phase,'dilemma');
});
test('swiping a scored reply allows the new version to replace, not add to it',async t=>{
    const h=await setup(t);await h.configure('affinity',0);
    const index=await h.send('我来帮你。','她放松了。',h.score(2));
    assert.equal(h.runtime.state().profiles.a.affinity,2);
    h.messages[index].mes='她放松了一些。';h.messages[index].swipe_id=1;
    h.runtime.store.reconcile();await h.runtime.prepare();
    const snapshot=h.runtime.snapshot;
    h.messages[index].mes+='<CoopReport>'+JSON.stringify({nonce:snapshot.nonce,...h.score(1)})+'</CoopReport>';
    await h.runtime.afterMessage(index);
    assert.equal(h.runtime.state().profiles.a.affinity,1);
});
test('thirty distinct chat metadata documents retain independent archives',async t=>{
    const h=await setup(t);await h.configure('affinity',0);
    const first=clone(h.meta[STORAGE_KEY]), records=[];
    for(let i=0;i<30;i++){h.setScope('chat-'+i);delete h.meta[STORAGE_KEY];await h.runtime.load();await h.configure('affinity',i);records.push(clone(h.meta[STORAGE_KEY]));}
    assert.equal(records.length,30);
    h.setScope('test-scope');h.meta[STORAGE_KEY]=first;await h.runtime.load();
    assert.equal(h.runtime.state().profiles.a.affinity,0);assert.equal(h.runtime.state().profiles.a.name,'画家');
});
async function completeFirst(h) {
    await unlockAndStart(h);await progressToResolution(h);
    await h.send('我愿意帮你核对资料。','她决定核对资料，并接受有限帮助。',snapshot=>({event:{
        eventId:snapshot.event.id,characterId:'a',eventVersion:snapshot.event.version,phase:'resolution',evidence:'核对资料',
        completion:{summary:'她说明旧画册和导师要求之间的矛盾。用户愿意一起核对资料，她接受有限帮助，展览的下一步仍需共同面对。',
            outcome:'核对资料并接受帮助',outcomeEvidence:'接受有限帮助',choice:'愿意帮忙',choiceEvidence:'愿意帮你',
            traits:['紧张时整理画册'],facts:['旧画册由她保管'],boundaries:[],openHooks:['展览的下一步'],closedHooks:[]}}}));
}
test('new event request includes every earlier rank summary and unresolved hook',async t=>{
    const h=await setup(t);await completeFirst(h);
    while(h.runtime.state().profiles.a.affinity<60) await h.send('我继续帮你。','她放松了。',h.score(5));
    let request;
    h.host.ask=async messages=>{request=messages;return JSON.stringify(eventPlan(h.runtime.state().profiles.a));};
    await h.runtime.generate('a');
    const history=h.runtime.state().profiles.a.history;
    assert.ok(request[1].content.includes(history[0].summary));assert.ok(request[1].content.includes('展览的下一步'));
    assert.deepEqual(h.runtime.event().plan.usedHistory,[history[0].eventId]);
});
test('correcting an old summary pauses stale plan until remaining acts are redesigned',async t=>{
    const h=await setup(t);await completeFirst(h);
    while(h.runtime.state().profiles.a.affinity<60) await h.send('我继续帮你。','她放松了。',h.score(5));
    await h.runtime.generate('a');const eventId=h.runtime.event().id,history=h.runtime.state().profiles.a.history[0];
    const revised='她与用户共同核对画册资料，明确并非已经与导师决裂。她接受有限帮助，但保留自己的创作判断，展览问题仍未解决。';
    await h.runtime.editSummary('a',history.eventId,revised);
    assert.equal(h.runtime.state().profiles.a.rank,1);assert.equal(h.runtime.state().profiles.a.history[0].summary,revised);
    assert.equal(h.runtime.event(),null);
    await assert.rejects(h.runtime.resume('a',eventId),{code:'HISTORY_CHANGED'});
    await h.runtime.generate('a',{replanEventId:eventId});
    await h.runtime.resume('a',eventId);
    assert.equal(h.runtime.event().id,eventId);assert.equal(h.runtime.state().profiles.a.lock.targetRank,2);
});
test('extra-model report arriving before rendered-message notification is buffered once',async t=>{
    const h=await setup(t,{extra:true});await h.configure('affinity',0);
    h.messages.push({is_user:true,mes:'我来帮你。'});await h.runtime.prepare();
    await h.runtime.receiveMvu({stat_data:{故事导演:{Coop:{回报:{nonce:h.runtime.snapshot.nonce,...h.score(2)}}}}});
    await h.reply('她放松了。',h.score(2));
    assert.equal(h.runtime.state().profiles.a.affinity,2);assert.equal(h.runtime.pendingMvuReports.size,0);
});
test('the same browser chat has only one Coop writer and can hand over the lease',async t=>{
    const held=new Set();
    const locks={request:async(name,options,callback)=>{
        if(held.has(name)) return callback(null);
        held.add(name);try{return await callback({name});}finally{held.delete(name);}
    }};
    const h=await setup(t,{locks}),second=new CoopRuntime({...h.host});t.after(()=>second.dispose());
    await second.load();assert.equal(second.store.readonly,true);
    await assert.rejects(second.configure({id:'b',name:'B',mode:'affinity'}),{code:'READ_ONLY'});
    await h.configure('affinity',0);h.runtime.dispose();
    await new Promise(resolve=>setTimeout(resolve,0));
    await second.load();assert.equal(second.store.readonly,false);assert.ok(second.state().profiles.a);
});
test('overlapping chat loads release the old lease before reacquiring',async t=>{
    const h=await setup(t);await h.configure('affinity',0);
    await Promise.all([h.runtime.load(),h.runtime.load(),h.runtime.load()]);
    assert.equal(h.runtime.store.readonly,false);assert.equal(h.runtime.state().profiles.a.mode,'affinity');
});
test('durable score journal stores source references instead of copying full dialogue',async t=>{
    const h=await setup(t);await h.configure('affinity',0);
    await h.send('我来帮你。','她放松了。',h.score(2));
    const op=h.meta[STORAGE_KEY].journal.find(op=>op.kind==='affinity');
    assert.ok(op.data.source.id);assert.equal(op.data.source.body,undefined);assert.equal(op.data.source.userBody,undefined);
    assert.equal(h.runtime.state().profiles.a.affinity,2);
});
test('missing archive report can be recovered from existing resolution without replaying the scene',async t=>{
    const h=await setup(t);await unlockAndStart(h);await progressToResolution(h);
    await h.send('我愿意帮你核对资料。','她决定核对资料，接受有限帮助。');
    assert.equal(h.runtime.state().profiles.a.rank,0);
    let calls=0;
    h.host.ask=async()=>{
        calls++;return JSON.stringify({ready:true,evidence:'核对资料',completion:{
            summary:'她谈清了画册与导师要求之间的困扰，用户愿意共同核对资料。她接受有限帮助，并保留对创作的判断，展览问题留待后续处理。',
            outcome:'核对资料并接受帮助',outcomeEvidence:'接受有限帮助',choice:'愿意核对资料',choiceEvidence:'愿意帮你',
            traits:['紧张时整理画册'],facts:['她愿意接受有限帮助'],boundaries:[],openHooks:['展览'],closedHooks:[]}});};
    const count=h.messages.length;await h.runtime.recoverArchive();
    assert.equal(calls,1);assert.equal(h.messages.length,count);assert.equal(h.runtime.state().profiles.a.rank,1);
});
test('archive recovery rejects a reply that the model confirms was not complete',async t=>{
    const h=await setup(t);await unlockAndStart(h);await progressToResolution(h);
    await h.send('我愿意帮你。','她还在犹豫。');
    h.host.ask=async()=>JSON.stringify({ready:false,reason:'尚未出现局部结果'});
    await assert.rejects(h.runtime.recoverArchive(),{code:'NOT_COMPLETE'});
    assert.equal(h.runtime.state().profiles.a.rank,0);assert.ok(h.runtime.state().profiles.a.lock);
});

test('display decoration after completion preserves Rank, archive and the unlock across reload',async t=>{
    const h=await setup(t);await completeFirst(h);
    const message=h.messages.at(-1), eventId=h.runtime.state().profiles.a.history[0].eventId;
    message.mes='[igs-img:3]\n'+message.mes+'\n[igs-img:4]';
    h.runtime.store.reconcile();
    assert.equal(h.runtime.state().profiles.a.rank,1);assert.equal(h.runtime.state().profiles.a.lock,null);
    await h.runtime.load();
    assert.equal(h.runtime.state().profiles.a.history[0].eventId,eventId);
    assert.equal(h.runtime.state().profiles.a.rank,1);
});

test('points earned after an invalidated Rank keep their actual arc dependency',async t=>{
    const h=await setup(t);await completeFirst(h);
    const resolution=h.messages.at(-1);
    await h.send('我继续帮你。','她放松了。',h.score(2));
    const scoreId=h.runtime.store.document.journal.at(-1).id;
    assert.equal(h.runtime.state().profiles.a.affinity,32);
    resolution.mes='这次事件尚未收束。';h.runtime.store.reconcile();
    assert.equal(h.runtime.state().profiles.a.rank,0);assert.equal(h.runtime.state().profiles.a.affinity,30);
    assert.equal(h.runtime.state().skipped.find(op=>op.id===scoreId).code,'STALE_DEPENDENCY');
});

for(const change of ['edit','delete','swipe']) for(const delta of [4,5]) test('an invalid earlier score preserves a later gate only while its threshold still holds, '+change+', delta='+delta,async t=>{
    const h=await setup(t);await h.configure('affinity',25);
    const first=await h.send('我来帮你。','她放松了。',h.score(2));
    await h.send('我继续帮你。','她放松了。',h.score(delta));
    await h.runtime.configure({...h.runtime.state().profiles.a,mode:'coop',acceptCap:true});
    await h.runtime.generate('a');const eventId=h.runtime.event().id;
    await h.send('我问起画册。','她带来了旧画册。',snapshot=>({event:{eventId:snapshot.event.id,characterId:'a',eventVersion:snapshot.event.version,phase:'hook',evidence:'旧画册'}}));
    if(change==='edit') h.messages[first].mes='她拒绝了帮助。';
    if(change==='delete') h.messages.splice(first-1,2);
    if(change==='swipe') h.messages[first].swipe_id=1;
    h.runtime.store.reconcile();
    if(delta===5) {
        assert.equal(h.runtime.event()?.id,eventId);assert.equal(h.runtime.event().phase,'dilemma');
        assert.equal(h.runtime.state().profiles.a.affinity,30);
        assert.deepEqual(h.runtime.state().skipped.map(op=>op.code),['STALE_SOURCE']);
        await h.runtime.load();assert.equal(h.runtime.event()?.id,eventId);
    } else {
        assert.equal(h.runtime.event(),null);assert.equal(h.runtime.state().profiles.a.lock,null);
        assert.equal(h.runtime.state().profiles.a.affinity,29);
    }
});
test('legacy event journals retain conservative preconditions when dependencies are unknown',async t=>{
    const h=await setup(t);await h.configure('affinity',25);
    const first=await h.send('我来帮你。','她放松了。',h.score(2));
    await h.send('我继续帮你。','她放松了。',h.score(5));
    await h.runtime.configure({...h.runtime.state().profiles.a,mode:'coop',acceptCap:true});await h.runtime.generate('a');
    for(const op of h.runtime.store.document.journal) delete op.dependencies;
    h.messages[first].mes='她拒绝了帮助。';h.runtime.store.reconcile();
    assert.equal(h.runtime.event(),null);
    assert.ok(h.runtime.state().skipped.some(op=>op.code==='STALE_DEPENDENCY'));
});
test('replanning after the opening keeps the original rounds in both the request and the resumed event',async t=>{
    const h=await setup(t);await unlockAndStart(h);
    await h.send('我问起画册。','她带来了旧画册。',snapshot=>({event:{eventId:snapshot.event.id,characterId:'a',eventVersion:snapshot.event.version,phase:'hook',evidence:'旧画册'}}));
    const eventId=h.runtime.event().id,original=clone(h.runtime.event().plan);
    await h.runtime.pause('a',eventId);await h.runtime.configureSettings({eventRounds:2});let request;
    h.host.ask=async messages=>{request=messages;return JSON.stringify({...eventPlan(h.runtime.state().profiles.a),rounds:2,hook:'另一个开场'});};
    await h.runtime.generate('a',{replanEventId:eventId});await h.runtime.resume('a',eventId);
    assert.ok(request[1].content.includes('【本事件指定轮数】3'));
    assert.ok(request[1].content.includes(original.hook));
    assert.equal(h.runtime.event().plan.rounds,3);assert.equal(h.runtime.event().plan.hook,original.hook);
    await h.send('请继续说。','她提出疑问，等待回应。',snapshot=>({event:{eventId:snapshot.event.id,characterId:'a',eventVersion:snapshot.event.version,phase:'dilemma',evidence:'等待回应'}}));
    assert.equal(h.runtime.event().phase,'waiting_user');
});
test('consecutive resolution inputs retain the first answer in prompts and archive recovery',async t=>{
    const h=await setup(t);await unlockAndStart(h);await progressToResolution(h);
    h.messages.push({is_user:true,mes:'我愿意帮你核对资料。'});await h.runtime.prepare();
    const first=h.messages.at(-1).sd_coop_id;
    h.messages.push({is_user:true,mes:'先坐下来吧。'});await h.runtime.prepare();
    h.messages.push({is_user:true,mes:'慢慢来。'});await h.runtime.prepare();
    const version=h.runtime.event().version;
    await h.runtime.prepare();assert.equal(h.runtime.event().version,version);
    assert.equal(h.runtime.event().initialAnswerSource.id,first);
    assert.ok(h.runtime.injection().includes('我愿意帮你核对资料。'));
    assert.ok(h.runtime.injection().includes('慢慢来。'));
    await h.reply('她决定核对资料，接受有限帮助。');let request;
    h.host.ask=async messages=>{
        request=messages;
        return JSON.stringify({ready:true,evidence:'核对资料',completion:{
            summary:'用户愿意共同核对画册资料，随后请她坐下慢慢来。她接受有限帮助，并保留自己的判断，展览问题留待后续处理。',
            outcome:'核对资料并接受帮助',outcomeEvidence:'接受有限帮助',choice:'愿意核对资料',choiceEvidence:'愿意帮你',
            traits:['接受有限帮助'],facts:[],boundaries:[],openHooks:[],closedHooks:[]}});
    };
    await h.runtime.recoverArchive();
    assert.ok(request[1].content.includes('我愿意帮你核对资料。'));
    assert.ok(request[1].content.includes('慢慢来。'));
    assert.equal(h.runtime.state().profiles.a.rank,1);
    const archive=h.runtime.state().profiles.a.history[0];
    assert.equal(archive.initialAnswerSource.id,first);
    assert.equal(archive.answerSource.id,h.messages.at(-2).sd_coop_id);
    await h.runtime.load();assert.equal(h.runtime.state().profiles.a.history[0].initialAnswerSource.id,first);
});

for(const recovery of [false,true]) test('Rank 3 route conflict survives persistence and requires a new choice, archive='+recovery,async t=>{
    const h=await setup(t,{extra:!recovery});await h.configure();
    for(let rank=1;rank<=3;rank++) {
        while(h.runtime.state().profiles.a.affinity<h.runtime.state().profiles.a.thresholds[rank-1]) await h.send('我继续帮你。','她放松了。',h.score(5));
        await h.runtime.generate('a');await progressToResolution(h);
        if(rank===3) break;
        await h.send('我愿意帮你核对资料。','她决定核对资料，接受有限帮助。',snapshot=>({event:{
            eventId:snapshot.event.id,characterId:'a',eventVersion:snapshot.event.version,phase:'resolution',evidence:'核对资料',
            completion:{summary:'她说明画册和导师要求之间的矛盾，用户愿意共同核对资料。她接受有限帮助，保留自己的判断，展览问题仍未解决。',
                outcome:'核对资料',outcomeEvidence:'核对资料',choice:'愿意帮助',choiceEvidence:'愿意帮你',
                traits:['接受有限帮助'],facts:[],boundaries:[],openHooks:[],closedHooks:[]}}}));
    }
    await h.send('我愿意成为恋人。','她等待你确认关系。');
    const firstAnswer=h.runtime.event().answerSource.id;
    await h.runtime.route('romance');
    const conflict=await h.send('我只想和你做朋友。','她决定尊重你的选择。',snapshot=>recovery?{}:{event:{
        eventId:snapshot.event.id,characterId:'a',eventVersion:snapshot.event.version,phase:'resolution',
        routeConflict:true,userEvidence:'只想和你做朋友',evidence:'尊重你的选择'}});
    if(recovery) {
        h.host.ask=async()=>JSON.stringify({ready:false,routeConflict:true,userEvidence:'只想和你做朋友',evidence:'尊重你的选择'});
        await h.runtime.recoverArchive();
    }
    assert.equal(h.runtime.event().phase,'waiting_route');assert.equal(h.runtime.event().route,null);
    assert.equal(h.runtime.state().profiles.a.rank,2);assert.ok(h.runtime.state().profiles.a.lock);
    await h.runtime.load();assert.equal(h.runtime.event().phase,'waiting_route');
    await h.runtime.route('friendship');await h.runtime.prepare();
    const snapshot=h.runtime.snapshot;
    await h.reply('她决定核对资料，接受有限帮助。',{event:{eventId:snapshot.event.id,characterId:'a',eventVersion:snapshot.event.version,phase:'resolution',evidence:'核对资料',
        completion:{summary:'用户在危机后明确选择伙伴关系，她尊重了新的选择。两人决定共同核对展览资料，她接受有限帮助并保留自己的判断。',
            outcome:'核对资料并保持伙伴关系',outcomeEvidence:'核对资料',choice:'做朋友',choiceEvidence:'只想和你做朋友',
            traits:['尊重关系边界'],facts:[],boundaries:['伙伴关系'],openHooks:[],closedHooks:[]}}});
    assert.equal(h.runtime.state().profiles.a.rank,3);assert.equal(h.runtime.state().profiles.a.route,'friendship');
    assert.equal(h.runtime.state().profiles.a.history.at(-1).initialAnswerSource.id,firstAnswer);
    await h.runtime.load();assert.equal(h.runtime.state().profiles.a.route,'friendship');
    h.messages[conflict].mes='她还未回应。';h.runtime.store.reconcile();
    assert.equal(h.runtime.state().profiles.a.rank,2);assert.ok(h.runtime.state().profiles.a.lock);
});
test('replan generation is rejected when its paused event changes without new messages',async t=>{
    const h=await setup(t);await unlockAndStart(h);const eventId=h.runtime.event().id;
    await h.runtime.pause('a',eventId);let release;
    h.host.ask=()=>new Promise(resolve=>{release=resolve;});
    const pending=h.runtime.generate('a',{replanEventId:eventId});await new Promise(resolve=>setTimeout(resolve,0));
    await h.runtime.resume('a',eventId);await h.runtime.pause('a',eventId);
    release(JSON.stringify(eventPlan(h.runtime.state().profiles.a)));
    await assert.rejects(pending,{code:'STALE_TASK'});
    assert.equal(h.runtime.state().profiles.a.events[eventId].paused,true);
    assert.equal(h.runtime.store.document.journal.filter(op=>op.kind==='replan').length,0);
});

for(const change of ['edit','delete']) test('a resolution source invalidated during saving never publishes its Rank, '+change,async t=>{
    const h=await setup(t);await unlockAndStart(h);await progressToResolution(h);
    const published=[],persist=h.host.persist;
    const unsubscribe=h.runtime.onChange(()=>published.push(h.runtime.state().profiles.a.rank));t.after(unsubscribe);
    let release,entered;
    const saving=new Promise(resolve=>{entered=resolve;});
    h.host.persist=async document=>{
        if(document.journal.at(-1)?.kind==='beat' && document.journal.at(-1).data.phase==='resolution') {
            entered();await new Promise(resolve=>{release=resolve;});
        }
        await persist(document);
    };
    const pending=h.send('我愿意帮你核对资料。','她决定核对资料，接受有限帮助。',snapshot=>({event:{
        eventId:snapshot.event.id,characterId:'a',eventVersion:snapshot.event.version,phase:'resolution',evidence:'核对资料',
        completion:{summary:'用户愿意一起核对资料，她接受有限帮助并保留自己的判断，展览与导师的问题留待后续处理。',
            outcome:'核对资料',outcomeEvidence:'核对资料',choice:'愿意帮忙',choiceEvidence:'愿意帮你',
            traits:['接受有限帮助'],facts:[],boundaries:[],openHooks:[],closedHooks:[]}}}));
    await saving;
    if(change==='edit') h.messages.at(-1).mes='她仍在犹豫，尚未解决。';else h.messages.pop();
    h.runtime.store.reconcile();release();await pending;
    assert.ok(published.every(rank=>rank===0));assert.equal(h.runtime.state().profiles.a.rank,0);
    assert.ok(h.runtime.state().profiles.a.lock);
    await h.runtime.load();assert.equal(h.runtime.state().profiles.a.rank,0);
});
