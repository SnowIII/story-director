import test from 'node:test';
import assert from 'node:assert/strict';
import { CoopRuntime } from '../coop/runtime.js';
import { clone, hash } from '../coop/model.js';
import { legacyVisibleBody, fingerprintBody } from '../coop/body.js';
import { sourceMap, visibleBody } from '../coop/messages.js';
import { STORAGE_KEY } from '../coop/store.js';

// Synthetic fixtures reproduce the observed markup shape; no user dialogue is copied.
async function setup(t, mode = 'coop', initialAffinity = 0) {
    const messages = [], metadata = {};
    const host = {
        scope: () => 'affinity-review', metadata: () => metadata, messages: () => messages,
        context: () => ({ extensionSettings: { mvu_settings: { 更新方式: '随AI输出' } } }),
        available: () => true, contextText: async () => '', autoAllowed: () => false,
        locks: { request: async (name, options, callback) => callback({ name }) },
        persist: async document => { metadata[STORAGE_KEY] = clone(document); },
    };
    const runtime = new CoopRuntime(host);
    await runtime.load();
    t.after(() => runtime.dispose());
    await runtime.configure({ id: 'npc:review', name: '测试画家', mode, initialAffinity });
    const profile = () => runtime.state().profiles['npc:review'];
    async function send(delta, body = '<content>她放心地把资料交给你。</content>', user = '我来帮你核对资料。') {
        messages.push({ is_user: true, mes: user });
        await runtime.prepare();
        const report = { nonce: runtime.snapshot.nonce, affinity: [{
            characterId: 'npc:review', delta, reason: '接受实际帮助',
            userEvidence: '帮你', evidence: '放心地把资料交给你',
        }] };
        messages.push({ is_user: false, mes: body + '<CoopReport>' + JSON.stringify(report) + '</CoopReport>' });
        const index = messages.length - 1;
        await runtime.afterMessage(index);
        return index;
    }
    return { runtime, messages, metadata, profile, send };
}

test('A1: adding IGS image anchors must preserve an already awarded affinity point', async t => {
    const h = await setup(t);
    const index = await h.send(1);
    assert.equal(h.profile().affinity, 1);
    h.messages[index].mes = h.messages[index].mes.replace('<content>', '<content>[igs-img:3]\n')
        .replace('</content>', '\n[igs-img:4]</content>');
    h.runtime.store.reconcile();
    t.diagnostic('after image anchors: score=' + h.profile().affinity + ', skipped=' + JSON.stringify(h.runtime.state().skipped.map(x => x.code)));
    assert.equal(h.profile().affinity, 1, 'presentation-only anchors revoked the real score');
});

test('A2: director control-tag cleanup and newline collapse must preserve affinity', async t => {
    const h = await setup(t);
    const index = await h.send(1, '序幕\n\n<故事导演自检>通过</故事导演自检>\n\n<content>她放心地把资料交给你。</content>');
    assert.equal(h.profile().affinity, 1);
    // Matches the director cleanup's removal and newline collapse, with no story change.
    h.messages[index].mes = h.messages[index].mes.replace(/<故事导演自检>[\s\S]*?<\/故事导演自检>/g, '')
        .replace(/\n{3,}/g, '\n\n').trimEnd();
    h.runtime.store.reconcile();
    assert.equal(h.profile().affinity, 1, 'the director cleanup invalidated its own score source');
});

test('A3: removing old automatic instructions restores legacy cumulative scores without duplicating them', async t => {
    const h=await setup(t,'coop',5);
    const note='<!--AIA_VISIBLE_START-->\n> **[System Note]**\n> 对话使用角色标签。\n<!--AIA_VISIBLE_END-->';
    const user='<本轮用户输入>\n我来帮你核对资料。\n\n'+note+'\n</本轮用户输入>\n<recall>已有记忆</recall>';
    for(const delta of [2,1,1]) {
        for(const message of h.messages.filter(message=>message.is_user)) message.mes=message.mes.replace(note,'');
        const index=await h.send(delta,undefined,user),input=h.messages[index-1];
        const legacy='v2:'+hash(fingerprintBody(input.mes,{keepInstructions:true})+'|0|true');
        const op=h.runtime.store.document.journal.at(-1);
        op.refs.find(ref=>ref.id===input.sd_coop_id).version=legacy;
        h.messages[index].extra.sdCoopSnapshot.userVersion=legacy;
    }
    h.metadata[STORAGE_KEY]=clone(h.runtime.store.document);
    await h.runtime.load();
    assert.equal(h.profile().affinity,9);
    assert.deepEqual(h.profile().scoreLog.map(log=>log.actual),[2,1,1]);
    await h.runtime.afterMessage(h.messages.length-1);
    await h.runtime.load();
    assert.equal(h.profile().affinity,9);assert.equal(h.profile().scoreLog.length,3);
    h.messages[0].mes=h.messages[0].mes.replace('帮你核对','拒绝核对');
    h.runtime.store.reconcile();
    assert.equal(h.profile().affinity,9,'editing a retained floor preserves its confirmed score');
    h.messages.splice(0,2);h.runtime.store.reconcile();assert.equal(h.profile().affinity,7);
});

test('B: mentioning an UpdateVariable opener in a build block must not erase the story evidence', async t => {
    const h = await setup(t);
    const body = '<build>检查：结尾应输出 <UpdateVariable> 块。\n</build>\n'
        + '<content>她放心地把资料交给你。</content>\n'
        + '<UpdateVariable><JSONPatch>[]</JSONPatch></UpdateVariable>';
    assert.ok(body.includes('放心地把资料交给你'));
    await h.send(1, body);
    t.diagnostic('raw evidence present=true, extracted evidence present=' + visibleBody(body).includes('放心地把资料交给你')
        + ', notices=' + JSON.stringify(h.runtime.notices.map(x => x.code)));
    assert.equal(h.profile().affinity, 1, 'a control-tag mention swallowed the actual content block');
});

for (const mode of ['affinity', 'coop']) {
    test('C: editing keeps confirmed scores and deleting removes only the related score, mode=' + mode, async t => {
        const h = await setup(t, mode);
        const firstIndex = await h.send(2);
        const secondIndex = await h.send(3);
        assert.equal(h.profile().affinity, 5);
        const secondMessage = h.messages[secondIndex];
        const secondVersion = sourceMap(h.messages).get(secondMessage.sd_coop_id).version;
        h.messages[firstIndex].mes = '<content>她拒绝了这次帮助，没有接受资料。</content>';
        h.runtime.store.reconcile();
        assert.equal(sourceMap(h.messages).get(secondMessage.sd_coop_id).version, secondVersion);
        t.diagnostic('later source unchanged=true, score=' + h.profile().affinity
            + ', skipped=' + JSON.stringify(h.runtime.state().skipped.map(x => x.code)));
        assert.equal(h.profile().affinity, 5);
        h.messages.splice(firstIndex-1,2);h.runtime.store.reconcile();assert.equal(h.profile().affinity,3);
    });
}

test('control: rewriting retains a confirmed interaction while deleting its floor revokes it', async t => {
    const h = await setup(t);
    const index = await h.send(1);
    h.messages[index].mes = '<content>她拒绝了帮助。</content>';
    h.runtime.store.reconcile();
    assert.equal(h.profile().affinity,1);
    h.messages.pop();h.runtime.store.reconcile();assert.equal(h.profile().affinity,0);
    assert.equal(h.runtime.state().skipped[0].code, 'STALE_SOURCE');
});

test('control: reaching 30 must keep both positive and negative changes locked', async t => {
    const h = await setup(t, 'coop', 29);
    await h.send(5);
    assert.equal(h.profile().affinity, 30);
    assert.equal(h.profile().lock.targetRank, 1);
    await h.send(-5);
    await h.send(5);
    assert.equal(h.profile().affinity, 30);
    assert.equal(h.profile().scoreLog.at(-1).reasonCode, 'AFFINITY_LOCKED');
});

test('old score journals verify legacy sources and rebase independent points before any Rank completion',async t=>{
    const h=await setup(t,'affinity');
    const first=await h.send(2);await h.send(3);
    const legacy=clone(h.runtime.store.document);
    for(const op of legacy.journal) {
        delete op.affinityHistory;
        for(const ref of op.refs) {
            const message=h.messages.find(m=>m.sd_coop_id===ref.id);
            ref.version=hash(legacyVisibleBody(message.mes)+'|'+(message.swipe_id ?? 0)+'|'+!!message.is_user);
        }
        op.data.source.version=op.refs.find(r=>r.id===op.data.source.id).version;
    }
    h.metadata[STORAGE_KEY]=legacy;
    h.messages[first].mes=h.messages[first].mes.replace('<content>','<content>[igs-img:1]\n');
    await h.runtime.load();assert.equal(h.profile().affinity,5);
    h.messages[first].mes='她拒绝了这次帮助。';h.runtime.store.reconcile();
    assert.equal(h.profile().affinity,5);
});

test('a persisted legacy request remains bound to its cached report after a fresh prepare',async t=>{
    const h=await setup(t);
    h.messages.push({is_user:true,mes:'我来帮你核对资料。'});await h.runtime.prepare();
    const original=clone(h.runtime.snapshot), user=h.messages.at(-1);
    original.userVersion=hash(legacyVisibleBody(user.mes)+'|0|true');
    const body='<build>检查：结尾使用 <UpdateVariable> 块。</build><content>她放心地把资料交给你。</content><UpdateVariable>变量</UpdateVariable>';
    const report={nonce:original.nonce,affinity:[{characterId:'npc:review',delta:1,reason:'实际帮助',userEvidence:'帮你',evidence:'放心地把资料交给你'}]};
    h.messages.push({is_user:false,mes:body,extra:{sdCoopSnapshot:original,
        sdCoopReports:{version:hash(legacyVisibleBody(body)+'|0|false'),reports:[report]}}});
    await h.runtime.load();await h.runtime.prepare();assert.notEqual(h.runtime.snapshot.nonce,original.nonce);
    await h.runtime.afterMessage(h.messages.length-1);
    assert.equal(h.profile().affinity,1);
    assert.equal(h.messages.at(-1).extra.sdCoopSnapshot.nonce,original.nonce);
    await h.runtime.afterMessage(h.messages.length-1);assert.equal(h.profile().affinity,1);
});

test('activity distinguishes normal zero, incomplete evidence and a missing report',async t=>{
    const h=await setup(t);
    await h.send(0);assert.equal(h.runtime.affinityActivity('npc:review')[0].label,'正常 0 分');
    await h.send(1,'她拒绝了资料。');assert.equal(h.runtime.affinityActivity('npc:review')[0].code,'INVALID_EVIDENCE');
    h.messages.push({is_user:true,mes:'你最近好吗？'});await h.runtime.prepare();
    h.messages.push({is_user:false,mes:'她向你问好。'});await h.runtime.afterMessage(h.messages.length-1);
    assert.equal(h.runtime.affinityActivity('npc:review')[0].code,'NO_REPORT');
});

test('activity shows pending saves until the score is durably confirmed',async t=>{
    const h=await setup(t), persist=h.runtime.host.persist;
    h.runtime.host.persist=async()=>{throw new Error('offline');};
    await h.send(1);assert.equal(h.profile().affinity,0);
    assert.equal(h.runtime.affinityActivity('npc:review')[0].code,'SAVE_PENDING');
    h.runtime.host.persist=persist;await h.runtime.store.retrySave();
    assert.equal(h.profile().affinity,1);assert.equal(h.runtime.affinityActivity('npc:review')[0].code,'APPLIED');
});

test('extra-model activity changes from waiting to confirmed without duplicate scoring',async t=>{
    const h=await setup(t);
    h.runtime.host.context=()=>({extensionSettings:{mvu_settings:{更新方式:'额外模型解析'}}});
    h.messages.push({is_user:true,mes:'我来帮你核对资料。'});await h.runtime.prepare();
    const report={nonce:h.runtime.snapshot.nonce,affinity:[{characterId:'npc:review',delta:1,reason:'实际帮助',userEvidence:'帮你',evidence:'放心'}]};
    h.messages.push({is_user:false,mes:'她放心了。'});await h.runtime.afterMessage(h.messages.length-1);
    assert.equal(h.runtime.affinityActivity('npc:review')[0].code,'WAITING_MVU');
    await h.runtime.receiveMvu({stat_data:{故事导演:{Coop:{回报:report}}}});
    assert.equal(h.runtime.affinityActivity('npc:review')[0].code,'APPLIED');
    assert.equal(h.profile().affinity,1);
    await h.runtime.receiveMvu({stat_data:{故事导演:{Coop:{回报:report}}}});assert.equal(h.profile().affinity,1);
});
