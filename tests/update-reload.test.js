import test from 'node:test';
import assert from 'node:assert/strict';
import {createUpdateReloader} from '../update-reload.js';

function fixture(t,overrides={}) {
    let latest='0.40.3',busy=false,next=0;
    const calls=[],errors=[],timers=new Map();
    const monitor=createUpdateReloader({version:'0.40.3',readVersion:async()=>latest,isBusy:()=>busy,
        flush:async()=>{calls.push('save');},reload:()=>{calls.push('reload');},notify:()=>{calls.push('notice');},
        onError:error=>errors.push(error),setTimer:(fn,delay)=>{timers.set(++next,{fn,delay});return next;},
        clearTimer:id=>timers.delete(id),...overrides});
    t.after(()=>monitor.dispose());
    return {monitor,calls,errors,timers,version:value=>{latest=value;},busy:value=>{busy=value;}};
}

test('unchanged versions only schedule a low-frequency check and never save or reload',async t=>{
    const h=fixture(t);
    await h.monitor.check();await h.monitor.check();
    assert.deepEqual(h.calls,[]);assert.equal(h.timers.size,1);
    assert.equal([...h.timers.values()][0].delay,30000);
});

test('an external version change is confirmed twice before saving and reloading once',async t=>{
    const h=fixture(t);h.version('0.40.4');
    assert.equal(await h.monitor.check(),false);assert.deepEqual(h.calls,[]);
    assert.equal([...h.timers.values()][0].delay,1000);
    assert.equal(await h.monitor.check(),true);
    assert.deepEqual(h.calls,['notice','save','reload']);assert.equal(h.timers.size,0);
    await h.monitor.check();h.monitor.request();assert.equal(h.calls.length,3);
});

test('a transient or changing manifest does not prematurely confirm an update',async t=>{
    const h=fixture(t);
    for(const version of ['0.40.4','0.40.3','0.40.4','0.40.5']) {h.version(version);await h.monitor.check();}
    assert.deepEqual(h.calls,[]);
    await h.monitor.check();assert.deepEqual(h.calls,['notice','save','reload']);
});

test('the successful host update hook reloads even when the patch keeps the version number',async t=>{
    const h=fixture(t);h.monitor.request();h.monitor.request();
    assert.deepEqual(h.calls,['notice']);
    await h.monitor.check();assert.deepEqual(h.calls,['notice','save','reload']);
});

test('generation, drafts or pending saves defer a requested reload until idle',async t=>{
    const h=fixture(t);h.busy(true);h.monitor.request();
    await h.monitor.check();await h.monitor.check();
    assert.deepEqual(h.calls,['notice']);
    h.busy(false);await h.monitor.check();
    assert.deepEqual(h.calls,['notice','save','reload']);
});

test('typing or starting a generation during flushing prevents the imminent reload',async t=>{
    let release,entered;
    const saving=new Promise(resolve=>{entered=resolve;});
    const h=fixture(t,{flush:async()=>{entered();await new Promise(resolve=>{release=resolve;});}});
    h.monitor.request();const pending=h.monitor.check();await saving;
    h.busy(true);release();assert.equal(await pending,false);
    assert.deepEqual(h.calls,['notice']);
});

test('failed saves remain retryable without reloading or repeating the update notice',async t=>{
    let failed=true;
    const h=fixture(t,{flush:async()=>{if(failed) throw new Error('offline');}});
    h.monitor.request();assert.equal(await h.monitor.check(),false);
    assert.deepEqual(h.calls,['notice']);assert.match(h.errors[0].message,/offline/);
    assert.equal([...h.timers.values()][0].delay,10000);
    failed=false;assert.equal(await h.monitor.check(),true);
    assert.deepEqual(h.calls,['notice','reload']);
});

test('unreadable manifests do not confirm an update and recover after the connection returns',async t=>{
    let latest=null;
    const h=fixture(t,{readVersion:async()=>latest});
    await h.monitor.check();assert.equal(h.errors.length,1);assert.deepEqual(h.calls,[]);
    latest='0.40.4';await h.monitor.check();assert.deepEqual(h.calls,[]);
    await h.monitor.check();assert.deepEqual(h.calls,['notice','save','reload']);
});

test('concurrent checks share one save and disposing during it cancels the reload',async t=>{
    let release,entered,saves=0;
    const saving=new Promise(resolve=>{entered=resolve;});
    const h=fixture(t,{flush:async()=>{saves++;entered();await new Promise(resolve=>{release=resolve;});}});
    h.monitor.request();const first=h.monitor.check(),second=h.monitor.check();
    assert.strictEqual(first,second);await saving;
    h.monitor.dispose();release();await first;
    assert.equal(saves,1);assert.deepEqual(h.calls,['notice']);assert.equal(h.timers.size,0);
});

test('a fresh page on the new version does not repeat the previous update reload',async t=>{
    const h=fixture(t,{version:'0.40.4',readVersion:async()=> '0.40.4'});
    await h.monitor.check();await h.monitor.check();
    assert.deepEqual(h.calls,[]);
});

test('a stale cached script cannot cause a cross-page reload loop for the same version',async t=>{
    const data=new Map(),storage={getItem:key=>data.get(key),setItem:(key,value)=>data.set(key,value),removeItem:key=>data.delete(key)};
    const first=fixture(t,{storage});first.version('0.40.4');
    await first.monitor.check();await first.monitor.check();
    assert.deepEqual(first.calls,['notice','save','reload']);
    const stale=fixture(t,{storage});stale.version('0.40.4');
    await stale.monitor.check();await stale.monitor.check();assert.deepEqual(stale.calls,[]);
    const loaded=fixture(t,{storage,version:'0.40.4'});loaded.version('0.40.4');
    await loaded.monitor.check();assert.equal(data.size,0);
    loaded.version('0.40.5');await loaded.monitor.check();await loaded.monitor.check();
    assert.deepEqual(loaded.calls,['notice','save','reload']);
});
