import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createMessageRefreshQueue} from '../message-render.js';
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(overrides={}) {
    const messages=[{mes:'正文\n<StatusPlaceHolderImpl/>',is_user:false},{mes:'第二条',is_user:false}];
    let scope='chat-a';const calls=[],errors=[];
    const refresh=createMessageRefreshQueue({getMessages:()=>messages,getScope:()=>scope,
        render:(id,message)=>calls.push(['render',id,message.mes]),notify:async id=>{calls.push(['updated',id]);},
        onError:error=>errors.push(error),...overrides});
    return {messages,calls,errors,refresh,scope:value=>{scope=value;}};
}
test('coalesced cleanup formats the final reply once and then notifies display renderers',async()=>{
    const f=fixture();f.refresh(0);f.messages[0].mes='清理后的正文\n<StatusPlaceHolderImpl/>';f.refresh(0);f.refresh(0);
    await settle();
    assert.deepEqual(f.calls,[['render',0,'清理后的正文\n<StatusPlaceHolderImpl/>'],['updated',0]]);
});
test('a cleanup refresh preserves the placeholder and pre-existing code fences exactly',async()=>{
    const f=fixture();f.messages[0].mes='```js\nconst value=1;\n```\n\n<StatusPlaceHolderImpl/>\n';
    const before=f.messages[0].mes;f.refresh(0);await settle();
    assert.equal(f.messages[0].mes,before);assert.equal(f.calls[0][2],before);
});
test('a changed chat or replaced message cannot be refreshed by an old queued cleanup',async()=>{
    const f=fixture();f.refresh(0);f.scope('chat-b');await settle();assert.equal(f.calls.length,0);
    f.refresh(0);f.messages[0]={mes:'换了来源的回复',is_user:false};await settle();assert.equal(f.calls.length,0);
    f.refresh(0);await settle();assert.equal(f.calls[0][2],'换了来源的回复');
});
test('asynchronous display notifications finish before the next refresh replaces the HTML',async()=>{
    let release,active=0,maxActive=0;const order=[];
    const f=fixture({render:id=>order.push('render:'+id),notify:async id=>{
        active++;maxActive=Math.max(maxActive,active);order.push('start:'+id);
        if(!release) await new Promise(resolve=>{release=resolve;});
        order.push('end:'+id);active--;
    }});
    f.refresh(0);await settle();f.refresh(1);f.refresh(1);
    assert.deepEqual(order,['render:0','start:0']);release();await settle();
    assert.equal(maxActive,1);assert.deepEqual(order,['render:0','start:0','end:0','render:1','start:1','end:1']);
});
test('user, system, missing and invalid message IDs are not rewritten',async()=>{
    const f=fixture();f.messages.push({mes:'用户内容',is_user:true},{mes:'系统内容',is_system:true});
    for(const id of [-1,'0',undefined,99,2,3]) assert.equal(f.refresh(id),false);
    await settle();assert.equal(f.calls.length,0);
});
test('a failed renderer is reported and does not block later valid messages',async()=>{
    const f=fixture({render:(id)=>{if(id===0) throw new Error('display failed');}});
    f.refresh(0);f.refresh(1);await settle();assert.equal(f.errors.length,1);assert.deepEqual(f.calls,[['updated',1]]);
});
test('the director adapter emits MESSAGE_UPDATED rather than replaying a character reply',async()=>{
    const source=fs.readFileSync(new URL('../index.js',import.meta.url),'utf8');
    const start=source.indexOf('const refreshCleanedMessage = createMessageRefreshQueue(');
    const block=source.slice(start,source.indexOf('\n});',start)+4),events=[],messages=[{mes:'<StatusPlaceHolderImpl/>'}];
    const make=Function('createMessageRefreshQueue','chat','chatKey','updateMessageBlock','eventSource','event_types',block+'\nreturn refreshCleanedMessage;');
    const refresh=make(createMessageRefreshQueue,messages,()=> 'scope',()=>events.push('formatted'),
        {emit:async(...args)=>events.push(args)},{MESSAGE_UPDATED:'message_updated'});
    refresh(0);await settle();assert.deepEqual(events,['formatted',['message_updated',0]]);
});
