import test from 'node:test';
import assert from 'node:assert/strict';
import {initialState,clone} from '../coop/model.js';
import {archiveSystemPrompt,designMessages,directorReportContract,reportContract,renderScene,affinityContract} from '../coop/prompts.js';
import {mountCoopUI} from '../coop/ui.js';

const activePhases=['hook','dilemma','waiting_user','waiting_route','resolution'];
const state=()=>initialState({a:{id:'a',name:'画家',mode:'coop',initialAffinity:30}});
const event=(phase='hook')=>({id:'attempt',characterId:'a',targetRank:1,version:2,phase,paused:false,progress:[],
    plan:{title:'修复旧画册',scene:'画室',conflict:'画册缺页',goal:'共同修复画册',hook:'她取出画册',rounds:3,
        dilemma:'选择修复办法',question:'先修哪一页？',resolution:'完成修复'},answerSource:{body:'我愿意帮忙'}});
const snapshot={nonce:'n',reportChannel:'director',roles:{a:{mvuKey:'画家'}}};
const failure=()=>({eventId:'failed-attempt',rank:1,summaryVersion:1,reason:'画册已经被烧毁，原本修复目标已无法达成。',
    summary:'画册在火灾中被彻底烧毁，修复目标已经无法实现。本次尝试以失败结束，后续应承接这一损失。',
    outcome:'画册已烧毁',choice:'',openHooks:['火灾原因待查'],sharedFacts:[]});

for(const phase of activePhases) test('failure contract is available before ordinary progression in '+phase,()=>{
    const p=state().profiles.a,e=event(phase);
    const scene=renderScene(p,e);
    assert.match(scene,/任何阶段都可.*failed:true/);
    for(const contract of [directorReportContract(e,snapshot),reportContract([p],e,snapshot)]) {
        assert.match(contract,/优先于当前幕必须演完、等待路线和成功收束/);
        assert.match(contract,/不可被自定义规则覆盖/);
        assert.match(contract,/路线尚未确认.*都不是失败/);
        assert.match(contract,/没有选择时省略这两项/);
        assert.match(contract,/Rank 不增加，好感锁定保留/);
        const sample=JSON.parse(contract.split('在 event 内使用以下字段：')[1].split('\n')[0]);
        assert.equal(sample.failed,true);
        assert.ok(sample.evidence);
        assert.ok(sample.failure.reason);assert.ok(sample.failure.outcomeEvidence);
        assert.equal(sample.completion,undefined);
        assert.equal(sample.failure.choice,undefined);
    }
});

test('manual failure assessment cannot produce a successful archive, while ordinary success remains strict',()=>{
    const manual=archiveSystemPrompt({force:true}),normal=archiveSystemPrompt();
    assert.match(manual,/按钮本身不代表失败证据/);
    assert.match(manual,/禁止输出成功归档/);
    assert.ok(!manual.includes('"completion"'));
    const failed=JSON.parse(manual.split('已确认失败时按以下结构填写实际内容：')[1].split('\n')[0]);
    assert.equal(failed.failed,true);assert.equal(failed.ready,undefined);
    assert.match(manual,/"ready":false/);
    assert.match(normal,/"failed":true/);
    const success=JSON.parse(normal.split('已收束时按以下结构填写实际内容：')[1].split('\n')[0]);
    assert.equal(success.ready,true);
    assert.deepEqual(success.completion.scene,{goalAchieved:true,closed:true,awaitingUser:false,blockingConflicts:[],
        evidence:'本轮正文中目标已实现且现场已告一段落的准确短句'});
    assert.match(normal,/至少一项包含有依据的真实变化/);
    assert.match(manual,/userResponses/);assert.match(normal,/userResponses/);
});

test('an intermediate explicit refusal remains visible after later small talk in either waiting or resolution',()=>{
    const p=state().profiles.a;
    const first={id:'u1',version:'v1',index:1,body:'我愿意试试。'},
        refusal={id:'u2',version:'v2',index:3,body:'我改主意了，这件事到此为止。'},
        latest={id:'u3',version:'v3',index:5,body:'今天有点冷。'};
    for(const phase of ['waiting_route','resolution']) {
        const e={...event(phase),initialAnswerSource:first,answerSource:latest,answerSources:[first,refusal,latest]};
        const prompt=renderScene(p,e),responses=JSON.parse(prompt.split('用户历次真实回应：')[1].split('\n')[0]);
        assert.deepEqual(responses.map(source=>source.body),[first.body,refusal.body,latest.body]);
        assert.match(prompt,/之后的普通闲聊不撤销它/);
        assert.match(prompt,/不得用首次同意覆盖后来的明确拒绝/);
    }
});

test('same-rank redesign includes actual failure and fixed feasibility constraints after custom rules',()=>{
    const p=state().profiles.a,h=failure();
    p.failedHistory=[h];p.events[h.eventId]={...event('failed'),id:h.eventId};
    const before=clone(p),custom='自定义规则：沿用原来的一切目标。';
    const messages=designMessages(p,'火灾后的画室',{rules:custom,forms:'只参考日常协作',blueprint:'本阶合作目标'});
    assert.ok(messages[0].content.startsWith(custom));
    assert.ok(messages[0].content.indexOf('【失败后的同阶重试，固定契约】')>messages[0].content.indexOf(custom));
    assert.match(messages[0].content,/不复用已经不可达成的目标/);
    assert.match(messages[0].content,/不得复活已死人物、恢复已毁物品/);
    assert.match(messages[0].content,/已明确拒绝的关系/);
    assert.ok(messages[1].content.includes(h.reason));assert.ok(messages[1].content.includes(h.outcome));
    assert.match(messages[1].content,/目标 Rank：1/);
    const sample=JSON.parse(messages[0].content.split('【固定返回格式：Coop 事件设计')[1].split('\n').slice(1).join('\n'));
    assert.equal(sample.targetRank,1);assert.deepEqual(sample.usedHistory,[]);
    assert.deepEqual(p,before);
});

test('terminal failures no longer render an active scene or count as an unfinished event lock',()=>{
    const p=state().profiles.a,e=event('failed');p.affinity=0;p.events[e.id]=e;
    assert.equal(renderScene(p,e),'');
    assert.match(affinityContract([p],snapshot),/"lockRequired":false/);
    p.affinity=30;
    assert.match(affinityContract([p],snapshot),/"lockRequired":true/);
});

function uiFixture(t,s) {
    const previous=globalThis.document,listeners={},disabled=[],calls=[];
    const panel={hidden:false,innerHTML:'',classList:{toggle(){}},setAttribute(){},contains:()=>false,
        querySelector:()=>null,querySelectorAll:selector=>{
            if(selector.includes('[data-action="force-archive"]')) return [{set disabled(value){disabled.push(value);}}];
            return [];
        },addEventListener:(name,fn)=>{listeners[name]=fn;}};
    globalThis.document={querySelectorAll:()=>[],getElementById:()=>null,createElement:()=>panel,activeElement:null};
    t.after(()=>{if(previous===undefined) delete globalThis.document;else globalThis.document=previous;});
    const runtime={state:()=>s,host:{},store:{document:{settings:{autoStart:true,eventRounds:3}}},onChange(){},
        notices:[],affinityActivity:()=>[],notice:error=>{throw error;},recoverArchive:async options=>{calls.push(options);}};
    const mounted=mountCoopUI(runtime,{container:{appendChild(){}}});
    const click=dataset=>listeners.click({target:{closest:()=>({dataset})}});
    return {panel,runtime,mounted,disabled,calls,click};
}

test('failure assessment is reachable from every active phase and follows readonly/save guards',async t=>{
    const s=state(),p=s.profiles.a,e=event();p.events[e.id]=e;s.activeEventId=e.id;
    const f=uiFixture(t,s);f.click({tab:'event'});
    for(const phase of activePhases) {
        e.phase=phase;f.mounted.render();
        assert.ok(f.panel.innerHTML.includes('核对失败并重试同阶'));
        assert.ok(f.panel.innerHTML.includes('data-action="force-archive"'));
        assert.equal(f.panel.innerHTML.includes('data-action="archive"'),phase==='resolution');
    }
    f.click({action:'force-archive'});await Promise.resolve();
    assert.deepEqual(f.calls,[{force:true}]);
    for(const guard of ['readonly','pending']) {
        f.runtime.store[guard]=true;f.mounted.render();f.runtime.store[guard]=false;
    }
    assert.deepEqual(f.disabled,[true,true]);
});

test('failed archives remain distinct from successful ranks and retain the same-rank retry entry',t=>{
    const s=state(),p=s.profiles.a,h=failure();
    p.lock={id:'gate',targetRank:1,lockedValue:30};p.failedHistory=[h];p.events[h.eventId]={...event('failed'),id:h.eventId};
    const f=uiFixture(t,s);f.mounted.render();
    assert.ok(f.panel.innerHTML.includes('重新设计 Rank 1 事件'));
    assert.ok(!f.panel.innerHTML.includes('data-action="resume"'));
    f.click({tab:'archive'});
    assert.ok(f.panel.innerHTML.includes('目标 Rank 1 · 已失败，未升阶'));
    assert.ok(f.panel.innerHTML.includes(h.reason));assert.ok(f.panel.innerHTML.includes(h.outcome));
    assert.ok(!f.panel.innerHTML.includes('实际选择：'));
    assert.ok(!f.panel.innerHTML.includes('data-summary="'+h.eventId+'"'));
    p.history=[{rank:1,eventId:'legacy',summary:'旧版保存的强制收束历史',closedBy:'force',choice:'帮助',outcome:'旧结果',openHooks:[],closedHooks:[]}];
    f.mounted.render();
    assert.ok(f.panel.innerHTML.includes('本阶按实际剧情收束：原定目标未达成'));
});

for(const saveFails of [false,true]) test('save retry resumes failed-event continuation only after persistence, error='+saveFails,async t=>{
    const f=uiFixture(t,state()),order=[];
    let finish;
    const done=new Promise(resolve=>{finish=resolve;});
    f.runtime.store.retrySave=async()=>{order.push('persist');if(saveFails) throw new Error('offline');};
    f.runtime.ensureCurrentCharacters=async()=>{order.push('refresh');};
    f.runtime.retryFailed=async()=>{order.push('design');finish();};
    f.runtime.notice=error=>{assert.equal(error.message,'offline');order.push('error');finish();};
    f.click({action:'retry'});await done;
    assert.deepEqual(order,saveFails?['persist','error']:['persist','refresh','design']);
});
