import test from 'node:test';
import assert from 'node:assert/strict';
import {createHost} from '../coop/host.js';
import {configureRoster,candidates} from '../coop/roster.js';
import {newDocument,project} from '../coop/timeline.js';
import {initialState} from '../coop/model.js';
import {designMessages} from '../coop/prompts.js';
const npc={id:'npc:test',name:'英妮缇雅',aliases:['维赛塔'],mode:'coop',description:''};
function install(t,context,oracle){const previous=globalThis.window;
    globalThis.window={SillyTavern:{getContext:()=>context},...(oracle?{StoryOracleAPI:{context:oracle}}:{})};
    t.after(()=>{globalThis.window=previous;});return createHost();}
test('a named NPC can be registered without supplemental settings',()=>{
    const doc=newDocument('s');configureRoster(doc,initialState(),npc);
    const p=project(doc,new Map()).profiles[npc.id];assert.equal(p.description,'');assert.equal(p.name,npc.name);
});
test('an NPC with no cardRef receives its current story card, worldbook and recent dialogue',async t=>{
    let options;
    const ctx={characterId:0,characters:[{avatar:'dnd.png',name:'整合卡',description:'英妮缇雅是流亡修女。',personality:'她对陌生人保持警惕。'}],
        chat:[{is_user:true,mes:'我询问维赛塔过去的经历。'},{name:'旁白',mes:'英妮缇雅取出旧徽章。'}]};
    const host=install(t,ctx,{buildWorldInfo:async opts=>{options=opts;return '世界书：她一直珍视这枚徽章。';}});
    const text=await host.contextText(npc);
    for(const fact of ['流亡修女','对陌生人保持警惕','世界书：她一直珍视','我询问维赛塔','取出旧徽章']) assert.ok(text.includes(fact));
    assert.equal(options.extraScanText,'英妮缇雅 维赛塔');assert.ok(options.excludeBooks.includes('故事导演'));
});
test('group NPC context includes member cards while excluding unrelated library cards',async t=>{
    const ctx={groupId:'g',groups:[{id:'g',members:['a.png','b.png']}],characters:[
        {name:'A',avatar:'a.png',description:'甲方背景'}, {name:'B',avatar:'b.png',description:'乙方背景'},
        {name:'C',avatar:'c.png',description:'不相关的另一世界'}],chat:[]};
    const text=await install(t,ctx).contextText(npc);
    assert.ok(text.includes('甲方背景'));assert.ok(text.includes('乙方背景'));assert.ok(!text.includes('不相关的另一世界'));
});
test('a selected card reads current source facts and keeps optional supplements separate',async t=>{
    const ctx={characterId:1,characters:[{name:'A',avatar:'a.png',description:'目标角色最新设定'},
        {name:'B',avatar:'b.png',description:'其他人的设定'}],chat:[]};
    const p=project({...newDocument('s'),roster:{a:{id:'a',name:'A',cardRef:'a.png',mode:'coop',description:'额外补充：守口如瓶',thresholds:[30,60,90,100]}}},new Map()).profiles.a;
    const text=await install(t,ctx).contextText(p),messages=designMessages(p,text);
    assert.ok(text.includes('目标角色最新设定'));assert.ok(!text.includes('其他人的设定'));
    assert.ok(messages[1].content.includes('补充设定（可选）：\n额外补充：守口如瓶'));
});
test('transcript length limits retain the latest story rather than only its old prefix',async t=>{
    const ctx={characterId:0,characters:[{name:'整合卡',avatar:'a.png'}],chat:[
        {is_user:false,mes:'很早的段落'+'旧'.repeat(19000)},{is_user:true,mes:'最新行动：送还徽章。'}]};
    const text=await install(t,ctx).contextText(npc);
    assert.ok(text.includes('最新行动：送还徽章。'));assert.ok(!text.includes('很早的段落'));
});
test('automatic card facts are not copied into the optional supplement field for new candidates',()=>{
    const c=candidates({characterId:0,characters:[{name:'整合卡',avatar:'a.png',description:'很长的原始角色设定'}]})[0];
    assert.equal(c.description,'');assert.equal(c.cardRef,'a.png');
    const p=project({...newDocument('s'),roster:{a:{...npc,id:'a',thresholds:[30,60,90,100]}}},new Map()).profiles.a;
    const messages=designMessages(p,'可用故事资料');
    assert.ok(messages[0].content.includes('补充设定可以为空'));assert.ok(messages[1].content.includes('未填写，请从下面'));
});
