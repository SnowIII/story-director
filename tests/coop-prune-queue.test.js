import test from 'node:test';
import assert from 'node:assert/strict';
import {CoopStore,STORAGE_KEY} from '../coop/store.js';
import {clone,rankPolicy} from '../coop/model.js';
import {ensureMessageIds,references,ref} from '../coop/messages.js';

function deferred() {
    let resolve;
    const promise=new Promise(done=>{resolve=done;});
    return {promise,resolve};
}

async function fixture() {
    let scope='old-chat',metadata={};
    const messages=[{sd_coop_id:'origin-a',is_user:false,mes:'她在整理画册。'}],cleanups=[];
    const host={scope:()=>scope,metadata:()=>metadata,messages:()=>messages,
        persist:async document=>{metadata[STORAGE_KEY]=clone(document);},
        pruneEventCaches:ids=>cleanups.push({scope,ids:[...ids]})};
    const store=new CoopStore(host);store.load();
    await store.enqueue(document=>{
        for(const id of ['a','b']) document.roster[id]={id,name:id,mode:'coop',rankCount:7,
            initialAffinity:15,thresholds:[...rankPolicy(7).thresholds],policyRevision:1};
    });
    const last=()=>[...store.sources().values()].at(-1);
    const add=(isUser,body)=>{messages.push({is_user:isUser,mes:body});ensureMessageIds(messages);return last();};
    async function start(characterId) {
        await store.operation('activate',characterId,{});
        const p=store.state.profiles[characterId],source=last();
        await store.operation('plan',characterId,{eventId:'event-'+characterId,gateId:p.lock.id,
            createdAt:{id:source.id,index:source.index},plan:{targetRank:1,title:'旧画册',scene:'画室',
                conflict:'理想与现实',goal:'接受有限帮助',hook:'她拿出画册',dilemma:'她提出疑问',question:'愿意帮忙吗？',
                resolution:'根据回应核对资料',seeds:{persona:'画家',desire:'展览',shadow:'怕否定',friction:'导师'},
                usedHistory:[],references:[],conflicts:[]}},references(source));
    }
    await start('a');
    for(const [phase,body] of [['hook','她拿出画册。'],['dilemma','她提出疑问。']]) {
        add(true,'我继续听。');const source=add(false,body),event=store.state.profiles.a.events['event-a'];
        await store.operation('beat','a',{eventId:event.id,eventVersion:event.version,phase,source,evidence:body},references(source));
    }
    const answer=add(true,'我愿意帮忙核对资料。');
    await store.operation('answer','a',{eventId:'event-a',source:answer},[ref(answer)]);
    const source=add(false,'她接受有限帮助，并决定核对资料。'),event=store.state.profiles.a.events['event-a'];
    await store.operation('beat','a',{eventId:event.id,eventVersion:event.version,phase:'resolution',source,evidence:'接受有限帮助',completion:{
        summary:'用户愿意帮忙核对画册资料，她接受有限帮助并保留自己的判断，展览问题留待后续处理。',
        outcome:'核对资料',outcomeEvidence:'核对资料',choice:'愿意帮忙',choiceEvidence:'愿意帮忙',
        traits:['愿意接受有限帮助'],facts:[],boundaries:[],openHooks:[],closedHooks:[]}},references(source));
    messages.push({sd_coop_id:'origin-b',is_user:false,mes:'另一位画家准备了新的画册。'});
    await start('b');
    assert.equal(store.state.profiles.a.rank,1);assert.equal(store.state.skipped.length,0);
    const drop=id=>messages.splice(messages.findIndex(message=>message.sd_coop_id===id),1);
    return {store,host,messages,cleanups,drop,metadata:()=>metadata,
        switchScope(next){scope=next;metadata={[STORAGE_KEY]:{...clone(store.document),scope:next}};store.load();}};
}

async function holdQueue(store) {
    const entered=deferred(),gate=deferred();
    const task=store.enqueue(async()=>{entered.resolve();await gate.promise;});
    await entered.promise;
    return {task,release:gate.resolve};
}
const eventIds=document=>document.journal.filter(op=>op.kind==='plan').map(op=>op.data.eventId);

test('queued deletion cannot expand when the same chat temporarily becomes empty',async()=>{
    const h=await fixture(),hold=await holdQueue(h.store);
    h.drop('origin-b');const pruning=h.store.pruneEvents();
    const retainedMessages=h.messages.splice(0);
    hold.release();await hold.task;await pruning;
    h.messages.push(...retainedMessages);h.store.reconcile();
    assert.deepEqual(eventIds(h.store.document),['event-a']);
    assert.deepEqual(eventIds(h.metadata()[STORAGE_KEY]),['event-a']);
    assert.equal(h.store.state.profiles.a.rank,1);assert.equal(h.store.state.profiles.a.history.length,1);
    assert.deepEqual(h.cleanups,[{scope:'old-chat',ids:['event-b']}]);
});

test('two explicit deletion notifications while a save is queued both finish',async()=>{
    const h=await fixture(),hold=await holdQueue(h.store);
    h.drop('origin-b');const first=h.store.pruneEvents();
    h.drop('origin-a');const second=h.store.pruneEvents();
    hold.release();await hold.task;await Promise.all([first,second]);
    assert.deepEqual(eventIds(h.store.document),[]);
    assert.deepEqual(h.cleanups.flatMap(item=>item.ids).sort(),['event-a','event-b']);
    assert.equal(h.store.pending,null);assert.equal(h.store.eventPruneTask,null);
});

test('failed deletion keeps caches and later explicit requests until a successful retry',async()=>{
    const h=await fixture(),persist=h.host.persist;
    h.host.persist=async()=>{throw new Error('offline');};
    h.drop('origin-b');await h.store.pruneEvents();
    assert.ok(h.store.pending);assert.deepEqual(h.cleanups,[]);
    assert.deepEqual(eventIds(h.store.document),['event-a','event-b']);
    h.drop('origin-a');await h.store.pruneEvents();
    assert.deepEqual(h.cleanups,[]);
    h.host.persist=persist;await h.store.retrySave();
    assert.deepEqual(eventIds(h.store.document),[]);
    assert.deepEqual(eventIds(h.metadata()[STORAGE_KEY]),[]);
    assert.deepEqual(h.cleanups.flatMap(item=>item.ids).sort(),['event-a','event-b']);
    assert.equal(h.store.pending,null);assert.equal(h.store.error,null);
});

test('a late deletion save cannot clean a new chat or clear its active prune task',async()=>{
    const h=await fixture(),oldEntered=deferred(),oldGate=deferred(),newEntered=deferred(),newGate=deferred();
    h.host.persist=async(document,scope)=>{
        const target=h.metadata(),entered=scope==='old-chat'?oldEntered:newEntered,gate=scope==='old-chat'?oldGate:newGate;
        entered.resolve();await gate.promise;target[STORAGE_KEY]=clone(document);
    };
    h.drop('origin-b');const oldTask=h.store.pruneEvents();await oldEntered.promise;
    h.switchScope('new-chat');
    const newTask=h.store.pruneEvents();
    oldGate.resolve();await oldTask;await newEntered.promise;
    assert.equal(h.store.eventPruneTask,newTask);assert.deepEqual(h.cleanups,[]);
    newGate.resolve();await newTask;
    assert.deepEqual(h.cleanups,[{scope:'new-chat',ids:['event-b']}]);
    assert.deepEqual(eventIds(h.store.document),['event-a']);
});

test('a cache cleanup error cannot turn a confirmed deletion into a pending save',async t=>{
    const h=await fixture();t.mock.method(console,'warn',()=>{});
    h.host.pruneEventCaches=()=>{throw new Error('cache unavailable');};
    h.drop('origin-b');await h.store.pruneEvents();
    assert.deepEqual(eventIds(h.metadata()[STORAGE_KEY]),['event-a']);
    assert.deepEqual(eventIds(h.store.document),['event-a']);
    assert.equal(h.store.pending,null);assert.equal(h.store.error,null);
});
