import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {designTemplates,preserveDesignTemplates} from '../coop/design-worldbook.js';
import {designMessages,BLUEPRINTS_BY_RANK} from '../coop/prompts.js';
import {initialState,clone} from '../coop/model.js';
const bundled=JSON.parse(fs.readFileSync(new URL('../worldbook/story-director.json',import.meta.url),'utf8'));
const profile=count=>initialState({a:{id:'a',name:'画家',mode:'coop',rankCount:count}}).profiles.a;
for(const count of [4,7,10])test('fixed Coop rules select only the current stage of the '+count+'-rank plan',()=>{
    const p=profile(count);
    for(let rank=0;rank<count;rank++){
        p.rank=rank;p.history=Array.from({length:rank},(_,i)=>({rank:i+1,eventId:'e'+i,summary:'实际经历',choice:'用户选择',outcome:'结果',facts:[],openHooks:[],closedHooks:[]}));
        const selected=designTemplates(Object.values(bundled.entries),p),messages=designMessages(p,'现场资料',selected);
        assert.deepEqual(selected,{});assert.ok(messages[1].content.includes(BLUEPRINTS_BY_RANK[count][rank]));
        assert.ok(messages[0].content.includes('【程序契约】角色已锁定 '+count+' 阶'));
        if(rank+1<count)assert.ok(!messages[1].content.includes(BLUEPRINTS_BY_RANK[count][rank+1]));
    }
});
for(const count of [4,7,10])test('retired '+count+'-rank and common worldbook entries no longer override built-ins',()=>{
    const p=profile(count);
    for(const raw of [false,true])for(const on of [false,true]){
        const entries=['design','forms','rank_'+count].map(key=>({comment:'[coop_'+key+']',content:'不应进入请求的旧配置',...(raw?{disable:!on}:{enabled:on})}));
        const selected=designTemplates(entries,p),messages=designMessages(p,'现场资料',selected);
        assert.deepEqual(selected,{});assert.ok(!JSON.stringify(messages).includes('不应进入请求的旧配置'));
        assert.ok(messages[1].content.includes(BLUEPRINTS_BY_RANK[count][0]));
    }
});
test('worldbook upgrades discard legacy config without archives, preserve current field edits and renew MVU contracts',()=>{
    const installed=[{comment:'[coop_design]',content:'旧 Coop 配置',enabled:true},{comment:'[sd_prompt_epic]',content:'旧整段配置',enabled:true},
        {comment:'[mvu_update]',content:'旧变量契约'},{comment:'[sd_field_chapter_goal]',content:'保留的新字段写法',disable:false}];
    const merged=preserveDesignTemplates(clone(bundled),installed),entries=Object.values(merged.entries);
    assert.ok(!JSON.stringify(merged).includes('旧 Coop 配置'));assert.ok(!JSON.stringify(merged).includes('旧整段配置'));
    assert.notEqual(merged.entries[0].content,'旧变量契约');
    assert.equal(entries.find(e=>e.comment.includes('[sd_field_chapter_goal]')).content,'保留的新字段写法');
    assert.equal(entries.length,26);assert.ok(!entries.some(e=>/archive|存档/.test(e.comment)));
    assert.ok(merged.entries[0].content.includes('不写入 MVU'));
});
