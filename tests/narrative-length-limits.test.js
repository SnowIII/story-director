import test from 'node:test';
import assert from 'node:assert/strict';
import {parseBlocks,epicFromBlock,chapterFromBlock,interludeChapterFromBlock,threadFromBlock,interludeFromBlock,
    EP,MAIN_TITLE,MAIN_ARC,MAIN_SCOPE,MAIN_GOAL,MAIN_BEATS,IL,THREAD_FIELDS,INTERLUDE_FIELDS} from '../model.js';

const cases=[
    {name:'epic',tag:'StoryEpic',parse:epicFromBlock,fields:[
        ['标题',EP.title,60],['篇章',EP.line,1200],['章内容',EP.chapters,2000,true],
        ['大高潮',EP.climax,360],['伏笔',EP.hooks,600,true,false],['既成事实',EP.ledger,1800]]},
    {name:'main chapter',tag:'StoryChapters',parse:chapterFromBlock,fields:[
        ['章标题',MAIN_TITLE,60],['篇章',MAIN_ARC,60],['范围',MAIN_SCOPE,720],
        ['章目标',MAIN_GOAL,900],['拍',MAIN_BEATS,900,true]]},
    {name:'interlude chapter',tag:'StoryInterludeChapter',parse:interludeChapterFromBlock,fields:[
        ['标题',IL.title,60],['场合',IL.scene,360],['拍',IL.beats,900,true]]},
    {name:'thread',tag:'StoryThreads',parse:threadFromBlock,fields:[
        ['标题',THREAD_FIELDS.title,60],['目标',THREAD_FIELDS.goal,900],
        ['切入',THREAD_FIELDS.entry,720],['落点',THREAD_FIELDS.land,900]]},
    {name:'short interlude',tag:'StoryInterlude',parse:interludeFromBlock,fields:[
        ['标题',INTERLUDE_FIELDS.title,60],['内容',INTERLUDE_FIELDS.beat,900]]},
];

for(const item of cases)test(item.name+' retains expanded fields through parsing at the length boundaries',()=>{
    for(const offset of [-1,0,1]){
        const values=item.fields.map(([, ,limit],index)=>String.fromCharCode(0x7532+index).repeat(limit+offset));
        const body=item.fields.map(([field,,,list,numbered=list],index)=>field+': '+(numbered?'\n1. ':'')+values[index]).join('\n');
        const raw='<'+item.tag+'>\n'+body+'\n</'+item.tag+'>';
        const parsed=item.parse(parseBlocks(raw,item.tag)[0]);
        item.fields.forEach(([field,key,limit,list],index)=>{
            const expected=values[index].slice(0,limit);
            assert.deepEqual(parsed[key],list?[expected]:expected,field+' at limit '+limit+' offset '+offset);
        });
    }
});
