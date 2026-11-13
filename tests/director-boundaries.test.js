import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as model from '../model.js';
import {createMessageRefreshQueue} from '../message-render.js';
import {designTemplates} from '../coop/design-worldbook.js';

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
        document:{querySelector:()=>null,getElementById:()=>null,createElement:()=>({textContent:'',
            get innerHTML(){return this.textContent.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');}})},
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
    return {host,c,run,seed,currentData,events,api};
}

function generationFixture() {
    const f=fixture(),notices=[];let requests=0;
    f.c.window.toastr=Object.fromEntries(['info','warning','error','success'].map(type=>[type,message=>notices.push({type,message})]));
    f.c.window.StoryOracleAPI.run=async()=>{requests++;return '<StoryChapters>旧结果</StoryChapters>';};
    return {...f,notices,requests:()=>requests};
}

function coopModeFixture({onlyCoop=false}={}) {
    const f=generationFixture(),slots={},listeners={},timers=[];
    const power={classList:{toggle(){}},querySelector:selector=>({
        addEventListener:(name,handler)=>{listeners[selector]=handler;},
    })};
    f.c.testPanel={hidden:true,querySelector:selector=>selector==='.sd-powerbar'?power:null,querySelectorAll:()=>[]};
    f.c.document.body={};
    f.c.window.setTimeout=(fn,delay)=>timers.push({fn,delay});
    f.c.event_types.CHAT_CHANGED='chat_changed';
    f.c.event_types.WORLDINFO_ENTRIES_LOADED='worldinfo_entries_loaded';
    f.c.setExtensionPrompt=(slot,text)=>{slots[slot]=text;};
    f.c.world_info={};
    f.c.isGenerating=()=>false;
    let oracleMode,activeMode=false,modeClicks=0;
    const modeButton={hidden:false,classList:{contains:()=>activeMode},click:()=>{activeMode=false;modeClicks++;}};
    const oracleHeader={dataset:{},firstChild:modeButton};
    modeButton.parentNode=oracleHeader;
    f.c.document.querySelector=selector=>selector==='#so-header-btns'?oracleHeader:null;
    f.c.document.getElementById=id=>id==='so-story-director-btn'&&oracleMode?modeButton:null;
    f.c.window.StoryOracleAPI.registerMode=mode=>{oracleMode=mode;return true;};
    f.c.setPromptEntries=()=>{};
    f.c.designTemplates=designTemplates;
    let options,syncs=0;
    f.c.createCoopSystem=value=>{
        options=value;
        const syncMvu=Object.assign(async()=>{syncs++;},{updateLive:()=>{}});
        return {syncMvu,occupies:()=>false,injection:()=>'<Coop>演出</Coop>',variableContract:()=>'<Coop>好感契约</Coop>'};
    };
    f.run(`makeBubble=()=>{};makePanel=()=>{panel=testPanel};injectWandEntry=()=>{};exposeDiagnostics=()=>{};
        settings().autoInstallBook=false;settings().autoUpdateBook=false;
        ${onlyCoop?'settings().onlyCoop=true;':''}
        init();renderPower();`);
    const toggle=checked=>{
        const target={checked};listeners['.sd-only-coop']({target});return target.checked;
    };
    const prompt=key=>slots[f.run('SLOT.'+key)];
    const settle=()=>new Promise(resolve=>setImmediate(resolve));
    return {...f,options,toggle,prompt,settle,syncs:()=>syncs,timers,oracleMode:()=>oracleMode,
        modeButton,activateMode:()=>{activeMode=true;},modeClicks:()=>modeClicks};
}

test('the mode switch freezes saved story progress and leaves manual Coop and its prompts available',async()=>{
    const f=coopModeFixture();await f.settle();f.seed();
    f.run('saveStory();syncMainInjection()');
    assert.equal(f.run('settings().onlyCoop'),false);
    assert.ok(f.oracleMode());
    assert.match(f.prompt('main'),/当前章/);
    f.c.isGenerating=()=>true;
    assert.equal(f.toggle(true),false);
    f.c.isGenerating=()=>false;
    for(const busy of ["beginGenerate('正在生成')",'evaluating=true','coop.job={}','coop.store={pending:true}']) {
        f.run(busy);assert.equal(f.toggle(true),false);
        f.run('endGenerate(genId);evaluating=false;delete coop.job;delete coop.store');
    }
    const story=f.run('JSON.stringify(settings().story)');
    f.activateMode();
    assert.equal(f.toggle(true),true);
    assert.equal(f.modeButton.hidden,true);
    assert.equal(f.modeClicks(),1);
    assert.equal(f.run('settings().tab'),'coop');
    assert.equal(f.prompt('main'),'');
    assert.equal(f.prompt('contract'),'<Coop>好感契约</Coop>');
    assert.equal(f.prompt('coop'),'<Coop>演出</Coop>');
    assert.equal(f.options.autoAllowed(),true);
    await f.run('generateChapter({force:true})');
    await f.run('generateThread({force:true})');
    assert.equal(f.requests(),0);
    const run=f.run('JSON.stringify(settings().run)');
    f.options.sceneChanged(true);f.host.chat.push({is_user:false,mes:'独立 Coop 正文'});f.options.sceneChanged(false);
    assert.equal(f.run('JSON.stringify(settings().run)'),run);
    f.run('setMaster(false)');
    assert.equal(f.options.autoAllowed(),false);
    assert.equal(f.prompt('coop'),'<Coop>演出</Coop>');
    await f.options.ask([{role:'user',content:'手动设计 Coop'}],new AbortController().signal);
    assert.equal(f.requests(),1);
    assert.equal(f.run('JSON.stringify(settings().story)'),story);
    assert.equal(f.toggle(false),false);
    assert.equal(f.run('settings().onlyCoop'),false);
    assert.equal(f.modeButton.hidden,false);
    assert.match(f.prompt('main'),/当前章/);
    await f.settle();
});

test('the mode switch stays locked until both pending MVU writes finish after namespace initialization',async()=>{
    const f=coopModeFixture();await f.settle();
    f.currentData().stat_data[model.NS]={};
    const pending=[],replace=f.api.replaceMvuData;
    f.api.replaceMvuData=(value,scope)=>new Promise(resolve=>{
        pending.push({type:scope.type,finish:async()=>{await replace(value);resolve();}});
    });
    const initialized=f.run('ensureNamespace()');
    await f.settle();
    assert.deepEqual(pending.map(write=>write.type),['message']);
    const complete=await Promise.race([initialized.then(()=>true),f.settle().then(()=>false)]);
    assert.equal(complete,true);
    assert.equal(f.toggle(true),false);
    await pending.shift().finish();await f.settle();
    assert.deepEqual(pending.map(write=>write.type),['chat']);
    assert.equal(f.toggle(true),false);
    await pending.shift().finish();await f.settle();
    assert.equal(f.toggle(true),true);
});

test('a saved standalone Coop mode survives startup signals and filters only our worldbook injections',async()=>{
    const f=coopModeFixture({onlyCoop:true});await f.settle();
    assert.equal(f.syncs(),1);
    assert.equal(f.oracleMode(),undefined);
    const book='故事导演';
    const entries=Object.freeze([
        Object.freeze({world:book,comment:'[mvu_update] 剧情契约',content:'应屏蔽'}),
        Object.freeze({world:book,name:'[InitVar] 剧情变量',content:'应屏蔽'}),
        Object.freeze({world:'角色卡',comment:'[mvu_update] 角色契约',content:'应保留'}),
        Object.freeze({world:book,comment:'[coop_rank_4]',enabled:true,content:'自定义蓝图'}),
        Object.freeze({world:book,comment:'[coop_forms]',enabled:true,content:'自定义事件形式'}),
    ]);
    f.host.loadWorldInfo=async name=>{assert.equal(name,book);return {entries};};
    const groups=Object.fromEntries(['globalLore','characterLore','chatLore','personaLore'].map(key=>[key,[...entries]]));
    f.events.get('worldinfo_entries_loaded')(groups);
    for(const group of Object.values(groups)) assert.deepEqual(group,entries.slice(2));
    assert.deepEqual(await f.options.designTemplates({rank:0}),{forms:'自定义事件形式',blueprint:'自定义蓝图'});
    f.host.name='chat-b';f.events.get('chat_changed')();
    const incoming={stat_data:{[book]:{主线:{标题:'不要导入的旧章',当前拍:2,本拍已落:true}}}};
    Object.assign(f.currentData(),structuredClone(incoming));
    f.events.get('mag_variable_update_ended')(incoming);
    f.events.get('mag_variable_initialized')();
    model.setCoopMvuAuthority(true);
    try {
        const main={type:'set',args:[`${book}.主线.本拍已落`,'false']};
        const affinity={type:'set',args:[`${book}.Coop.角色["画家"].好感度`,'20']};
        const ownCard={type:'set',args:['角色卡.状态','"正常"']};
        const commands=[main,affinity,ownCard];
        f.events.get('mag_command_parsed')(incoming,commands);
        assert.deepEqual(commands,[affinity,ownCard]);
        assert.equal(incoming.stat_data[book].主线.本拍已落,true);
    } finally { model.setCoopMvuAuthority(false); }
    for(const timer of f.timers.splice(0)) if(timer.delay!==1500) timer.fn();
    await f.settle();
    assert.equal(f.run('settings().story.主线?.标题'),undefined);
    assert.deepEqual(f.currentData(),incoming);
    assert.equal(f.prompt('main'),'');
    assert.equal(f.requests(),0);
    f.toggle(false);
    assert.ok(f.oracleMode());
    const restored={globalLore:[...entries]};f.events.get('worldinfo_entries_loaded')(restored);
    assert.deepEqual(restored.globalLore,entries);
    await f.settle();
});

for(const kind of ['event','coop-job','story-job']) test('force-open explains '+kind+' without recording a failed chapter or resetting progress',async()=>{
    const f=generationFixture();f.seed();
    f.run("settings().run.closedChapter='保留收尾状态';settings().run.lastGenerateAt=51;");
    if(kind==='event') f.run("coop={occupies:()=>true,event:()=>({characterId:'sig',targetRank:2}),state:()=>({profiles:{sig:{name:'希格露恩·血牙'}}})}");
    if(kind==='coop-job') f.run("coop={occupies:()=>true,event:()=>null,job:{label:'核对事件归档'}}");
    if(kind==='story-job') f.run("storyGenerating=true;storyGeneratingSince=Date.now();genLabel='篇章检查'");
    const before=f.run('JSON.stringify({story:settings().story,run:settings().run})');
    const attempt=f.run('JSON.stringify(lastAttempt)');
    await f.run('forceOpenStory()');
    assert.equal(f.requests(),0);assert.equal(f.run('JSON.stringify(lastAttempt)'),attempt);
    assert.equal(f.run('JSON.stringify({story:settings().story,run:settings().run})'),before);
    assert.equal(f.notices.length,1);assert.equal(f.notices[0].type,'info');
    if(kind==='event') {assert.match(f.notices[0].message,/希格露恩·血牙.*Rank 2/);assert.match(f.notices[0].message,/暂停演出/);}
    if(kind==='coop-job') {assert.match(f.notices[0].message,/核对事件归档/);assert.match(f.notices[0].message,/中断生成/);}
    if(kind==='story-job') {assert.match(f.notices[0].message,/篇章检查/);assert.match(f.notices[0].message,/等待|中断/);}
});

for(const action of ['generateChapter','generateEpic','generateThread','generateInterlude','generateInterludeChapter']) test('manual '+action+' explains a Coop block and automatic checks stay quiet',async()=>{
    const f=generationFixture();f.seed();
    f.run("coop={occupies:()=>true,event:()=>({characterId:'sig',targetRank:2}),state:()=>({profiles:{sig:{name:'画家'}}})}");
    await f.run(action+'({quiet:true,force:true})');assert.equal(f.notices.length,0);
    await f.run(action+'({quiet:false,force:true})');
    assert.equal(f.requests(),0);assert.equal(f.notices.length,1);assert.equal(f.notices[0].type,'info');
    assert.match(f.notices[0].message,/画家.*Rank 2/);assert.match(f.notices[0].message,/暂停演出/);
});

for(const transient of [false,true]) test('a '+(transient?'transient ':'')+'Coop block after the epic request does not become a generic chapter failure',async()=>{
    const f=generationFixture();
    f.run(`generateEpic=async()=>{coop={occupies:()=>${transient?'(queueMicrotask(()=>{coop=null}),true)':'true'},event:()=>({characterId:'sig',targetRank:2}),state:()=>({profiles:{sig:{name:'画家'}}})};return true}`);
    const attempt=f.run('JSON.stringify(lastAttempt)');
    await f.run('forceOpenStory()');
    assert.equal(f.requests(),0);assert.equal(f.run('JSON.stringify(lastAttempt)'),attempt);
    assert.ok(f.notices.some(n=>/画家.*Rank 2/.test(n.message)));
    assert.ok(f.notices.every(n=>n.type!=='error'));
});

test('Coop block hints escape character names and keep Coop model calls available',()=>{
    const f=generationFixture();
    f.run("coop={occupies:()=>true,event:()=>({characterId:'sig',targetRank:2}),state:()=>({profiles:{sig:{name:'<b>画家</b>'}}})}");
    assert.equal(f.run("beginGenerate('下一章',{quiet:false})"),false);
    assert.match(f.notices[0].message,/&lt;b&gt;画家&lt;\/b&gt;/);assert.ok(!f.notices[0].message.includes('<b>'));
    assert.ok(f.run("beginGenerate('Coop 羁绊事件')")>0);f.run('endGenerate(genId)');
});

test('the blocked-generation hint preserves watchdog recovery for an expired task',()=>{
    const f=generationFixture();
    f.run("storyGenerating=true;storyGeneratingSince=Date.now()-GENERATE_WATCHDOG-1;genLabel='旧任务'");
    assert.ok(f.run("beginGenerate('下一章',{quiet:false})")>0);
    assert.equal(f.notices.length,0);f.run('endGenerate(genId)');
});

for(const kind of ['transport','format']) test('real '+kind+' failure keeps its details without promising a nonexistent response',async()=>{
    const f=generationFixture();f.seed();
    f.run(kind==='transport'?"askOracle=async()=>{throw new Error('HTTP 502')}":"askOracle=async()=> '模型这次没有按章节格式输出'");
    await f.run('forceOpenStory()');
    assert.equal(f.run('lastAttempt.key'),'fail');
    assert.ok(f.notices.some(n=>n.type==='error'||n.type==='warning'));
    assert.ok(f.notices.every(n=>!n.message.includes('控制台里有 [故事导演] 的原始回复')));
    if(kind==='transport') assert.equal(f.run('settings().run.lastRawReply'),null);
    else assert.equal(f.run('settings().run.lastRawReply.tag'),'StoryChapters');
});

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

test('strengthened outline harvests a structured receipt and strips it from the visible reply',()=>{
    const f=fixture();f.seed();
    f.run("settings().strengthenOutline=true;settings().story.主线.剧情锚点=['守卫收到旧信','第二拍锚点']");
    f.host.chat.push({is_user:false,mes:`<故事导演自检>
当前拍锚点：守卫收到旧信
本轮推进层级：结果
本拍完成：是
完成证据：守卫把旧信锁进证物箱
结论：通过
</故事导演自检>
正文`});
    assert.equal(f.run('harvestReviewTag(0)'),true);
    assert.equal(f.run('settings().run.outlineReceipt.anchorMatched'),true);
    assert.equal(f.run('settings().run.outlineReceipt.stage'),'结果');
    assert.equal(f.run('settings().run.outlineReceipt.landed'),true);
    assert.equal(f.host.chat[0].mes.trim(),'正文');
});

test('turning outline strengthening off keeps legacy self-check handling without a strict receipt',()=>{
    const f=fixture();f.seed();
    f.host.chat.push({is_user:false,mes:'<故事导演自检>结论：通过</故事导演自检>正文'});
    assert.equal(f.run('harvestReviewTag(0)'),true);
    assert.equal(f.run('settings().run.outlineReceipt'),null);
    assert.equal(f.run('settings().run.reviewFromReply.state'),'通过');
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

const anchoredReply='<StoryChapters>\n章标题: 新章\n章目标: 找到来信缘由\n拍:\n1. 信使递信\n2. 守卫辨认印章\n剧情锚点:\n1. 守卫收到旧信\n2. 印章来历明确\n</StoryChapters>';

test('chapter generation saves anchors in the same single oracle request while strengthening is off',async()=>{
    const f=fixture();f.seed();const requests=[];
    f.run("buildUserPrompt=async()=> '测试上下文'");
    f.c.window.StoryOracleAPI.run=async messages=>{requests.push(messages);return anchoredReply;};
    assert.equal(await f.run('generateChapter({force:true,keep:0})'),true);
    assert.equal(requests.length,1);assert.ok(requests[0][0].content.includes('剧情锚点:'));
    assert.equal(f.run('settings().strengthenOutline'),false);
    assert.deepEqual(Array.from(f.run('mainState()[MAIN_ANCHORS]')),['守卫收到旧信','印章来历明确']);
    assert.equal(f.currentData().stat_data.故事导演.主线.剧情锚点,undefined);
});

test('strengthened chapter generation warns when one anchor contains multiple result-like clauses',async()=>{
    const f=generationFixture();f.seed();
    f.run("settings().strengthenOutline=true;buildUserPrompt=async()=> '测试上下文'");
    f.c.window.StoryOracleAPI.run=async()=>anchoredReply.replace('守卫收到旧信','守卫收到旧信；当场认出寄信人');
    assert.equal(await f.run('generateChapter({force:true,keep:0,quiet:false})'),true);
    assert.ok(f.notices.some(n=>n.type==='warning'&&n.message.includes('每拍只写一个可验证结果')));
    assert.equal(f.run('mainState()[MAIN_ANCHORS][0]'),'守卫收到旧信；当场认出寄信人');
});

for(const anchors of ['', '剧情锚点:\n1. 缺一项\n', '剧情锚点:\n1.\n2. 非空\n', '剧情锚点:\n1. 重复\n1. 编号\n'])
test('incomplete generated anchors leave the previous plan intact without extra calls: '+JSON.stringify(anchors),async()=>{
    const f=generationFixture();f.seed();let requests=0;
    f.run("buildUserPrompt=async()=> '测试上下文'");
    f.c.window.StoryOracleAPI.run=async()=>{requests++;return anchoredReply.replace(/剧情锚点:[\s\S]*?<\/StoryChapters>/,anchors+'</StoryChapters>');};
    const before=f.run('JSON.stringify(settings().story)');
    assert.equal(await f.run('generateChapter({force:true,keep:0})'),false);
    assert.equal(requests,1);assert.equal(f.run('JSON.stringify(settings().story)'),before);
    assert.ok(f.notices.some(n=>n.message.includes('剧情锚点')));
});

test('partial replans preserve played anchors and replace only remaining anchors, with the same beat cap',async()=>{
    const f=fixture();f.seed();
    f.run("settings().story.主线.当前拍=2;settings().story.主线.剧情锚点=['已演锚点','废弃锚点']");
    f.c.reply=anchoredReply;
    await f.run('applyChapter(chapterFromBlock(reply),{keep:1,quiet:true})');
    assert.deepEqual(Array.from(f.run('mainState()[MAIN_BEATS]')),['第一拍','信使递信','守卫辨认印章']);
    assert.deepEqual(Array.from(f.run('mainState()[MAIN_ANCHORS]')),['已演锚点','守卫收到旧信','印章来历明确']);
    assert.equal(f.run('currentBeat(mainState())'),2);
    await f.run('applyChapter(normalizeChapter({beats:Array.from({length:10},(_,i)=>"新拍"+i),anchors:Array.from({length:10},(_,i)=>"新锚"+i)}),{keep:1,quiet:true})');
    assert.equal(f.run('mainState()[MAIN_ANCHORS].length'),f.run('BEAT_MAX'));
    assert.equal(f.run('mainState()[MAIN_ANCHORS].length'),f.run('mainState()[MAIN_BEATS].length'));
    await f.run('applyChapter(chapterFromBlock(reply),{restart:true,quiet:true})');
    assert.deepEqual(Array.from(f.run('mainState()[MAIN_ANCHORS]')),['守卫收到旧信','印章来历明确']);
    assert.equal(f.run('currentBeat(mainState())'),1);
});

test('the actual settings checkbox updates narrative guidance and the preflight contract immediately',()=>{
    const f=fixture();f.seed();const slots={},listeners={};
    const node={checked:true,addEventListener:(name,fn)=>{listeners[name]=fn;}};
    const view={innerHTML:'',querySelector:selector=>selector==='[name="strengthen-outline"]'?node:null};
    f.c.testPanel={hidden:true,querySelector:selector=>selector==='.sd-set-tab'?view:null};
    f.c.setExtensionPrompt=(name,value)=>{slots[name]=value;};
    f.run("settings().story.主线.剧情锚点=['当前独立锚点','未来独立锚点'];panel=testPanel;renderSetTab();syncMainInjection()");
    const oldContract=slots[f.run('SLOT.contract')];
    assert.ok(view.innerHTML.includes('大纲遵循强化'));assert.equal(node.checked,false);
    node.checked=true;listeners.change();
    assert.equal(f.run('settings().strengthenOutline'),true);
    const text=slots[f.run('SLOT.main')];
    assert.ok(text.includes('<本拍剧情锚点>当前独立锚点</本拍剧情锚点>'));
    assert.ok(text.includes('章目标只用于判断方向'));assert.ok(!text.includes('未来独立锚点'));
    const strongContract=slots[f.run('SLOT.contract')];
    assert.notEqual(strongContract,oldContract);
    assert.ok(strongContract.includes('<当前拍锚点>当前独立锚点</当前拍锚点>'));
    assert.ok(strongContract.includes('只负责“写之前检查怎么推进”'));
    assert.ok(strongContract.includes('最终正文的世界状态回报为准'));
    assert.ok(!strongContract.includes('本拍完成：是 / 否'));
    assert.ok(!strongContract.includes('未来独立锚点'));
    f.run('panel=null');node.checked=false;listeners.change();
    for(const key of ['main','contract'])assert.ok(!slots[f.run('SLOT.'+key)].includes('本拍剧情锚点'));
    assert.equal(slots[f.run('SLOT.contract')],oldContract);
});

test('main form saves anchors without resetting unchanged beat progress and rejects mismatched entries',async()=>{
    const f=generationFixture();f.seed();f.run("settings().story.主线.当前拍=2;settings().story.主线.本拍已落=true;settings().run.landedHold='第2拍'");
    const values={'main-title':'当前章','main-beats':'1. 第一拍\n2. 第二拍','main-anchors':'1. 新锚一\n2. 新锚二'};
    const view={querySelector:selector=>({value:values[selector.match(/name="([^"]+)"/)[1]] || ''})};
    f.c.testPanel={hidden:true,querySelector:selector=>selector==='.sd-main-tab'?view:null};f.run('panel=testPanel;render=()=>{}');
    await f.run('saveMainFromForm()');
    assert.equal(f.run('currentBeat(mainState())'),2);
    assert.deepEqual(Array.from(f.run('mainState()[MAIN_ANCHORS]')),['新锚一','新锚二']);
    assert.equal(f.run('mainState()[KEY_BEAT_DONE]'),true);assert.equal(f.run('settings().run.landedHold'),'第2拍');
    values['main-anchors']='1. 错误数量';const before=f.run('JSON.stringify(settings().story)');
    await f.run('saveMainFromForm()');assert.equal(f.run('JSON.stringify(settings().story)'),before);
    assert.ok(f.notices.some(n=>n.type==='warning'&&n.message.includes('逐条对应')));
    values['main-beats']='';values['main-anchors']='';await f.run('saveMainFromForm()');
    assert.equal(f.run('mainState()[MAIN_ANCHORS].length'),0);assert.equal(f.run('mainState()[MAIN_BEATS].length'),0);
});

test('strengthened outline warns about multi-result anchors without silently rewriting them',async()=>{
    const f=generationFixture();f.seed();
    f.run('settings().strengthenOutline=true');
    const values={'main-title':'当前章','main-beats':'1. 第一拍','main-anchors':'1. 守卫收到旧信；当场认出寄信人'};
    const view={querySelector:selector=>({value:values[selector.match(/name="([^"]+)"/)[1]] || ''})};
    f.c.testPanel={hidden:true,querySelector:selector=>selector==='.sd-main-tab'?view:null};
    f.run('panel=testPanel;render=()=>{}');
    await f.run('saveMainFromForm()');
    assert.equal(f.run('mainState()[MAIN_ANCHORS][0]'),'守卫收到旧信；当场认出寄信人');
    assert.ok(f.notices.some(n=>n.type==='warning'&&n.message.includes('每拍只写一个可验证结果')));
});
