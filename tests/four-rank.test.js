import test from 'node:test';
import assert from 'node:assert/strict';
import {THRESHOLDS,RANK_COUNT,RELATIONSHIP_RANK,SCHEMA,thresholds,initialState} from '../coop/model.js';
import {BLUEPRINTS,designMessages} from '../coop/prompts.js';
import {configureRoster,candidates} from '../coop/roster.js';
import {newDocument,readDocument,project} from '../coop/timeline.js';

test('four fixed gates reject extra, missing, reordered and custom thresholds',()=>{
    assert.deepEqual(THRESHOLDS,[30,60,90,100]);assert.equal(RANK_COUNT,4);assert.equal(RELATIONSHIP_RANK,3);
    for(const value of [[10,20,30,40,50,60,70,80,90,100],[30,60,90],[30,60,95,100],[60,30,90,100]]) {
        assert.throws(()=>thresholds(value),{code:'INVALID_THRESHOLDS'});
    }
    const copy=thresholds();copy[0]=1;assert.equal(THRESHOLDS[0],30);
});
test('roster configuration cannot override the fixed four gates',()=>{
    const document=newDocument('s');
    configureRoster(document,initialState(),{id:'a',name:'角色',mode:'coop'});
    const state=project(document,new Map());
    assert.throws(()=>configureRoster(document,state,{...document.roster.a,thresholds:[25,60,90,100]}),{code:'INVALID_THRESHOLDS'});
    assert.deepEqual(document.roster.a.thresholds,[30,60,90,100]);
});
test('four narrative blueprints and the relationship prompt use the same policy',()=>{
    assert.equal(BLUEPRINTS.length,4);
    const profile=initialState({a:{id:'a',name:'角色',mode:'coop'}}).profiles.a;
    const messages=designMessages(profile);
    assert.ok(messages[0].content.includes('Rank 3'));assert.ok(!messages[0].content.includes('Rank 9'));
    assert.ok(BLUEPRINTS[2].includes('关系抉择'));assert.ok(BLUEPRINTS[3].includes('沿用已确认的关系'));
});
test('unsupported save structures are rejected without attempting a legacy migration',()=>{
    const old={schemaVersion:1,scope:'s',roster:{},journal:[{id:'old-event',kind:'plan'}]};
    const before=JSON.stringify(old);
    assert.throws(()=>readDocument(old,'s'),{code:'UNSUPPORTED_SCHEMA'});assert.equal(JSON.stringify(old),before);
});
test('single-chat choices read the active card and do not invent NPCs from its description',()=>{
    const cards=[{avatar:'整合卡.png',name:'整合卡',description:'包含人物阿甲、阿乙。'},{avatar:'other.png',name:'其他卡'}];
    const choices=candidates({characters:cards,characterId:'0'});
    assert.equal(choices.length,1);assert.equal(choices[0].name,'整合卡');assert.equal(choices[0].cardRef,'整合卡.png');
});
test('group choices include only the selected group members',()=>{
    const cards=['a','b','c'].map(name=>({name,avatar:name+'.png'}));
    const context={characters:cards,characterId:1,groupId:'g',groups:[{id:'g',members:['a.png','c.png']}]};
    assert.deepEqual(candidates(context).map(c=>c.name),['a','c']);
    assert.deepEqual(candidates({...context,groupId:'missing'}),[]);
});
test('no selected card cannot accidentally offer character zero',()=>{
    const characters=[{name:'第一张卡',avatar:'first.png'}];
    for(const characterId of [undefined,null,'']) assert.deepEqual(candidates({characters,characterId}),[]);
    assert.equal(candidates({characters,characterId:0}).length,1);
});
