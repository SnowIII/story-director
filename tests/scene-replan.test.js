import test from 'node:test';
import assert from 'node:assert/strict';
import {clone,initialState} from '../coop/model.js';
import {CoopRuntime} from '../coop/runtime.js';
import {designMessages,renderScene} from '../coop/prompts.js';

const makePlan=()=>({targetRank:1,rounds:3,title:'一起核对画册',scene:'旧画室',
    conflict:'画册中的记录尚待核对',goal:'共同核对记录并确认分工',hook:'她在旧画室取出画册',
    dilemma:'协商核对分工',question:'你想负责哪一部分？',resolution:'依据真实分工完成核对',
    seeds:{persona:'画家',desire:'举办展览',shadow:'害怕否定',friction:'时间有限'},
    usedHistory:[],references:[],conflicts:[]});

async function openedEvent(t) {
    const messages=[{is_user:true,mes:'给我看看画册。'}],metadata={},requests=[];
    const host={scope:()=> 'scene-replan',context:()=>({}),metadata:()=>metadata,messages:()=>messages,
        available:()=>true,autoAllowed:()=>false,contextText:async()=>messages.map(m=>m.mes).join('\n'),
        locks:{request:async(name,options,callback)=>callback({name})},
        persist:async document=>{metadata.storyDirectorCoop=clone(document);},
        ask:async request=>{requests.push(request);return JSON.stringify(makePlan());}};
    const runtime=new CoopRuntime(host);t.after(()=>runtime.dispose());await runtime.load();
    await runtime.configure({id:'a',name:'画家',mode:'coop',initialAffinity:30});
    await runtime.generate('a');await runtime.prepare();
    const snapshot=runtime.snapshot;
    const report={nonce:snapshot.nonce,event:{eventId:snapshot.event.id,characterId:'a',eventVersion:snapshot.event.version,
        phase:'hook',evidence:'她在旧画室取出画册'}};
    messages.push({is_user:false,name:'画家',mes:'她在旧画室取出画册。'+
        '<UpdateVariable><JSONPatch>'+JSON.stringify([{op:'add',path:'/故事导演/Coop/回报',value:report}])+'</JSONPatch></UpdateVariable>'});
    await runtime.afterMessage(messages.length-1);
    assert.equal(runtime.event().phase,'dilemma');
    return {runtime,host,messages,metadata,requests};
}

test('regeneration follows a changed scene while preserving performed history through reload',async t=>{
    const h=await openedEvent(t),before=clone(h.runtime.event());
    h.messages.push({is_user:true,mes:'我们带上画册去河边继续核对。'});
    await h.runtime.prepare();
    h.messages.push({is_user:false,name:'画家',mes:'两人带着画册离开旧画室，已经来到河边长椅。'});
    await h.runtime.afterMessage(h.messages.length-1);
    let request;
    h.host.ask=async messages=>{
        request=messages;
        return JSON.stringify({...makePlan(),scene:'河边长椅',hook:'错误的新开场',goal:'错误的新目标',
            dilemma:'在河边协商接下来的核对分工',question:'这几页怎样分工？'});
    };
    await h.runtime.regenerate('a',before.id);
    assert.ok(request[1].content.includes('已经来到河边长椅'));
    assert.equal(h.runtime.event().plan.scene,'河边长椅');
    assert.equal(h.runtime.event().plan.hook,before.plan.hook);
    assert.equal(h.runtime.event().plan.goal,before.plan.goal);
    assert.equal(h.runtime.event().plan.conflict,before.plan.conflict);
    assert.equal(h.runtime.event().plan.dilemma,'在河边协商接下来的核对分工');
    for(const key of ['id','phase','progress','playedUsers','questionSource','initialAnswerSource','answerSource','route']) {
        assert.deepEqual(h.runtime.event()[key],before[key]);
    }
    assert.ok(h.runtime.event().progress[0].source.body.includes('旧画室'));
    assert.equal(h.metadata.storyDirectorCoop.journal.find(op=>op.kind==='replan').data.scenePolicy,'current-v1');
    await h.runtime.load();
    assert.equal(h.runtime.event().plan.scene,'河边长椅');
    assert.deepEqual(h.runtime.event().progress,before.progress);
    assert.equal(h.runtime.event().phase,'dilemma');
    assert.equal(h.runtime.state().profiles.a.rank,0);
    assert.deepEqual(h.runtime.state().skipped,[]);
});

test('legacy replans do not adopt previously discarded scenes when replayed after upgrade',async t=>{
    const h=await openedEvent(t),eventId=h.runtime.event().id;
    await h.runtime.pause('a',eventId);
    await h.runtime.store.operation('replan','a',{eventId,plan:{...makePlan(),scene:'旧版本曾丢弃的场景',dilemma:'新的未演安排'}});
    await h.runtime.resume('a',eventId);
    assert.equal(h.runtime.event().plan.scene,'旧画室');
    assert.equal(h.runtime.event().plan.dilemma,'新的未演安排');
    assert.equal(h.metadata.storyDirectorCoop.journal.find(op=>op.kind==='replan').data.scenePolicy,undefined);
    await h.runtime.load();
    assert.equal(h.runtime.event().plan.scene,'旧画室');
    assert.equal(h.runtime.event().plan.dilemma,'新的未演安排');
    assert.deepEqual(h.runtime.state().skipped,[]);
});

test('current-scene constraints remain after custom design rules and preserve the original goal',()=>{
    const profile=initialState({a:{id:'a',name:'画家',mode:'coop'}}).profiles.a;
    const custom='自定义事件规则：始终回到旧画室。';
    const messages=designMessages(profile,'最新现场：二人在河边长椅。',{rules:custom});
    assert.ok(messages[0].content.indexOf('【现场连续性，固定契约】')>messages[0].content.indexOf(custom));
    assert.match(messages[0].content,/当前地点、时间、人物和物品状态以最新真实对话为准/);
    assert.match(messages[0].content,/重新生成时可据最新真实现场更新 scene/);
    assert.match(messages[0].content,/不能改写进度记录/);
    assert.match(messages[0].content,/不靠降低目标或编造结果成功升阶/);
    assert.ok(messages[1].content.includes('二人在河边长椅'));
});

for(const phase of ['hook','dilemma','waiting_user','waiting_route','resolution']) {
    test('live '+phase+' scene follows actual movement without treating movement alone as failure',()=>{
        const profile=initialState({a:{id:'a',name:'画家',mode:'coop'}}).profiles.a;
        const event={id:'event',characterId:'a',targetRank:1,phase,plan:makePlan(),progress:[]};
        const prompt=renderScene(profile,event);
        assert.match(prompt,/计划中的场景（实际现场以最新真实对话为准）：旧画室/);
        assert.match(prompt,/场景变化本身不表示失败/);
        assert.match(prompt,/不因旧计划限定地点就把人物传送回去、重演开场/);
        assert.match(prompt,/本阶目标保持有效/);
    });
}
