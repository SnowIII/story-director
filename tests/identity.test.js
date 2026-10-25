import test from 'node:test';
import assert from 'node:assert/strict';
import {parseAliases,normalizeName,mentionsProfile} from '../coop/identity.js';
import {newDocument,project,appendOperation,readDocument} from '../coop/timeline.js';
import {configureRoster} from '../coop/roster.js';
import {initialState,clone} from '../coop/model.js';
import {designMessages,reportContract} from '../coop/prompts.js';
import {createHost} from '../coop/host.js';

const person={id:'npc:innetia',name:'英妮缇雅·维赛塔',aliases:['英妮缇雅','维赛塔'],mode:'coop'};
test('aliases parse punctuation and deduplicate primary, case and middle-dot variants',()=>{
    assert.deepEqual(parseAliases('英妮缇雅·维赛塔，英妮缇雅;维赛塔\n英妮缇雅',person.name),['英妮缇雅','维赛塔']);
    assert.equal(normalizeName(' 英妮缇雅 ・ 维赛塔 '),normalizeName(person.name));
    assert.deepEqual(parseAliases('ANNA,Anna,Full Name','full name'),['ANNA']);
});
for(const name of ['英妮缇雅·维赛塔','英妮缇雅','维赛塔','英妮缇雅 ・ 维赛塔']) {
    test('explicit identity variant reaches the same NPC: '+name,()=>assert.equal(mentionsProfile(person,name+'走进房间。'),true));
}
test('pronouns and unlisted abbreviations do not invent an alias',()=>{
    assert.equal(mentionsProfile(person,'她走进房间。'),false);assert.equal(mentionsProfile(person,'小雅走进房间。'),false);
    assert.throws(()=>parseAliases('英妮缇雅，她',person.name),{code:'INVALID_ALIASES'});
});
test('an English short name cannot match inside another word',()=>{
    const p={id:'ann',name:'Ann',aliases:[]};
    assert.equal(mentionsProfile(p,'Anna says hello.'),false);assert.equal(mentionsProfile(p,'Joann says hello.'),false);
    assert.equal(mentionsProfile(p,'ANN says hello.'),true);
});
test('a longer known Chinese name prevents prefix attribution to a different character',()=>{
    const a={id:'a',name:'艾琳',aliases:[]},b={id:'b',name:'艾琳娜',aliases:[]};
    assert.equal(mentionsProfile(a,'艾琳娜走进房间。',[a,b]),false);
    assert.equal(mentionsProfile(b,'艾琳娜走进房间。',[a,b]),true);
    assert.equal(mentionsProfile(a,'艾琳娜看向艾琳。',[a,b]),true);
});
test('a surname inside another full name cannot identify the wrong NPC',()=>{
    const other={id:'b',name:'阿德里安·维赛塔',aliases:['阿德里安']};
    assert.equal(mentionsProfile(person,'阿德里安·维赛塔笑了。',[person,other]),false);
    assert.equal(mentionsProfile(other,'阿德里安·维赛塔笑了。',[person,other]),true);
});
test('saving a shared alias or a new primary matching an old alias rejects ambiguous identity',()=>{
    const document=newDocument('s');configureRoster(document,initialState(),person);
    let state=project(document,new Map());const before=JSON.stringify(document);
    assert.throws(()=>configureRoster(document,state,{id:'npc:b',name:'阿德里安·维赛塔',aliases:['维赛塔'],mode:'coop'}),{code:'AMBIGUOUS_IDENTITY'});
    assert.equal(JSON.stringify(document),before);
    assert.throws(()=>configureRoster(document,state,{id:'npc:b',name:'英妮缇雅',mode:'coop'}),{code:'AMBIGUOUS_IDENTITY'});
});
test('legacy duplicate aliases stay ambiguous rather than selecting the first profile',()=>{
    const other={id:'b',name:'阿德里安·维赛塔',aliases:['维赛塔']};
    assert.equal(mentionsProfile(person,'维赛塔来了。',[person,other]),false);
    assert.equal(mentionsProfile(other,'维赛塔来了。',[person,other]),false);
    assert.equal(mentionsProfile(person,person.name+'来了。',[person,other]),true);
});
test('alias updates preserve the stable profile, previous score and lock during replay',()=>{
    const document=newDocument('s');configureRoster(document,initialState(),{...person,initialAffinity:29});
    let state=project(document,new Map());
    appendOperation(document,state,{id:'first',kind:'affinity',characterId:person.id,mode:'coop',refs:[],
        data:{characterId:person.id,delta:5,interactionId:'user-1',source:{}}},new Map());
    state=project(document,new Map());const gate=clone(state.profiles[person.id].lock);
    configureRoster(document,state,{...document.roster[person.id],aliases:['英妮缇雅','维赛塔','小雅']});
    state=project(readDocument(document,'s'),new Map());
    const p=state.profiles[person.id];assert.equal(Object.keys(state.profiles).length,1);
    assert.equal(p.affinity,30);assert.deepEqual(p.lock,gate);assert.equal(p.scoreLog.length,1);assert.equal(p.rank,0);
    assert.deepEqual(p.aliases,['英妮缇雅','维赛塔','小雅']);
});
test('old profiles default to no aliases and leave original documents intact',()=>{
    const document=newDocument('s');document.roster.a={id:'a',name:'旧角色',mode:'affinity',thresholds:[30,60,90,100]};
    const before=JSON.stringify(document);assert.deepEqual(project(document,new Map()).profiles.a.aliases,[]);
    assert.equal(JSON.stringify(document),before);
});
test('design and report prompts carry one stable ID with its explicit aliases',()=>{
    const p=initialState({[person.id]:person}).profiles[person.id];
    const messages=designMessages(p);assert.ok(messages[1].content.includes('英妮缇雅、维赛塔'));
    const contract=reportContract([p],null,{nonce:'n'},false);
    assert.ok(contract.includes('"aliases":["英妮缇雅","维赛塔"]'));assert.ok(contract.includes('固定 characterId 回报一次'));
});
test('real host eligibility accepts an alias and excludes a conflicting longer character name',t=>{
    const previous=globalThis.window,ctx={chat:[{name:'旁白',mes:'英妮缇雅走过来。',is_user:false}],characters:[]};
    globalThis.window={SillyTavern:{getContext:()=>ctx}};t.after(()=>{globalThis.window=previous;});
    const host=createHost();assert.equal(host.available(person,[person]),true);
    const other={id:'b',name:'阿德里安·维赛塔',aliases:[]};ctx.chat[0].mes='阿德里安·维赛塔走过来。';
    assert.equal(host.available(person,[person,other]),false);
});
test('excessive, invalid and overlong aliases are not silently truncated',()=>{
    for(const value of [[1],{},['长'.repeat(101)],Array.from({length:13},(_,i)=>'别名'+i)]) assert.throws(()=>parseAliases(value),{code:'INVALID_ALIASES'});
});
