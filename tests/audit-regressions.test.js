import test from 'node:test';
import assert from 'node:assert/strict';
import {CoopRuntime} from '../coop/runtime.js';
import {clone,initialState} from '../coop/model.js';
import {mergeCoopMvu,unwrap} from '../coop/mvu.js';
import {candidates} from '../coop/roster.js';

const block=report=>'<UpdateVariable><JSONPatch>'+JSON.stringify([{op:'add',path:'/故事导演/Coop/回报',value:report}])+'</JSONPatch></UpdateVariable>';
const score=delta=>({characterId:'a',delta,reason:'实际帮助',userEvidence:'帮你',evidence:'放松'});
async function setup(t,{extra=false,initial=0}={}) {
    const messages=[],metadata={},context={extensionSettings:{mvu_settings:{更新方式:extra?'额外模型解析':'随AI输出'}}};
    const host={context:()=>context,scope:()=> 'audit-chat',messages:()=>messages,metadata:()=>metadata,
        available:()=>true,autoAllowed:()=>false,contextText:async()=> '画家在画室里整理旧画册。',locks:{request:async(name,options,fn)=>fn({name})},
        persist:async document=>{metadata.storyDirectorCoop=clone(document);},ask:async()=>JSON.stringify({
            targetRank:1,title:'旧画册',scene:'画室',conflict:'理想与现实',goal:'形成新的应对方式',hook:'她带来旧画册',
            dilemma:'导师提出疑问',question:'你愿意如何面对？',resolution:'依据回应解决眼前的事',
            seeds:{persona:'画家',desire:'举办展览',shadow:'害怕否定',friction:'导师的要求'},usedHistory:[],references:[],conflicts:[]})};
    const runtime=new CoopRuntime(host);await runtime.load();t.after(()=>runtime.dispose());
    await runtime.configure({id:'a',name:'画家',mode:'coop',initialAffinity:initial});
    async function begin(user='我来帮你。'){messages.push({is_user:true,mes:user});await runtime.prepare();return runtime.snapshot;}
    async function beat(body){
        const snapshot=await begin(),event=snapshot.event;
        messages.push({is_user:false,mes:body+block({nonce:snapshot.nonce,affinity:[],event:{characterId:'a',
            eventId:event.id,eventVersion:event.version,phase:event.phase,evidence:body}})});
        await runtime.afterMessage(messages.length-1);
    }
    return {runtime,context,messages,metadata,begin,beat,profile:()=>runtime.state().profiles.a};
}

test('audit P1: a conflicting new card cannot block another member or an existing Coop answer',async t=>{
    const h=await setup(t,{initial:30});await h.runtime.configure({id:'npc:doctor',name:'医生',mode:'coop',initialAffinity:18});
    await h.runtime.generate('a');await h.beat('她带来了旧画册。');await h.beat('她提出疑问，等待回应。');
    assert.equal(h.runtime.event().phase,'waiting_user');
    h.context.characters=[{name:'医生',avatar:'doctor.png'},{name:'旅人',avatar:'traveler.png'}];
    h.context.groupId='g';h.context.groups=[{id:'g',members:['doctor.png','traveler.png']}];
    await h.runtime.ensureCurrentCharacters();
    await assert.rejects(h.runtime.enrollCard(h.runtime.pendingCharacters.find(p=>p.cardRef==='doctor.png').id,7),{code:'AMBIGUOUS_IDENTITY'});
    await h.runtime.enrollCard(h.runtime.pendingCharacters.find(p=>p.cardRef==='traveler.png').id,7);
    h.messages.push({is_user:true,mes:'我愿意帮你核对资料。'});
    await assert.doesNotReject(h.runtime.prepare());
    assert.equal(h.runtime.event().answerSource.id,h.messages.at(-1).sd_coop_id);
    assert.equal(h.runtime.snapshot.event.phase,'resolution');assert.ok(h.runtime.snapshot.roles.a);
    const profiles=Object.values(h.runtime.state().profiles);
    assert.ok(profiles.some(p=>p.cardRef==='traveler.png'));assert.ok(!profiles.some(p=>p.cardRef==='doctor.png'));
    assert.equal(h.runtime.state().profiles['npc:doctor'].affinity,18);assert.equal(h.profile().affinity,30);
    const revision=h.runtime.store.document.revision,notices=h.runtime.notices.length;
    await h.runtime.prepare();assert.equal(h.runtime.store.document.revision,revision);
    assert.equal(h.runtime.notices.length,notices);
});

test('audit P1: discovery failure still permits a snapshot for already managed roles',async t=>{
    const h=await setup(t);h.context.characters={invalid:'not a character list'};h.context.characterId=0;
    await assert.doesNotReject(h.begin());assert.ok(h.runtime.snapshot.roles.a);
    assert.ok(h.runtime.notices.length);
});

test('audit P1: an automatic addition queued behind a manual profile cannot overwrite that profile',async t=>{
    const h=await setup(t),candidate=candidates({characters:[{name:'卡片名称',avatar:'manual.png'}],characterId:0})[0];
    let release;const gate=new Promise(resolve=>{release=resolve;});
    const blocked=h.runtime.store.enqueue(async()=>{await gate;});
    const manual=h.runtime.configure({...candidate,name:'手动名称',description:'手动补充',aliases:['手动别名'],mode:'affinity',initialAffinity:14});
    h.context.characters=[{name:'卡片名称',avatar:'manual.png'}];h.context.characterId=0;
    const automatic=h.runtime.enrollCard(candidate.id,7);release();await Promise.all([blocked,manual]);
    await assert.rejects(automatic,{code:'ALREADY_MANAGED'});
    const p=h.runtime.state().profiles[candidate.id];
    assert.equal(p.name,'手动名称');assert.equal(p.description,'手动补充');assert.deepEqual(p.aliases,['手动别名']);
    assert.equal(p.policyRevision,1);assert.equal(p.affinity,14);assert.equal(p.mode,'affinity');
});

for(const delivery of ['early','late']) test('audit P2: extra-model reports win over conflicting inline reports, '+delivery,async t=>{
    const h=await setup(t,{extra:true}),snapshot=await h.begin();
    const inline={nonce:snapshot.nonce,affinity:[score(3)]},external={nonce:snapshot.nonce,affinity:[score(1)]};
    h.messages.push({is_user:false,mes:'她放松了。'+block(inline)});const index=h.messages.length-1;
    if(delivery==='early') await h.runtime.receiveMvu({stat_data:{故事导演:{Coop:{回报:external}}}});
    assert.equal(h.profile().affinity,0,'the narrative model must not settle an extra-model turn');
    await h.runtime.afterMessage(index);
    if(delivery==='late') {
        assert.equal(h.profile().affinity,0);await h.runtime.receiveMvu({stat_data:{故事导演:{Coop:{回报:external}}}});
    }
    assert.equal(h.profile().affinity,1);assert.equal(h.profile().scoreLog.length,1);
    await h.runtime.afterMessage(index);await h.runtime.load();await h.runtime.afterMessage(index);
    assert.equal(h.profile().affinity,1);assert.equal(h.messages[index].extra.sdCoopReports.byExtra,true);
    assert.deepEqual(h.messages[index].extra.sdCoopReports.reports,[external]);
});

test('audit P2: an MVU callback without an external report cannot authorize an inline extra-model proposal',async t=>{
    const h=await setup(t,{extra:true}),snapshot=await h.begin();
    h.messages.push({is_user:false,mes:'她放松了。'});const index=h.messages.length-1;
    await h.runtime.afterMessage(index);
    h.messages[index].mes+=block({nonce:snapshot.nonce,affinity:[score(4)]});
    await h.runtime.receiveMvu({stat_data:{生命:10}});assert.equal(h.profile().affinity,0);
});

test('audit P2: an old inline nonce cannot misbind the current extra-model response',async t=>{
    const h=await setup(t,{extra:true}),old=await h.begin();
    h.messages.push({is_user:false,mes:'她放松了。'});await h.runtime.afterMessage(h.messages.length-1);
    const current=await h.begin();
    h.messages.push({is_user:false,mes:'她放松了。'+block({nonce:old.nonce,affinity:[score(4)]})});
    const report={nonce:current.nonce,affinity:[score(1)]};
    await h.runtime.receiveMvu({stat_data:{故事导演:{Coop:{回报:report}}}});
    await h.runtime.afterMessage(h.messages.length-1);
    assert.equal(h.profile().affinity,1);assert.equal(h.runtime.pendingMvuReports.size,0);
});

test('audit P2: inline event reports cannot advance an extra-model scene',async t=>{
    const h=await setup(t,{extra:true,initial:30});await h.runtime.generate('a');
    const snapshot=await h.begin(),event=snapshot.event;
    const report={nonce:snapshot.nonce,affinity:[],event:{characterId:'a',eventId:event.id,
        eventVersion:event.version,phase:'hook',evidence:'旧画册'}};
    h.messages.push({is_user:false,mes:'她拿出旧画册。'+block(report)});await h.runtime.afterMessage(h.messages.length-1);
    assert.equal(h.runtime.event().phase,'hook');
    await h.runtime.receiveMvu({stat_data:{故事导演:{Coop:{回报:report}}}});
    assert.equal(h.runtime.event().phase,'dilemma');
});

test('audit P1: a registration interrupted by chat switching cannot continue its old group in the new chat',async t=>{
    let scope='old',metadata={},release,entered;
    const started=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
    const context={characters:[]},writes=[];
    const runtime=new CoopRuntime({context:()=>context,scope:()=>scope,messages:()=>[],metadata:()=>metadata,
        locks:{request:async(name,options,fn)=>fn({name})},persist:async(document,target)=>{
            const captured=metadata;
            if(target==='old'){entered();await gate;}
            captured.storyDirectorCoop=clone(document);writes.push({target,names:Object.values(document.roster).map(p=>p.name)});
        }});
    t.after(()=>runtime.dispose());await runtime.load();
    context.characters=[{name:'旧群成员一',avatar:'old-1.png'},{name:'旧群成员二',avatar:'old-2.png'}];
    context.groupId='g';context.groups=[{id:'g',members:['old-1.png','old-2.png']}];
    await runtime.ensureCurrentCharacters();const adding=runtime.enrollCard(runtime.pendingCharacters[0].id,7);await started;
    scope='new';metadata={};context.groupId=null;context.characterId=0;context.characters=[{name:'新角色',avatar:'new.png'}];
    const loading=runtime.load();await new Promise(resolve=>setImmediate(resolve));release();
    await assert.rejects(adding,{code:'STALE_SCOPE'});await loading;
    await runtime.enrollCard(runtime.pendingCharacters[0].id,10);
    assert.deepEqual(Object.values(runtime.state().profiles).map(p=>p.name),['新角色']);
    assert.ok(writes.filter(w=>w.target==='new').every(w=>!w.names.some(name=>name.startsWith('旧群'))));
});

for(const level of ['namespace','coop','nested']) test('audit P3: initializing a null MVU wrapper preserves its descriptions, '+level,()=>{
    const state=initialState({a:{id:'a',name:'画家',mode:'coop',initialAffinity:7}});
    const wrapper=level==='nested'?[[null,'内层说明'],'外层说明']:[null,'变量说明'];
    const variables={stat_data:{生命:9,故事导演:level==='namespace'?wrapper:{主线:{当前拍:2},Coop:wrapper}}};
    assert.equal(mergeCoopMvu(variables,state),true);
    const actual=level==='namespace'?variables.stat_data.故事导演:variables.stat_data.故事导演.Coop;
    assert.strictEqual(actual,wrapper);assert.equal(actual[1],level==='nested'?'外层说明':'变量说明');
    if(level==='nested') assert.equal(actual[0][1],'内层说明');
    const ns=unwrap(variables.stat_data.故事导演),coop=unwrap(ns.Coop);
    assert.equal(coop.角色.a.好感度,7);assert.equal(variables.stat_data.生命,9);
    assert.equal(mergeCoopMvu(variables,state),false);
});

test('audit P3: undefined single-value wrappers are retained during initialization',()=>{
    const state=initialState({a:{id:'a',name:'画家',mode:'coop',initialAffinity:7}});
    const wrapper=[undefined],variables={stat_data:{故事导演:wrapper}};
    assert.equal(mergeCoopMvu(variables,state),true);assert.strictEqual(variables.stat_data.故事导演,wrapper);
    assert.equal(wrapper[0].Coop.角色.a.好感度,7);
});

test('audit P3: invalid wrapped namespace values still fail without modifying the input',()=>{
    const state=initialState({a:{id:'a',name:'画家',mode:'coop',initialAffinity:7}});
    const variables={stat_data:{故事导演:[{Coop:[0,'无效值说明']},'导演说明']}},before=clone(variables);
    assert.throws(()=>mergeCoopMvu(variables,state),{code:'INVALID_MVU_NAMESPACE'});assert.deepEqual(variables,before);
});
