import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {CoopRuntime} from '../coop/runtime.js';
import {clone,rankPolicy} from '../coop/model.js';

// Exercise the production switch, including its worldbook mount bookkeeping.
const directorSource=fs.readFileSync(new URL('../index.js',import.meta.url),'utf8');
const masterSource=directorSource.slice(directorSource.indexOf('function setMaster('),
    directorSource.indexOf('/**\n * 「正在生成」',directorSource.indexOf('function setMaster(')));

function masterControl(runtime,onlyCoop) {
    const settings={autoDirector:true,onlyCoop,run:{},bookUnmountOnOff:true};
    const mounted=new Set(['故事导演']);
    const context=vm.createContext({
        settings:()=>settings,PLUGIN_WORLD:'故事导演',console:{info(){},debug(){}},
        armNow:run=>{run.armedAt=10;},save(){},render(){},
        syncMainInjection:()=>{runtime.injection();runtime.variableContract();},
        isGlobalBookEnabled:name=>mounted.has(name),
        setGlobalBook:(name,enabled)=>{if(enabled) mounted.add(name);else mounted.delete(name);},
    });
    vm.runInContext(masterSource,context);
    runtime.host.autoAllowed=()=>settings.autoDirector;
    return {settings,mounted,set:enabled=>vm.runInContext('setMaster('+enabled+',{notify:false})',context)};
}

async function fixture(t,onlyCoop) {
    const empty=()=>({stat_data:{故事导演:{Coop:{角色:{}}}}});
    const metadata={},messages=[{is_user:false,mes:'画家正在画室整理旧画册。',variables:[empty()]}];
    let baseline=empty(),calls=0,runtime;
    const host={affinityAuthority:'mvu',scope:()=> 'master-toggle-chat',metadata:()=>metadata,
        messages:()=>messages,context:()=>({}),available:()=>true,autoAllowed:()=>false,
        contextText:async()=>messages.map(message=>message.mes).join('\n'),
        locks:{request:async(name,options,fn)=>fn({name})},
        persist:async document=>{metadata.storyDirectorCoop=clone(document);},
        ask:async()=>{
            calls++;
            const p=runtime.state().profiles.a;
            return JSON.stringify({targetRank:p.rank+1,title:'旧画册',scene:'画室',conflict:'理想与现实',
                goal:'接受有限的实际帮助',hook:'她拿出旧画册',dilemma:'导师提出疑问',question:'你愿意帮忙吗？',
                resolution:'依据回应核对资料',seeds:p.seeds || {persona:'画家',desire:'展览',shadow:'怕否定',friction:'导师'},
                usedHistory:p.history.map(history=>history.eventId),references:[],conflicts:[]});
        },
    };
    const api={
        getMvuData:target=>target.type==='chat'?baseline:messages[target.message_id]?.variables?.[0] || {},
        replaceMvuData:async(data,target)=>{
            if(target.type==='chat') baseline=clone(data);
            else messages[target.message_id].variables=[clone(data)];
        },
    };
    host.mvu=()=>api;
    runtime=new CoopRuntime(host);await runtime.load();t.after(()=>runtime.dispose());
    await runtime.configure({id:'a',name:'画家',mode:'coop',rankCount:7,initialAffinity:rankPolicy(7).thresholds[0]});
    await runtime.syncMvu();
    const row=()=>messages.at(-1).variables[0].stat_data.故事导演.Coop.角色.画家;
    const write=(value,locked)=>{Object.assign(row(),{好感度:value,好感锁定:locked});runtime.store.reconcile();};
    async function turn(body,event=null) {
        const variables=clone(messages.findLast(message=>message.variables)?.variables[0]);
        messages.push({is_user:true,mes:'我愿意帮你核对资料。'});await runtime.prepare();
        const snapshot=runtime.snapshot;
        const report=event?'<CoopReport>'+JSON.stringify({nonce:snapshot.nonce,event:{
            ...snapshot.event,eventId:snapshot.event.id,eventVersion:snapshot.event.version,...event}})+'</CoopReport>':'';
        messages.push({is_user:false,mes:body+report,variables:[variables]});
        await runtime.afterMessage(messages.length-1);await runtime.syncMvu();
    }
    write(15,true);await runtime.generate('a');
    await turn('她拿出旧画册。',{evidence:'旧画册'});
    await turn('她提出疑问，等待用户回应。',{evidence:'提出疑问'});
    await turn('她接受有限帮助，决定核对资料。',{evidence:'接受有限帮助',completion:{
        summary:'用户愿意共同核对旧画册资料，她接受有限的实际帮助并保留自己的判断，展览问题留待后续处理。',
        outcome:'核对资料',outcomeEvidence:'核对资料',choice:'愿意帮忙',choiceEvidence:'愿意帮你',
        traits:['接受有限帮助'],facts:['旧画册属于她'],boundaries:[],openHooks:['展览尚待准备'],closedHooks:[],
        scene:{goalAchieved:true,closed:true,awaitingUser:false,blockingConflicts:[],evidence:'接受有限帮助'}}});
    write(30,true);await runtime.syncMvu();
    return {runtime,metadata,messages,row,turn,calls:()=>calls,control:masterControl(runtime,onlyCoop)};
}

for(const onlyCoop of [false,true]) test('master off, dialogue, reload and on preserve seven-rank history at affinity 30, standalone='+onlyCoop,async t=>{
    const h=await fixture(t,onlyCoop),p=h.runtime.state().profiles.a;
    assert.equal(p.rank,1);assert.equal(p.affinity,30);assert.equal(h.runtime.event(),null);
    const history=clone(p.history),journal=clone(h.metadata.storyDirectorCoop.journal),calls=h.calls();
    const retained=()=>{
        const current=h.runtime.state().profiles.a;
        assert.equal(current.rank,1);assert.equal(current.affinity,30);
        assert.deepEqual(current.history,history);
        assert.deepEqual(h.metadata.storyDirectorCoop.journal,journal);
        assert.equal(h.runtime.event(),null);assert.equal(h.row().好感度,30);
    };
    assert.equal(h.control.set(false),true);assert.equal(h.control.mounted.has('故事导演'),false);
    retained();
    await h.turn('她继续准备展览，暂时没有新的事件。');await h.runtime.maybeAuto();
    retained();assert.equal(h.calls(),calls,'the disabled master must not start another model request');
    await h.runtime.load();await h.runtime.syncMvu();retained();
    assert.equal(h.control.set(true),true);assert.equal(h.control.mounted.has('故事导演'),true);
    retained();
    await h.runtime.generate('a');
    assert.equal(h.runtime.event().targetRank,2,'resuming must continue at Rank 2 rather than repeat Rank 1');
    assert.deepEqual(h.runtime.state().profiles.a.history,history);
});
