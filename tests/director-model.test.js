import test from 'node:test';
import assert from 'node:assert/strict';
import {extractNsCommands,applyNsCommands,landingOpsInReply,setCoopScene,setInterludeWritesAllowed} from '../model.js';

for(const type of ['assign','insert']) test(type+' rejects unsafe object keys without changing any prototype',()=>{
    setCoopScene(false);setInterludeWritesAllowed(false);
    const root={故事导演:{主线:{}}};
    try {
        for(const key of ['__proto__','constructor','prototype']) {
            const commands=extractNsCommands(`_.${type}('故事导演.主线','${key}',{"__sdTestPolluted":true});`);
            applyNsCommands(root,commands);
        }
        assert.equal(({}).__sdTestPolluted,undefined);
        assert.equal(Object.getPrototypeOf(root.故事导演.主线),Object.prototype);
        assert.deepEqual(Object.keys(root.故事导演.主线),[]);
    } finally {delete Object.prototype.__sdTestPolluted;}
});

const patch=(path,value,op='replace')=>({op,path:'/故事导演/'+path,...(op==='remove'?{}:{value})});
for(const [name,body] of Object.entries({
    finalFalse:"_.set('故事导演.主线.本拍已落', true);\n_.set('故事导演.主线.本拍已落', false);",
    oldNewArgs:"_.set('故事导演.主线.本拍已落', true, false);",
    adjacentValue:JSON.stringify([patch('主线/本拍已落',false),patch('主线/可进下一章',true)]),
    reorderedKeys:'[{"op":"replace","value":false,"path":"/故事导演/主线/本拍已落"},{"op":"replace","value":true,"path":"/故事导演/主线/可进下一章"}]',
    fenced:'```json\n'+JSON.stringify([patch('主线/本拍已落',true)])+'\n```',
    inline:'`'+JSON.stringify(patch('主线/本拍已落',true))+'`',
    removed:JSON.stringify([patch('主线/本拍已落',true),patch('主线/本拍已落',null,'remove')]),
    mixed:JSON.stringify([patch('主线/本拍已落',true)])+"\n_.set('故事导演.主线.本拍已落',false);",
    testOnly:JSON.stringify([patch('主线/本拍已落',true,'test')]),
})) test('landing does not accept '+name,()=>{
    assert.equal(landingOpsInReply(body).main,false);
});

test('landing accepts the final value of each section across both transports',()=>{
    const body="_.set('stat_data.故事导演.主线.本拍已落',false,true);\n"+
        JSON.stringify([patch('间章/本拍已落',true),patch('主线/可进下一章',false)]);
    assert.deepEqual(landingOpsInReply(body),{hasAnyOp:true,main:true,interlude:true});
});

test('unsafe collection keys do not replace arrays or create missing objects',()=>{
    const root={故事导演:{支线:[{标题:'旧事'}]}};
    const commands=extractNsCommands("_.assign('故事导演.支线','__proto__',{});_.insert('故事导演.缺失','constructor',{});");
    applyNsCommands(root,commands);
    assert.deepEqual(root,{故事导演:{支线:[{标题:'旧事'}]}});
});

test('ordinary collection assignments remain supported',()=>{
    const root={故事导演:{支线:{}}};
    applyNsCommands(root,extractNsCommands("_.assign('故事导演.支线','t1',{\"标题\":\"旧事\"});"));
    assert.equal(root.故事导演.支线.t1.标题,'旧事');
});
