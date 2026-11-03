import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {EVENT_FORMS,EVENT_FORM_GUIDE} from '../coop/event-forms.js';
import {COOP_FORM_PROMPTS,designTemplates,preserveDesignTemplates} from '../coop/design-worldbook.js';
import {designMessages,renderScene,affinityContract,directorReportContract} from '../coop/prompts.js';
import {initialState,clone,hash} from '../coop/model.js';
import {CoopRuntime} from '../coop/runtime.js';

const bundled=JSON.parse(fs.readFileSync(new URL('../worldbook/story-director.json',import.meta.url),'utf8'));
const profile=()=>initialState({a:{id:'a',name:'画家',mode:'coop'}}).profiles.a;

test('form library is available exactly once with default or custom common rules, outside live and MVU prompts',()=>{
    assert.equal(EVENT_FORMS.length,6);assert.equal(EVENT_FORMS.flatMap(group=>group.forms).length,36);
    for(const rules of [undefined,'用户自定义通用规则']){
        const messages=designMessages(profile(),'现场',{rules});
        assert.equal(messages[0].content.split(EVENT_FORM_GUIDE).length-1,1);
        assert.ok(!messages[1].content.includes(EVENT_FORM_GUIDE));
    }
    const p=profile(),event={id:'e',characterId:'a',targetRank:1,phase:'hook',plan:{scene:'画室',conflict:'协调画框样式',hook:'共同修画框',rounds:3}};
    const snapshot={nonce:'n',reportChannel:'director',roles:{a:{mvuKey:'画家'}}};
    const live=[renderScene(p,event),affinityContract([p],snapshot),directorReportContract(event,snapshot),bundled.entries[0].content].join('\n');
    for(const {forms} of EVENT_FORMS)for(const form of forms)assert.ok(!live.includes(form));
    const entry=Object.values(bundled.entries).find(e=>e.comment.includes(COOP_FORM_PROMPTS.marker));
    assert.equal(entry.content,EVENT_FORM_GUIDE);assert.equal(entry.sdCoopDefaultHash,hash(EVENT_FORM_GUIDE.trim()));
    assert.equal(entry.disable,true);assert.equal(entry.enabled,false);
    assert.equal(designTemplates([{...entry,disable:false,enabled:true}],p).forms,EVENT_FORM_GUIDE);
});


test('worldbook forms replace the built-in library only when enabled with content',()=>{
    for(const raw of [false,true])for(const on of [false,true])for(const content of ['旧定制形式','']){
        const selected=designTemplates([{comment:'[coop_forms]',content,...(raw?{disable:!on}:{enabled:on})}],profile());
        const system=designMessages(profile(),'',selected)[0].content;
        assert.equal(selected.forms,on&&content?'旧定制形式':undefined);
        if(on&&content) assert.ok(system.includes('旧定制形式'));
        else assert.ok(system.includes(EVENT_FORM_GUIDE));
        assert.ok(system.includes('【程序契约】'));
    }
    assert.equal(designTemplates([{comment:'[coop_forms]',content:'目标阶 {{coop.targetRank}}；门槛 {{coop.thresholds}}',enabled:true}],profile()).forms,'目标阶 1；门槛 30、60、90、100');
});
test('worldbook upgrades keep edited forms and flags while refreshing untouched defaults',()=>{
    for(const edited of [false,true])for(const on of [false,true]){
        const previous={comment:'[coop_forms]',content:edited?'自定义形式':'旧默认形式',sdCoopDefaultHash:hash('旧默认形式'),disable:!on};
        const merged=preserveDesignTemplates(clone(bundled),[previous]);
        const entry=Object.values(merged.entries).find(e=>e.comment.includes('[coop_forms]'));
        assert.equal(entry.content,edited?previous.content:EVENT_FORM_GUIDE);
        assert.equal(entry.enabled,on);assert.equal(entry.disable,!on);
        assert.deepEqual(preserveDesignTemplates(clone(bundled),Object.values(merged.entries)),merged);
    }
});


test('general director context excludes design forms so its library is not sent a second time',()=>{
    const source=fs.readFileSync(new URL('../index.js',import.meta.url),'utf8');
    const declaration=source.match(/const plot = ours\.filter\([^\n]+/)[0];
    const entries=[...Object.values(bundled.entries),{comment:'普通剧情设定',content:'保留的背景'}];
    const plot=vm.runInNewContext(declaration+'\nplot;',{ours:entries});
    assert.ok(plot.some(e=>e.comment==='普通剧情设定'));
    assert.ok(!plot.some(e=>/\[coop_|\[mvu_update\]|\[InitVar\]/i.test(e.comment)));
});

test('runtime uses the fixed library in its one design call and still accepts a quiet cooperative plan',async t=>{
    const metadata={},messages=[],requests=[],custom='只参考共同修缮；材料和分工可协商。';
    const host={scope:()=> 'forms-test',context:()=>({}),metadata:()=>metadata,messages:()=>messages,
        available:()=>true,autoAllowed:()=>false,contextText:async()=> '画家邀请一起修复旧画框',
        designTemplates:async p=>designTemplates([{name:'[coop_forms]',enabled:true,content:custom}],p),
        locks:{request:async(name,options,fn)=>fn({name})},persist:async doc=>{metadata.storyDirectorCoop=clone(doc);},
        ask:async request=>{requests.push(request);return JSON.stringify({targetRank:1,rounds:3,title:'一起修画框',
            scene:'画室',conflict:'没有外部冲突，待协商修复样式和分工',goal:'形成双方舒适的合作方式',
            hook:'画家展示旧画框和可用材料',dilemma:'一起讨论修复样式和各自负责的步骤',question:'你想保留原来的纹样，还是试试新样式？',
            resolution:'依真实回应完成本次修复并确认分工体验',seeds:{persona:'画家',desire:'改善工作室',shadow:'合作经验不足',friction:'材料有限'},
            usedHistory:[],references:[],conflicts:[]});}};
    const runtime=new CoopRuntime(host);t.after(()=>runtime.dispose());await runtime.load();
    await runtime.configure({id:'a',name:'画家',mode:'coop',initialAffinity:30});await runtime.generate('a');
    assert.equal(requests.length,1);assert.ok(requests[0][0].content.includes(custom));
    assert.ok(!requests[0][0].content.includes(EVENT_FORM_GUIDE));
    const event=runtime.event();assert.equal(event.plan.title,'一起修画框');
    const scene=renderScene(runtime.state().profiles.a,event);
    assert.ok(scene.includes('没有外部冲突'));assert.ok(scene.includes('一起修复') || scene.includes('展示旧画框'));
    assert.ok(!scene.includes('反常切入'));assert.ok(!scene.includes('抛出矛盾'));
});
