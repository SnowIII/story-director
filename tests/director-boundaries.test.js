import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as model from '../model.js';
import {createMessageRefreshQueue} from '../message-render.js';

const source=fs.readFileSync(new URL('../index.js',import.meta.url),'utf8');
const code=source.slice(0,source.indexOf('\nlet appReady = false;'))
    .replace(/^import [\s\S]*? from ['"][^'"]+['"];\s*/gm,'')
    .replaceAll('import.meta.url',JSON.stringify(new URL('../index.js',import.meta.url).href));

function fixture() {
    model.setCoopScene(false);model.setInterludeWritesAllowed(false);
    const host={name:'chat-a',characterId:0,groupId:null,chat:[],chatMetadata:{},
        characters:[{name:'角色A',avatar:'a.png'},{name:'角色B',avatar:'b.png'}]};
    host.getCurrentChatId=()=>host.name;
    const data=new Map(),events=new Map(),noop=()=>{};
    const currentData=()=>{
        const key=host.characterId+':'+host.name;
        if(!data.has(key)) data.set(key,{stat_data:{[model.NS]:{}}});
        return data.get(key);
    };
    const api={getMvuData:()=>structuredClone(currentData()),replaceMvuData:async value=>{
        data.set(host.characterId+':'+host.name,structuredClone(value));
    }};
    const c=vm.createContext({...model,createMessageRefreshQueue,AbortController,URL,queueMicrotask,
        extension_settings:{},chat:host.chat,mvuApiFor:()=>api,
        console:{info:noop,debug:noop,warn:noop,error:noop},
        saveSettingsDebounced:noop,saveChatDebounced:noop,updateMessageBlock:noop,
        setExtensionPrompt:noop,extension_prompt_types:{IN_CHAT:1},extension_prompt_roles:{SYSTEM:0},
        event_types:{},eventSource:{on:(name,fn)=>events.set(name,fn),removeListener:name=>events.delete(name)},
        document:{querySelector:()=>null,getElementById:()=>null},
        setInterval:()=>1,clearInterval:noop,setTimeout:()=>1,clearTimeout:noop,
        window:{SillyTavern:{getContext:()=>host},Mvu:api,
            StoryOracleAPI:{run:async()=>'<StoryChapters>旧结果</StoryChapters>'},
            setTimeout:()=>1,clearTimeout:noop}});
    vm.runInContext(code,c,{filename:'index.js'});
    const run=s=>vm.runInContext(s,c);
    run('settings().run.chatId=chatKey();settings().run.armedAt=0;');
    const seed=()=>run(`settings().story.主线={...emptyMain(),标题:'当前章',拍:['第一拍','第二拍'],当前拍:1};
        settings().story.史诗={...emptyEpic(),标题:'篇章A',章内容:['章一','章二','章三','章四']};
        settings().story.间章=emptyInterlude();`);
    return {host,c,run,seed,currentData};
}

test('different character cards with the same chat filename retain separate plans',()=>{
    const f=fixture();f.host.name='same-name';
    f.run("settings().story.主线={标题:'A的剧情'};saveStory()");
    const first=f.run('chatKey()');f.host.characterId=1;
    assert.notEqual(f.run('chatKey()'),first);
    assert.equal(f.run('settings().story.主线?.标题'),undefined);
    f.run("settings().story.主线={标题:'B的剧情'};saveStory()");
    f.host.characterId=0;assert.equal(f.run('settings().story.主线.标题'),'A的剧情');
});

test('legacy chat slices migrate once and retain their run cursor across reloads',()=>{
    const f=fixture();
    f.run("extension_settings[ID]={chatSliceKey:'::chat-a',run:{chatId:'::chat-a',focusBeat:3},chapters:{},story:{主线:{标题:'旧计划'}}}");
    assert.equal(f.run('settings().story.主线.标题'),'旧计划');
    assert.equal(f.run('settings().run.focusBeat'),3);
    assert.equal(f.run('settings().run.chatId'),f.run('chatKey()'));
    assert.equal(f.run("Object.hasOwn(settings().chats,'::chat-a')"),false);
    f.host.characterId=1;assert.equal(f.run('settings().story.主线?.标题'),undefined);
    f.host.characterId=0;assert.equal(f.run('settings().story.主线.标题'),'旧计划');
});

test('opening more than 24 chats preserves the oldest authoritative plan',()=>{
    const f=fixture();f.run("settings().story.主线={标题:'最早的计划'};saveStory()");
    for(let i=1;i<30;i++) {f.host.name='chat-'+i;f.run('settings()');}
    f.host.name='chat-a';assert.equal(f.run('settings().story.主线.标题'),'最早的计划');
});

test('chapter history retains the latest eight chapters and counts a completed chapter once',async()=>{
    const f=fixture();f.seed();
    for(let i=1;i<=12;i++) await f.run(`rememberChapter({标题:'第${i}章',章目标:'目标${i}'})`);
    const history=Object.values(f.run('settings().chapters')).map(x=>x.标题);
    assert.deepEqual(history,Array.from({length:8},(_,i)=>'第'+(i+5)+'章'));
    const before=f.run('settings().story.史诗[EP.chapter]');
    await f.run("rememberChapter({标题:'第12章',章目标:'目标12'})");
    assert.equal(f.run('settings().story.史诗[EP.chapter]'),before);
});

test('main chapters and interludes share a chronological history window',async()=>{
    const f=fixture();f.seed();
    for(let i=1;i<=10;i++) await f.run(i%2
        ?`rememberChapter({标题:'主线${i}',章目标:'目标${i}'})`
        :`rememberInterlude({标题:'间章${i}',场合:'馆内'})`);
    assert.deepEqual(Object.values(f.run('settings().chapters')).map(x=>x.标题),
        Array.from({length:8},(_,i)=>(i%2?'间章':'主线')+(i+3)));
    assert.equal(f.run('settings().story.史诗[EP.chapter]'),5);
});

for(const enabled of [false,true]) test('interlude epic audit respects autoDirector='+enabled,async()=>{
    const f=fixture();f.seed();
    f.run(`settings().autoDirector=${enabled};settings().autoEpic=true;settings().auditEpic=true;
        settings().story.史诗[EP.chapter]=1;settings().story.间章={...emptyInterlude(),进行中:true,标题:'间章',日常画面:['聊天']};
        settings().run.closedChapter='主线:当前章';settings().run.lastGenerateAt=0;
        globalThis.auditCalls=0;generateEpic=async()=>{auditCalls++;return true}`);
    await f.run('evaluateDirector()');
    assert.equal(f.run('auditCalls'),enabled?1:0);
});

test('cancelling while collecting context prevents an oracle request',async()=>{
    const f=fixture();let release,calls=0;
    f.c.pendingContext=new Promise(resolve=>{release=resolve;});
    f.c.window.StoryOracleAPI.run=async()=>{calls++;return '旧结果';};
    f.run("buildUserPrompt=async()=>await pendingContext;beginGenerate('旧请求')");
    const request=f.run("askOracle({ephemeralSystem:'test'})");
    f.run('abortGenerate()');release('context');
    assert.equal(await request,f.run('ORACLE_CANCELLED'));assert.equal(calls,0);
});

test('an interrupted context request cannot borrow the next generation token',async()=>{
    const f=fixture();let release,calls=0;
    f.c.pendingContext=new Promise(resolve=>{release=resolve;});
    f.c.window.StoryOracleAPI.run=async()=>{calls++;return '旧结果';};
    f.run("buildUserPrompt=async()=>await pendingContext;beginGenerate('旧请求')");
    const request=f.run("askOracle({ephemeralSystem:'test'})");
    f.run("abortGenerate();beginGenerate('新请求')");release('context');
    assert.equal(await request,f.run('ORACLE_CANCELLED'));assert.equal(calls,0);
    assert.equal(f.run('storyGenerating'),true);
});

test('late oracle deltas and results cannot overwrite a newer request',async()=>{
    const f=fixture();let finish,delta;
    f.c.window.StoryOracleAPI.run=async(messages,opts)=>{delta=opts.onDelta;return new Promise(resolve=>{finish=resolve;});};
    f.run("buildUserPrompt=async()=> 'context';beginGenerate('旧请求')");
    const request=f.run("askOracle({ephemeralSystem:'test'})");await new Promise(resolve=>setImmediate(resolve));
    f.run("abortGenerate();beginGenerate('新请求');genChars=7");delta('过期输出'.repeat(20));finish('过期结果');
    assert.equal(await request,f.run('ORACLE_CANCELLED'));assert.equal(f.run('genChars'),7);
});

for(const action of ['switch','cancel','restart']) test('force-open stops its continuation after '+action,async()=>{
    const f=fixture();let release;
    f.c.pendingEpic=new Promise(resolve=>{release=resolve;});
    f.run("globalThis.opened=[];generateEpic=async()=>{beginGenerate('篇章');return await pendingEpic};generateChapter=async()=>{opened.push(chatKey());return true}");
    const task=f.run('forceOpenStory()');
    if(action==='switch') {f.host.name='chat-b';f.run('settings()');}
    else f.run("abortGenerate()"+(action==='restart'?";beginGenerate('新请求')":''));
    release(false);await task;assert.equal(f.run('opened.length'),0);
});

test('manual side-thread and vignette completion survives the next MVU callback',async()=>{
    const f=fixture();f.seed();
    for(const kind of ['支线','插曲']) {
        f.run(`settings().story['${kind}']={t1:{标题:'旧事',状态:'进行中',已落:false}}`);
        f.currentData().stat_data[model.NS][kind]={t1:{状态:'进行中',已落:false}};
        await f.run(`patchEntry('${kind}','t1',{状态:'已完成',已落:true})`);
        f.c.live=f.currentData();f.run('rootOf(live)');
        assert.equal(f.run(`settings().story['${kind}'].t1.已落`),true);
        assert.equal(f.currentData().stat_data[model.NS][kind].t1.状态,'已完成');
    }
});

test('new MVU completion flags still advance side threads and vignettes',()=>{
    const f=fixture();f.seed();
    for(const kind of ['支线','插曲']) {
        f.run(`settings().story['${kind}']={t1:{标题:'旧事',状态:'进行中',已落:false}}`);
        f.currentData().stat_data[model.NS][kind]={t1:{状态:'已完成',已落:true}};
        f.c.live=f.currentData();f.run('rootOf(live)');
        assert.equal(f.run(`settings().story['${kind}'].t1.已落`),true);
    }
});

test('review verdicts are parsed before the reasoning preview is truncated',()=>{
    const f=fixture();f.seed();
    f.host.chat.push({is_user:false,mes:'<故事导演自检>①背景：'+'叙述'.repeat(180)+'③结论：驳回</故事导演自检>正文'});
    assert.equal(f.run('harvestReviewTag(0)'),true);
    assert.equal(f.run('settings().run.reviewFromReply.state'),'驳回');
    assert.ok(f.run('settings().run.reviewThinking.length')<=300);
    assert.equal(f.host.chat[0].mes,'正文');
});

test('the last review conclusion wins while spacing around its colon remains supported',()=>{
    const f=fixture();f.seed();
    f.host.chat.push({is_user:false,mes:'<故事导演自检>结论：通过。补充核对后，结论 ： 驳回</故事导演自检>正文'});
    assert.equal(f.run('harvestReviewTag(0)'),true);
    assert.equal(f.run('settings().run.reviewFromReply.state'),'驳回');
});

test('a fresh manual force-open still works immediately after an earlier cancellation',async()=>{
    const f=fixture();
    f.run("beginGenerate('上次');abortGenerate();globalThis.opened=0;generateEpic=async()=>{const owner=beginGenerate('篇章');endGenerate(owner);return true};generateChapter=async()=>{opened++;return true}");
    await f.run('forceOpenStory()');assert.equal(f.run('opened'),1);
});

for(const group of [false,true]) test('reload verifies persisted '+(group?'group':'character')+' chat after a silent save failure',async()=>{
    const f=fixture();f.host.chat.push({is_user:false,mes:'尚未保存的正文'});
    if(group) f.host.groupId='group-a';
    f.host.saveChat=async()=>{};f.host.getRequestHeaders=()=>({});
    let disk=[{chat_metadata:{}}],endpoint;
    f.c.fetch=async url=>{endpoint=url;return {ok:true,json:async()=>disk};};
    await assert.rejects(f.run('saveChatBeforeReload()'),/保存|存档/);
    disk=[{chat_metadata:f.host.chatMetadata},...f.host.chat];
    await f.run('saveChatBeforeReload()');
    assert.equal(endpoint,group?'/api/chats/group/get':'/api/chats/get');
});
