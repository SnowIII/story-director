import test from 'node:test';
import assert from 'node:assert/strict';
import {CoopRuntime} from '../coop/runtime.js';
import {clone} from '../coop/model.js';
import {STORAGE_KEY} from '../coop/store.js';

const failureBody='她取消了这次展览，将画册收起，承认原来的安排已经无法继续。';
const failureReport=()=>({failed:true,evidence:'原来的安排已经无法继续',failure:{
    reason:'用户退出后，原来的展览安排已无法继续。',
    summary:'用户决定退出原来的展览安排。她取消这次展览并收起画册，这次事件以失败结束，双方并未完成原定目标。',
    outcome:'这次展览已取消',outcomeEvidence:'她取消了这次展览',
    choice:'退出这次安排',choiceEvidence:'退出这次安排',openHooks:['原定展览未能举办'],sharedFacts:[],
}});
const closedScene=evidence=>({goalAchieved:true,closed:true,awaitingUser:false,blockingConflicts:[],evidence});
function eventPlan(profile) {
    return {targetRank:profile.rank+1,title:profile.failedHistory?.length?'新的共同安排':'旧画册',scene:'画室',
        conflict:'理想与现实',goal:'形成新的应对方式',hook:'她带来旧画册',dilemma:'她面对导师的疑问',
        question:'你愿意如何面对？',resolution:'根据真实回应处理眼前的事情',
        seeds:profile.seeds || {persona:'画家',desire:'举办展览',shadow:'害怕否定',friction:'导师的要求'},
        usedHistory:profile.history.map(history=>history.eventId),references:[],conflicts:[]};
}

async function fixture(t,{channel='inline',autoStart=true}={}) {
    const director=channel.startsWith('director'),extra=channel.endsWith('extra');
    const empty=()=>({stat_data:{故事导演:{Coop:{角色:{}}}}});
    const messages=[{is_user:false,mes:'画家在整理资料。',...(director?{variables:[empty()]}:{})}],metadata={},calls=[];
    let baseline=empty(),runtime,automatic=false;
    const host={affinityAuthority:director?'mvu':undefined,scope:()=> 'failed-event-runtime',metadata:()=>metadata,
        messages:()=>messages,context:()=>({extensionSettings:{mvu_settings:{更新方式:extra?'额外模型解析':'随AI输出'}}}),
        available:()=>true,autoAllowed:()=>automatic,contextText:async()=>messages.map(message=>message.mes).join('\n'),
        locks:{request:async(name,options,callback)=>callback({name})},
        persist:async document=>{metadata[STORAGE_KEY]=clone(document);},
        ask:async request=>{calls.push(request);return JSON.stringify(eventPlan(runtime.state().profiles.a));}};
    if(director) host.mvu=()=>({
        getMvuData:target=>target.type==='chat'?baseline:messages[target.message_id==='latest'?messages.length-1:target.message_id]?.variables?.[0] || {},
        replaceMvuData:async(data,target)=>{if(target.type==='chat') baseline=clone(data);else messages[target.message_id].variables=[clone(data)];},
    });
    runtime=new CoopRuntime(host);await runtime.load();t.after(()=>runtime.dispose());
    await runtime.configure({id:'a',name:'画家',mode:'coop',rankCount:4,initialAffinity:30});
    if(director) {
        await runtime.syncMvu();
        Object.assign(messages.at(-1).variables[0].stat_data.故事导演.Coop.角色.画家,{好感度:30,好感锁定:true});
        runtime.store.reconcile();
    }
    await runtime.configureSettings({autoStart});
    await runtime.generate('a');calls.length=0;
    async function prepare(user) {
        if(user!==undefined) messages.push({is_user:true,mes:user});
        await runtime.prepare();return runtime.snapshot;
    }
    async function reply(body,event=null,{report:override=null,affinity=[],transport=channel}={}) {
        const snapshot=clone(runtime.snapshot),current=snapshot.event;
        const report=override || {nonce:snapshot.nonce,affinity,...(event?{event:{
            eventId:current.id,characterId:current.characterId,eventVersion:current.version,phase:current.phase,...event,
        }}:{})};
        const variables=director?clone(messages.findLast(message=>message.variables)?.variables[0]):null;
        const tag=transport.startsWith('director')?'<CoopReport>'+JSON.stringify(report)+'</CoopReport>':transport==='extra'?'':
            '<UpdateVariable><JSONPatch>'+JSON.stringify([{op:'add',path:'/故事导演/Coop/回报',value:report}])+'</JSONPatch></UpdateVariable>';
        messages.push({is_user:false,mes:body+tag,...(director?{variables:[variables]}:{})});
        const index=messages.length-1;
        await runtime.afterMessage(index);
        if(transport==='extra') await runtime.receiveMvu({stat_data:{故事导演:{Coop:{回报:report}}}});
        else if(director) {
            await runtime.receiveMvu(variables);
            await runtime.syncMvu();runtime.store.reconcile();
        }
        if(runtime.archiveCheckTask) await runtime.archiveCheckTask;
        return {index,report,snapshot};
    }
    async function send(user,body,event=null,options) {await prepare(user);return reply(body,event,options);}
    const profile=()=>runtime.state().profiles.a;
    const row=()=>messages.findLast(message=>message.variables)?.variables[0].stat_data.故事导演.Coop.角色.画家;
    return {runtime,host,messages,metadata,calls,prepare,reply,send,profile,row,auto:value=>{automatic=value;}};
}

async function toWaitingUser(h) {
    await h.send('请让我看看画册。','她带来了旧画册。',{evidence:'旧画册'});
    await h.send('请继续说。','她提出问题，等待回应。',{evidence:'提出问题'});
    assert.equal(h.runtime.event().phase,'waiting_user');
}

for(const channel of ['inline','extra','director','director-extra']) test('an explicit failed event is saved before one same-rank retry, '+channel,async t=>{
    const h=await fixture(t,{channel}),oldId=h.runtime.event().id,gate=clone(h.profile().lock),ask=h.host.ask;
    h.host.ask=async request=>{
        const saved=h.metadata[STORAGE_KEY];
        assert.ok(saved.journal.some(operation=>operation.data?.eventId===oldId && operation.data.failed===true));
        assert.equal(h.profile().events[oldId].phase,'failed');
        assert.ok(request.map(message=>message.content).join('\n').includes('这次展览已取消'));
        return ask(request);
    };
    h.auto(true);
    const {index,report}=await h.send('我决定退出这次安排。',failureBody,failureReport());
    const profile=h.profile(),retry=h.runtime.event();
    assert.equal(profile.rank,0);assert.equal(profile.affinity,30);assert.deepEqual(profile.lock,gate);
    assert.equal(profile.history.length,0);assert.equal(profile.failedHistory.length,1);
    assert.equal(profile.failedHistory[0].eventId,oldId);assert.equal(profile.events[oldId].phase,'failed');
    assert.notEqual(retry.id,oldId);assert.equal(retry.targetRank,1);assert.equal(retry.retryOf,oldId);
    assert.equal(h.calls.length,1);
    await h.runtime.afterMessage(index);await h.runtime.receive(index);
    if(channel==='extra') await h.runtime.receiveMvu({stat_data:{故事导演:{Coop:{回报:report}}}});
    await h.runtime.maybeAuto();
    assert.equal(h.calls.length,1);assert.equal(h.profile().failedHistory.length,1);assert.equal(h.runtime.event().id,retry.id);
    if(channel.startsWith('director')) {assert.equal(h.row().好感度,30);assert.equal(h.row().好感锁定,true);}
});

for(const phase of ['hook','dilemma','waiting_user','resolution']) test('failure can end an event during '+phase,async t=>{
    const h=await fixture(t),oldId=h.runtime.event().id;
    if(phase==='dilemma') await h.send('请让我看看画册。','她带来了旧画册。',{evidence:'旧画册'});
    if(['waiting_user','resolution'].includes(phase)) await toWaitingUser(h);
    const failure=failureReport();delete failure.failure.choice;delete failure.failure.choiceEvidence;
    if(phase==='waiting_user') await h.prepare();
    else await h.prepare('我决定退出这次安排。');
    assert.equal(h.runtime.event().phase,phase);
    await h.reply(failureBody,failure);
    assert.equal(h.profile().events[oldId].phase,'failed');assert.equal(h.profile().failedHistory.length,1);
    assert.equal(h.runtime.event(),null);assert.equal(h.profile().rank,0);assert.ok(h.profile().lock);
    assert.equal(h.calls.length,0);
});

test('ready:false alone keeps the unresolved event and never creates a replacement',async t=>{
    const h=await fixture(t);await toWaitingUser(h);h.auto(true);
    const oldId=h.runtime.event().id;
    await h.send('我再想想。','她仍在等待你的决定。',{ready:false});
    assert.equal(h.runtime.event().id,oldId);assert.equal(h.runtime.event().phase,'resolution');
    assert.equal(h.profile().failedHistory.length,0);assert.equal(h.calls.length,0);assert.equal(h.profile().rank,0);
});

test('ready:false with valid opening evidence cannot advance or fail the hook',async t=>{
    const h=await fixture(t),oldId=h.runtime.event().id;h.auto(true);
    await h.send('请先等一等。','她抱着旧画册，暂时还没有说完。',{ready:false,evidence:'旧画册'});
    assert.equal(h.runtime.event().id,oldId);assert.equal(h.runtime.event().phase,'hook');
    assert.equal(h.runtime.event().progress.length,0);assert.equal(h.profile().failedHistory.length,0);assert.equal(h.calls.length,0);
});

test('failure preserves a decisive middle-turn choice after a later generic response',async t=>{
    const h=await fixture(t);await toWaitingUser(h);const oldId=h.runtime.event().id;
    await h.send('我愿意尝试一起办展览。','她仍在准备展览。',{ready:false});
    const {index}=await h.send('我决定退出这次安排。','她停下了展览准备。',{ready:false});
    const choiceId=h.messages[index-1].sd_coop_id;
    h.auto(true);await h.send('继续。',failureBody,failureReport());
    assert.equal(h.profile().events[oldId].phase,'failed');assert.equal(h.profile().failedHistory.length,1);
    assert.equal(h.profile().failedHistory[0].choice,'退出这次安排');assert.equal(h.profile().rank,0);
    assert.equal(h.runtime.event().retryOf,oldId);assert.equal(h.calls.length,1);
    const failure=h.runtime.store.document.journal.find(operation=>operation.data?.eventId===oldId && operation.data.failed===true);
    assert.ok(failure.refs.some(reference=>reference.id===choiceId));
    h.auto(false);h.messages.splice(h.messages.findIndex(message=>message.sd_coop_id===choiceId),1);h.runtime.store.reconcile();
    if(h.runtime.store.eventPruneTask) await h.runtime.store.eventPruneTask;
    assert.equal(h.profile().failedHistory.length,0);assert.equal(h.runtime.event().id,oldId);
});

test('initial autoStart does not disable continuation after a failed event',async t=>{
    const h=await fixture(t,{autoStart:false}),oldId=h.runtime.event().id;h.auto(true);
    await h.send('我决定退出这次安排。',failureBody,failureReport());
    assert.equal(h.calls.length,1);assert.equal(h.runtime.event().retryOf,oldId);assert.equal(h.runtime.event().targetRank,1);
    assert.equal(h.runtime.store.document.settings.autoStart,false);
});

test('a failed event waits while global generation is off and allows an explicit manual retry',async t=>{
    const h=await fixture(t,{autoStart:false}),oldId=h.runtime.event().id;
    await h.send('我决定退出这次安排。',failureBody,failureReport());
    await h.runtime.maybeAuto();assert.equal(h.calls.length,0);assert.equal(h.runtime.event(),null);
    await h.runtime.generate('a');
    assert.equal(h.calls.length,1);assert.equal(h.runtime.event().retryOf,oldId);assert.equal(h.runtime.event().targetRank,1);
    assert.equal(h.profile().rank,0);
});

test('a failed retry design preserves the failure archive and can be retried manually',async t=>{
    const h=await fixture(t),oldId=h.runtime.event().id,ask=h.host.ask;
    h.auto(true);let failedCalls=0;
    h.host.ask=async()=>{failedCalls++;throw new Error('design unavailable');};
    await h.send('我决定退出这次安排。',failureBody,failureReport());
    assert.equal(failedCalls,1);assert.equal(h.runtime.event(),null);assert.equal(h.profile().failedHistory.length,1);
    assert.equal(h.profile().events[oldId].phase,'failed');assert.equal(h.profile().rank,0);assert.ok(h.profile().lock);
    h.host.ask=ask;await h.runtime.generate('a');
    assert.equal(h.calls.length,1);assert.equal(h.runtime.event().retryOf,oldId);assert.equal(h.profile().failedHistory.length,1);
});

test('failure persistence must succeed before any replacement design is requested',async t=>{
    const h=await fixture(t),oldId=h.runtime.event().id,persist=h.host.persist;let offline=true;
    h.host.persist=async document=>{
        if(offline && document.journal.some(operation=>operation.data?.failed===true)) throw new Error('offline');
        return persist(document);
    };
    h.auto(true);await h.send('我决定退出这次安排。',failureBody,failureReport());
    assert.ok(h.runtime.store.pending);assert.equal(h.calls.length,0);assert.equal(h.profile().failedHistory.length,0);
    assert.equal(h.runtime.event().id,oldId);assert.equal(h.runtime.event().phase,'hook');
    offline=false;await h.runtime.store.retrySave();await h.runtime.maybeAuto();
    assert.equal(h.profile().failedHistory.length,1);assert.equal(h.profile().rank,0);
    assert.equal(h.runtime.event().retryOf,oldId);assert.equal(h.calls.length,1);
});

for(const kind of ['stale-user','stale-event-version','invalid-evidence']) test('an invalid failure report cannot archive or retry: '+kind,async t=>{
    const h=await fixture(t),oldId=h.runtime.event().id;h.auto(true);
    await h.prepare('我决定退出这次安排。');
    const snapshot=clone(h.runtime.snapshot),payload=failureReport();
    const report={nonce:snapshot.nonce,event:{eventId:oldId,characterId:'a',eventVersion:snapshot.event.version,phase:'hook',...payload}};
    if(kind==='stale-user') await h.prepare('我暂时不退出。');
    if(kind==='stale-event-version') report.event.eventVersion++;
    if(kind==='invalid-evidence') {
        report.event.failure.outcomeEvidence='正文里根本没有这一句';
        h.host.ask=async request=>{h.calls.push(request);return JSON.stringify({ready:false,reason:'缺少失败依据'});};
    }
    await h.reply(failureBody,null,{report});
    assert.equal(h.runtime.event().id,oldId);assert.equal(h.profile().failedHistory.length,0);
    assert.equal(h.calls.length,kind==='invalid-evidence'?1:0);
    if(kind==='invalid-evidence') assert.equal(JSON.parse(h.calls[0][1].content).closureMode,'failure');
});

for(const newer of ['user-reversal','same-user-reply']) test('a delayed MVU failure cannot override a newer '+newer,async t=>{
    const h=await fixture(t,{channel:'extra'}),oldId=h.runtime.event().id;h.auto(true);
    const old=await h.send('我决定退出这次安排。',failureBody);
    if(newer==='user-reversal') {
        await h.send('我改变主意，回来继续参与展览。','她重新取出画册，和你继续商量展览安排。',{ready:false});
    } else {
        await h.prepare();
        await h.reply('她发现替代展出方案，这次安排仍有继续的可能。',{ready:false});
    }
    assert.equal(h.runtime.event().phase,'hook');assert.equal(h.runtime.event().version,old.snapshot.event.version);
    assert.notEqual(h.runtime.archiveSource(h.runtime.event(),{force:true}).id,h.messages[old.index].sd_coop_id);
    const report={nonce:old.snapshot.nonce,event:{eventId:oldId,characterId:'a',phase:old.snapshot.event.phase,
        eventVersion:old.snapshot.event.version,...failureReport()}};
    await h.runtime.receiveMvu({stat_data:{故事导演:{Coop:{回报:report}}}});
    await h.runtime.receiveMvu({stat_data:{故事导演:{Coop:{回报:report}}}});
    assert.equal(h.runtime.event().id,oldId);assert.equal(h.runtime.event().phase,'hook');
    assert.equal(h.profile().failedHistory.length,0);assert.equal(h.profile().rank,0);assert.equal(h.calls.length,0);
    assert.equal(h.runtime.currentNotice.code,'STALE_SOURCE');
});

test('failure and retry survive reload without replaying the failure report',async t=>{
    const h=await fixture(t),oldId=h.runtime.event().id;h.auto(true);
    const {index}=await h.send('我决定退出这次安排。',failureBody,failureReport()),retryId=h.runtime.event().id;
    await h.runtime.load();await h.runtime.afterMessage(index);await h.runtime.maybeAuto();
    assert.equal(h.profile().events[oldId].phase,'failed');assert.equal(h.runtime.event().id,retryId);
    assert.equal(h.profile().failedHistory.length,1);assert.equal(h.calls.length,1);assert.equal(h.profile().rank,0);
});

test('deleting the failure floor rolls back its failure archive and dependent retry',async t=>{
    const h=await fixture(t),oldId=h.runtime.event().id;h.auto(true);
    const {index}=await h.send('我决定退出这次安排。',failureBody,failureReport()),retryId=h.runtime.event().id;
    h.auto(false);h.messages.splice(index,1);h.runtime.store.reconcile();
    if(h.runtime.store.eventPruneTask) await h.runtime.store.eventPruneTask;
    assert.equal(h.profile().failedHistory.length,0);assert.equal(h.runtime.event().id,oldId);
    assert.equal(h.profile().events[retryId],undefined);assert.equal(h.profile().rank,0);assert.ok(h.profile().lock);
    await h.runtime.load();assert.equal(h.runtime.event().id,oldId);assert.equal(h.profile().failedHistory.length,0);
});

test('deleting the original plan floor removes its failure and retry lineage',async t=>{
    const h=await fixture(t),original=h.runtime.event(),anchor=original.createdAt.id;h.auto(true);
    await h.send('我决定退出这次安排。',failureBody,failureReport());
    h.auto(false);h.messages.splice(h.messages.findIndex(message=>message.sd_coop_id===anchor),1);h.runtime.store.reconcile();
    if(h.runtime.store.eventPruneTask) await h.runtime.store.eventPruneTask;
    assert.equal(h.runtime.event(),null);assert.equal(h.profile().failedHistory.length,0);
    assert.equal(Object.keys(h.profile().events).length,0);assert.equal(h.profile().rank,0);
});

test('manual failure assessment can archive before resolution and start a retry with automation off',async t=>{
    const h=await fixture(t,{autoStart:false}),oldId=h.runtime.event().id,ask=h.host.ask;let assessments=0;
    await h.send('我决定退出这次安排。',failureBody);
    assert.equal(h.runtime.event().phase,'hook');
    h.host.ask=async request=>{
        if(assessments++===0) return JSON.stringify(failureReport());
        return ask(request);
    };
    await h.runtime.recoverArchive({force:true});
    assert.equal(assessments,2);assert.equal(h.calls.length,1);assert.equal(h.profile().failedHistory.length,1);
    assert.equal(h.profile().history.length,0);assert.equal(h.profile().rank,0);assert.equal(h.profile().affinity,30);assert.ok(h.profile().lock);
    assert.equal(h.runtime.event().targetRank,1);assert.equal(h.runtime.event().retryOf,oldId);
});

test('a late failure assessment cannot commit after a new user turn changes its evidence',async t=>{
    const h=await fixture(t),oldId=h.runtime.event().id;
    await h.send('我决定退出这次安排。',failureBody);
    let release,entered;const started=new Promise(resolve=>{entered=resolve;});
    h.host.ask=async()=>{entered();return new Promise(resolve=>{release=resolve;});};
    const task=h.runtime.recoverArchive({force:true});await started;
    await h.prepare('我改变了主意，请先不要结束事件。');
    release(JSON.stringify(failureReport()));
    await assert.rejects(task,{code:'STALE_TASK'});
    assert.equal(h.runtime.event().id,oldId);assert.equal(h.profile().failedHistory.length,0);assert.equal(h.profile().rank,0);
    assert.equal(h.runtime.job,null);
});

test('normal archive assessment can recognize failure and continue at the same rank',async t=>{
    const h=await fixture(t),oldId=h.runtime.event().id,ask=h.host.ask;await toWaitingUser(h);
    await h.send('我决定退出这次安排。',failureBody);
    let assessments=0;h.host.ask=async request=>assessments++===0?JSON.stringify(failureReport()):ask(request);
    await h.runtime.recoverArchive();
    assert.equal(assessments,2);assert.equal(h.profile().failedHistory.length,1);assert.equal(h.profile().history.length,0);
    assert.equal(h.runtime.event().retryOf,oldId);assert.equal(h.profile().rank,0);
});

test('an automatic resolution assessment starts the retry after saving failure, including extra-model callbacks',async t=>{
    const h=await fixture(t,{channel:'director-extra'}),oldId=h.runtime.event().id,ask=h.host.ask;await toWaitingUser(h);
    let assessments=0;h.host.ask=async request=>{
        if(assessments++===0) return JSON.stringify(failureReport());
        return ask(request);
    };
    h.auto(true);await h.send('我决定退出这次安排。',failureBody);
    assert.equal(assessments,2);assert.equal(h.calls.length,1);
    assert.equal(h.profile().events[oldId].phase,'failed');assert.equal(h.profile().failedHistory.length,1);
    assert.equal(h.profile().rank,0);assert.equal(h.runtime.event().targetRank,1);assert.equal(h.runtime.event().retryOf,oldId);
    assert.equal(h.runtime.archiveCheckTask,null);assert.equal(h.runtime.job,null);
    await h.runtime.receiveMvu(h.messages.at(-1).variables[0]);await h.runtime.maybeAuto();
    assert.equal(assessments,2);assert.equal(h.profile().failedHistory.length,1);
});

test('a legacy forced-success response cannot promote a failed or unfulfilled event',async t=>{
    const h=await fixture(t),oldId=h.runtime.event().id;await toWaitingUser(h);
    await h.send('我决定退出这次安排。',failureBody);
    h.host.ask=async()=>JSON.stringify({ready:true,evidence:'原来的安排已经无法继续',completion:{
        summary:'用户决定退出原来的展览安排，她取消了这次展览，原定目标并未实现。',
        outcome:'展览取消',outcomeEvidence:'她取消了这次展览',choice:'退出安排',choiceEvidence:'退出这次安排',
        traits:[],facts:['这次展览取消'],boundaries:[],openHooks:[],closedHooks:[],
        scene:{...closedScene('她取消了这次展览'),goalAchieved:false},
    }});
    await h.runtime.recoverArchive({force:true}).catch(()=>{});
    assert.equal(h.profile().rank,0);assert.equal(h.profile().history.length,0);assert.equal(h.profile().events[oldId].phase,'resolution');
    assert.ok(h.profile().lock);
});

async function toRelationshipRank(h) {
    for(let rank=1;rank<3;rank++) {
        await toWaitingUser(h);
        await h.send('我愿意帮你核对资料。','她完成了资料核对，接受有限帮助。',{ready:true,evidence:'完成了资料核对',completion:{
            summary:'用户愿意帮忙核对展览资料，她接受了有限帮助并完成核对，保留自己的判断，双方明确接下来的分工。',
            outcome:'完成资料核对',outcomeEvidence:'完成了资料核对',choice:'帮忙核对资料',choiceEvidence:'愿意帮你核对资料',
            traits:['愿意接受有限帮助'],facts:[],boundaries:[],openHooks:[],closedHooks:[],scene:closedScene('完成了资料核对'),
        }});
        while(h.profile().affinity<h.profile().thresholds[h.profile().rank]) {
            await h.send('我继续帮你。','她放松了。',null,{affinity:[{characterId:'a',delta:5,reason:'实际帮助',userEvidence:'帮你',evidence:'放松'}]});
        }
        await h.runtime.generate('a');
    }
    await toWaitingUser(h);h.calls.length=0;
}

test('rejecting both relationship routes can fail without selecting friendship or romance',async t=>{
    const h=await fixture(t);await toRelationshipRank(h);const oldId=h.runtime.event().id,gate=clone(h.profile().lock);
    h.auto(true);
    const failure=failureReport();failure.failure.choice='不定义关系并退出安排';failure.failure.choiceEvidence='不想确认任何关系';
    await h.send('我不想确认任何关系，决定退出这次安排。',failureBody,failure);
    assert.equal(h.profile().events[oldId].phase,'failed');assert.equal(h.profile().route,'unset');
    assert.equal(h.profile().rank,2);assert.equal(h.profile().history.length,2);assert.deepEqual(h.profile().lock,gate);
    assert.equal(h.runtime.event().targetRank,3);assert.equal(h.runtime.event().retryOf,oldId);assert.equal(h.calls.length,1);
});

test('failure assessment after a route-conflict assessment uses a distinct durable operation',async t=>{
    const h=await fixture(t);await toRelationshipRank(h);const oldId=h.runtime.event().id;
    await h.send('我愿意成为恋人。','她等待你确认关系。');await h.runtime.route('romance');
    const body='她决定尊重你的选择，取消原来的恋爱告白安排，两人今后只做朋友。';
    await h.send('我只想和你做朋友。',body);
    h.host.ask=async()=>JSON.stringify({ready:false,routeConflict:true,userEvidence:'只想和你做朋友',evidence:'尊重你的选择'});
    await h.runtime.recoverArchive();assert.equal(h.runtime.event().phase,'waiting_route');
    await h.runtime.route('friendship');let calls=0;
    h.host.ask=async()=>{
        if(calls++===0) return JSON.stringify({failed:true,evidence:'取消原来的恋爱告白安排',failure:{
            reason:'原定的恋爱告白安排已取消。',summary:'用户改选朋友关系，她尊重了这一选择并取消原来的恋爱告白安排，本次原定事件失败。',
            outcome:'原来的恋爱告白安排取消',outcomeEvidence:'取消原来的恋爱告白安排',
            choice:'只做朋友',choiceEvidence:'只想和你做朋友',openHooks:[],sharedFacts:[],
        }});
        return JSON.stringify(eventPlan(h.profile()));
    };
    await h.runtime.recoverArchive({force:true});
    assert.equal(calls,2);assert.equal(h.profile().rank,2);assert.equal(h.profile().failedHistory.length,1);
    assert.equal(h.profile().events[oldId].phase,'failed');assert.equal(h.runtime.event().retryOf,oldId);
    assert.equal(h.runtime.event().targetRank,3);
});
