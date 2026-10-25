import test from 'node:test';
import assert from 'node:assert/strict';
import {visibleBody,hasEvidence,legacyVisibleBody} from '../coop/body.js';
import {sourceMap,matchesSourceVersion,ensureMessageIds} from '../coop/messages.js';
import {hash} from '../coop/model.js';

test('variable opener mentions cannot span explicit story boundaries',()=>{
    const body='说明：末尾使用 <UpdateVariable>。<content>她接受了帮助。</content><UpdateVariable>变量秘密</UpdateVariable>';
    assert.ok(visibleBody(body).includes('她接受了帮助'));
    assert.ok(!visibleBody(body).includes('变量秘密'));
});
test('literal variable tags inside content remain actual story text',()=>{
    const body='<content>纸上印着 <UpdateVariable> 标签，她指给你看。</content><UpdateVariable>变量秘密</UpdateVariable>';
    assert.ok(visibleBody(body).includes('纸上印着 <UpdateVariable> 标签'));
    assert.ok(!visibleBody(body).includes('变量秘密'));
});
test('analysis, real variable blocks and director controls cannot supply evidence',()=>{
    const body='<build>尚未发生的帮助</build><content>她没有接受。</content><UpdateVariable><Analysis>待核对</Analysis>变量承诺</UpdateVariable><故事导演自检>通过</故事导演自检>';
    assert.equal(hasEvidence(body,'尚未发生的帮助'),false);
    assert.equal(hasEvidence(body,'变量承诺'),false);
    assert.equal(hasEvidence(body,'她没有接受'),true);
});
test('quoted content markup in a genuine variable payload cannot become story evidence',()=>{
    const body='<content>她拒绝了帮助。</content><UpdateVariable><JSONPatch>[{"value":"<content>她接受了帮助。</content>"}]</JSONPatch></UpdateVariable>';
    assert.equal(hasEvidence(body,'她接受了帮助'),false);
    assert.ok(hasEvidence(body,'她拒绝了帮助'));
});
test('unfinished analysis and variable payloads do not erase a following story',()=>{
    assert.ok(visibleBody('<build>计划尚未闭合<content>真正的回答</content>').includes('真正的回答'));
    assert.ok(!visibleBody('真正的回答<UpdateVariable><JSONPatch>未完整的数据').includes('未完整的数据'));
});
test('evidence tolerates display whitespace but still requires actual words',()=>{
    assert.ok(hasEvidence('她\n\n愿意一起核对','她 愿意一起核对'));
    assert.equal(hasEvidence('她拒绝核对','她愿意核对'),false);
    assert.equal(hasEvidence('任何正文','<build>不应当作为依据</build>'),false);
});
test('format and IGS decoration have stable fingerprints; actual rewrites and swipes do not',()=>{
    const messages=[{sd_coop_id:'m',mes:'<content>她愿意一起核对。</content>',is_user:false,swipe_id:0}];
    const original=sourceMap(messages).get('m').version;
    messages[0].mes='<content>\n[igs-img:3]\n她愿意一起核对。\n[igs-img:4]\n</content>';
    assert.equal(sourceMap(messages).get('m').version,original);
    messages[0].swipe_id=1;
    assert.notEqual(sourceMap(messages).get('m').version,original);
    messages[0].swipe_id=0;messages[0].mes='<content>她拒绝一起核对。</content>';
    assert.notEqual(sourceMap(messages).get('m').version,original);
});
test('legacy hashes are reconstructed from exact marker removals, never from claimed cache values',()=>{
    const original='<content>她愿意一起核对。\n这里是下一段。</content>';
    const oldVersion=hash(legacyVisibleBody(original)+'|0|false');
    const messages=[{mes:original,is_user:false}];ensureMessageIds(messages);
    messages[0].mes=original.replace('这里','[igs-img:3]\n这里')+'\n[igs-img:4]';
    messages[0].extra={sdCoopReports:{version:'invented-old-hash',reports:[]}};
    let source=sourceMap(messages).get(messages[0].sd_coop_id);
    assert.ok(matchesSourceVersion(source,oldVersion));
    assert.equal(matchesSourceVersion(source,'invented-old-hash'),false);
    messages[0].mes=messages[0].mes.replace('愿意','拒绝');
    source=sourceMap(messages).get(messages[0].sd_coop_id);
    assert.equal(matchesSourceVersion(source,oldVersion),false);
});
test('legacy gap cleanup can be verified while changed words stay invalid',()=>{
    const original='序幕\n\n<故事导演自检>通过</故事导演自检>\n\n她愿意一起核对。';
    const oldVersion=hash(legacyVisibleBody(original)+'|0|false');
    const messages=[{sd_coop_id:'m',mes:'序幕\n\n她愿意一起核对。',is_user:false}];
    assert.ok(matchesSourceVersion(sourceMap(messages).get('m'),oldVersion));
    messages[0].mes='序幕\n\n她拒绝一起核对。';
    assert.equal(matchesSourceVersion(sourceMap(messages).get('m'),oldVersion),false);
});
