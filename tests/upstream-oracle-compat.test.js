import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {directorFixture} from './prompt-fixture.js';
import {setPromptEntries,PRETHINK_PROMPTS} from '../prompt-worldbook.js';

const functionSource=(source,name)=>{
    const start=source.search(new RegExp('(?:async )?function '+name+'\\('));
    assert.ok(start>=0,name);return source.slice(start,source.indexOf('\n}\n',start)+2);
};
const plain=value=>JSON.parse(JSON.stringify(value));
const reply='<StoryChapters>章标题: 合并验证\n篇章: 归港\n范围: 本章\n章目标: 完成交接\n拍:\n1. 守卫查验凭据\n剧情锚点:\n1. 凭据完成查验</StoryChapters>';

function fixture(oracleSettings={}){
    const f=directorFixture(),requests=[],warnings=[],notices=[],logs=[];
    let response=reply,currentSettings=oracleSettings;
    const controller=new AbortController(),api={context:{getSettings:()=>currentSettings},run:async(messages,options)=>{
        requests.push({messages,options});options.onDelta?.(response);return response;
    }};
    Object.assign(f.context,{oracleApi:()=>api,genId:1,genCtl:controller,genAborted:false,genChars:0,
        chatKey:()=> 'upstream-compat',lastRequestChars:0,ORACLE_CANCELLED:Symbol('cancelled'),
        buildUserPrompt:async()=> '真实上下文',aiMessageCount:()=>17,save:()=>{},
        toast:message=>notices.push(message),console:{warn:message=>warnings.push(message),info:message=>logs.push(message),debug(){}},
    });
    vm.runInContext(['configuredSystemPrompt','askOracle','providerErrorOf','reportBlockFailure'].map(name=>functionSource(f.source,name)).join('\n'),f.context);
    return {...f,api,requests,warnings,notices,logs,controller,setResponse:value=>{response=value;},setSettings:value=>{currentSettings=value;}};
}

test('upstream output-budget floor keeps invalid values safe and preserves larger configured budgets',()=>{
    const h=fixture();
    for(const [input,expected] of [[undefined,4096],[null,4096],[0,4096],[-5,4096],[NaN,4096],[Infinity,4096],['invalid',4096],[512,4096],[8192,8192],[5000.8,5001]]){
        h.setSettings({maxTokens:input});assert.equal(h.context.designMaxTokens(),expected);
    }
    h.api.context.getSettings=()=>{throw Error('settings unavailable');};
    assert.equal(h.context.designMaxTokens(),4096);assert.equal(h.context.oracleExitInfo(),null);
});

for(const mode of ['direct','profile'])test(mode+' requests retain upstream token budgets, cancellation and streaming with or without custom preThink',async t=>{
    setPromptEntries([]);t.after(()=>setPromptEntries([]));
    const h=fixture({mode,maxTokens:512,model:'test-model'});
    for(const custom of [false,true]){
        const prompt=PRETHINK_PROMPTS.chapter;
        setPromptEntries(custom?[{comment:prompt.marker,enabled:true,content:'前置说明保留上游调用约定'}]:[]);
        assert.equal(await h.context.askOracle({task:'chapter'}),reply);
        const {messages,options}=h.requests.at(-1);
        assert.equal(options.maxTokens,4096);assert.equal(options.signal,h.controller.signal);assert.equal(h.context.genChars,reply.length);
        assert.equal(messages.length,2);assert.equal(messages[1].content,'真实上下文');
        assert.equal(messages[0].content.includes('前置说明保留上游调用约定'),custom);
    }
    h.setSettings({mode,maxTokens:8192});await h.context.askOracle({task:'chapter'});
    assert.equal(h.requests.length,3);assert.equal(h.requests.at(-1).options.maxTokens,8192);
    h.controller.abort();assert.equal(await h.context.askOracle({task:'chapter'}),h.context.ORACLE_CANCELLED);assert.equal(h.requests.length,3);
});

test('upstream exit metadata reports each route and budget without dumping unrelated connection settings',()=>{
    const h=fixture({mode:'direct',model:'test-model',maxTokens:1024,sendTemperature:true,temperature:0.3,apiKey:'not-for-diagnostics'});
    const direct=plain(h.context.oracleExitInfo());
    assert.match(direct.出口,/^direct/);assert.equal(direct.模型,'test-model');assert.equal(direct.长度上限,1024);
    assert.equal(direct.实际请求上限,4096);assert.equal(direct.温度,0.3);assert.ok(!JSON.stringify(direct).includes('not-for-diagnostics'));
    h.setSettings({mode:'profile',maxTokens:8192});const profile=plain(h.context.oracleExitInfo());
    assert.match(profile.出口,/^profile/);assert.equal(profile.实际请求上限,8192);assert.equal(profile.温度,'（未覆盖）');
    h.setSettings(null);assert.equal(h.context.oracleExitInfo(),null);
});

for(const response of ['', '{"error":{"message":"test upstream quota error"}}'])test('upstream '+(response?'provider errors':'empty replies')+' retain exit diagnostics and failure classification',async()=>{
    const h=fixture({mode:'profile',maxTokens:7000});h.setResponse(response);
    await assert.rejects(h.context.askOracle({task:'chapter'}),error=>error.providerError===true);
    assert.equal(h.requests.length,1);assert.equal(h.requests[0].options.maxTokens,7000);
    assert.ok(h.warnings.some(message=>message.includes('profile')&&message.includes('7000')));
});

test('missing-block failures keep the upstream corrected hint, original reply and route metadata',()=>{
    const h=fixture({mode:'direct',model:'test-model',maxTokens:1024}),raw='模型没有按标签输出。'.repeat(600);
    assert.equal(h.context.reportBlockFailure('StoryChapters',raw),'no-block');
    const stored=plain(h.settings.run.lastRawReply);
    assert.equal(stored.tag,'StoryChapters');assert.equal(stored.at,17);assert.equal(stored.text,raw.slice(0,4000));
    assert.equal(stored.exit.实际请求上限,4096);assert.match(stored.exit.出口,/^direct/);
    assert.ok(h.notices[0].includes('这条通道不经过酒馆预设'));
    assert.ok(!h.notices[0].includes('被卡片的预设'));
    assert.ok(h.logs[0].includes(JSON.stringify(stored.exit)));
});
