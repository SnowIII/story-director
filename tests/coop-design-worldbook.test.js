import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {COOP_RANK_PROMPTS,designTemplates,preserveDesignTemplates} from '../coop/design-worldbook.js';
import {designMessages,BLUEPRINTS_BY_RANK} from '../coop/prompts.js';
import {initialState,clone,hash,validatePlan} from '../coop/model.js';
const bundled=JSON.parse(fs.readFileSync(new URL('../worldbook/story-director.json',import.meta.url),'utf8'));
const profile=count=>initialState({a:{id:'a',name:'画家',mode:'coop',rankCount:count}}).profiles.a;
const history=rank=>Array.from({length:rank},(_,i)=>({rank:i+1,eventId:'e'+i,summary:'实际经历'+(i+1),choice:'实际选择',outcome:'实际结果',facts:[],openHooks:[],closedHooks:[]}));
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
for(const count of [4,7,10])test('retired common Coop rules do not override the '+count+'-rank built-ins',()=>{
    const p=profile(count);
    for(const raw of [false,true])for(const on of [false,true]){
        const entries=[{comment:'[coop_design]',content:'不应进入请求的旧配置',...(raw?{disable:!on}:{enabled:on})}];
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
    assert.equal(entries.length,35);assert.ok(!entries.some(e=>/archive|存档/.test(e.comment)));
    assert.ok(merged.entries[0].content.includes('不写入 MVU'));
});

for(const count of [4,7,10])test(count+'-rank custom blueprints include only the locked scheme and current stage with actual policy variables',()=>{
    const p=profile(count),entries=[4,7,10].map(n=>({name:'[coop_rank_'+n+']',enabled:true,
        content:'共用要求 '+n+' {{coop.rankCount}} {{coop.relationshipRank}} {{coop.thresholds}} {{coop.targetRank}} {{user}} $&\n'+
            Array.from({length:n},(_,i)=>'## Rank '+(i+1)+'\n方案'+n+'的第'+(i+1)+'阶自定义内容').join('\n')}));
    for(let rank=0;rank<count;rank++){
        p.rank=rank;p.history=history(rank);const selected=designTemplates(entries,p),messages=designMessages(p,'真实现场',selected,{rounds:2});
        assert.ok(selected.blueprint.includes('方案'+count+'的第'+(rank+1)+'阶自定义内容'));
        assert.ok(selected.blueprint.includes(p.thresholds.join('、')));assert.ok(selected.blueprint.includes('{{user}} $&'));
        for(const n of [4,7,10])for(let stage=1;stage<=n;stage++)if(n!==count || stage!==rank+1)
            assert.ok(!selected.blueprint.includes('方案'+n+'的第'+stage+'阶自定义内容'));
        assert.ok(!messages[1].content.includes(BLUEPRINTS_BY_RANK[count][rank]));
        for(const h of p.history)assert.ok(messages[1].content.includes(h.summary));
        const format=messages[0].content.split('【固定返回格式：Coop 事件设计，由程序提供】')[1];
        const sample=JSON.parse(format.slice(format.indexOf('\n')+1));
        assert.equal(sample.targetRank,rank+1);assert.equal(sample.rounds,2);assert.equal(validatePlan(sample,p).targetRank,rank+1);
    }
    p.rank=count;p.history=history(count);assert.deepEqual(designTemplates(entries,p),{});
});

test('disabled, blank, missing, ambiguous or empty current blueprint sections fall back to the built-in stage',()=>{
    const p=profile(7);p.rank=1;p.history=history(1);
    for(const content of ['',null,'## Rank 1\n只写了前一阶','## Rank 2\n\n## Rank 3\n后续内容','## Rank 2\n重复一\n## Rank 2\n重复二']){
        const entries=[{comment:'[coop_rank_7]',enabled:true,content}];
        assert.deepEqual(designTemplates(entries,p),{});
        assert.ok(designMessages(p,'',designTemplates(entries,p))[1].content.includes(BLUEPRINTS_BY_RANK[7][1]));
    }
    for(const raw of [false,true])for(const on of [false,true]){
        const entry={comment:'[coop_rank_7]',content:'当前方案的通用创作偏好',...(raw?{disable:!on,enabled:!on}:{enabled:on})};
        assert.equal(!!designTemplates([entry],p).blueprint,on);
    }
});

test('the three readable full blueprint defaults are disabled and select the same current text when explicitly enabled',()=>{
    for(const count of [4,7,10]){
        const definition=COOP_RANK_PROMPTS[count],entry=Object.values(bundled.entries).find(e=>e.comment.includes(definition.marker));
        assert.equal(entry.content,definition.content);assert.equal(entry.sdCoopDefaultHash,hash(entry.content.trim()));
        assert.equal(entry.disable,true);assert.equal(entry.enabled,false);assert.equal(entry.constant,false);assert.deepEqual(entry.key,[]);
        const p=profile(count);
        for(let rank=0;rank<count;rank++){
            p.rank=rank;const before=clone(p);
            assert.equal(designTemplates([{...entry,disable:false,enabled:true}],p).blueprint,BLUEPRINTS_BY_RANK[count][rank]);
            assert.deepEqual(p,before);
        }
    }
});

test('blueprint upgrades keep edited content and flags, while refreshing untouched older defaults',()=>{
    for(const count of [4,7,10])for(const edited of [false,true])for(const on of [false,true]){
        const previous={comment:'[coop_rank_'+count+']',content:edited?'新的阶段写法':'旧默认蓝图',sdCoopDefaultHash:hash('旧默认蓝图'),disable:!on};
        const result=preserveDesignTemplates(clone(bundled),[previous]),entry=Object.values(result.entries).find(e=>e.comment.includes('[coop_rank_'+count+']'));
        assert.equal(entry.content,edited?previous.content:COOP_RANK_PROMPTS[count].content);
        assert.equal(entry.enabled,on);assert.equal(entry.disable,!on);
        assert.deepEqual(preserveDesignTemplates(clone(bundled),Object.values(result.entries)),result);
    }
});
