import test from 'node:test';
import assert from 'node:assert/strict';
import {setPromptEntries,configureDesignPrompt,splitDesignPrompt} from '../prompt-worldbook.js';
import {parseBlocks,epicFromBlock,chapterFromBlock,interludeChapterFromBlock,threadFromBlock,interludeFromBlock,
    renderEpicSection,splitBeats,EP,MAIN_GOAL,MAIN_BEATS,IL,THREAD_FIELDS,INTERLUDE_FIELDS} from '../model.js';
import {directorFixture} from './prompt-fixture.js';

const entry=(key,content)=>({comment:'[sd_prompt_'+key+']',content,enabled:true});
const reset=t=>{setPromptEntries([]);t.after(()=>setPromptEntries([]));};
const tasks={epic:'buildEpicSystemPrompt',chapter:'buildChapterSystemPrompt',interlude_chapter:'buildInterludeChapterSystemPrompt',thread:'buildThreadSystemPrompt',interlude:'buildInterludeSystemPrompt'};
const creative={epic:/起承转合|起：|承：|转：|合：|四处不同|6~14|三到六/,chapter:/谁要什么|对立的那一边|4~10|谁做了什么/,interlude_chapter:/身边这批人|日常走动|4~10/,thread:/与 \{\{user\}\} 的行为无关|不要写 \{\{user\}\}|4~10/,interlude:/别人 \/ 环境|不要写 \{\{user\}\}|4~10/};

for(const [key,fn] of Object.entries(tasks)) test(key+' fixes only transport structure and lets custom rules choose field content',t=>{
    reset(t);const fixture=directorFixture(),builtin=fixture.build(fn),parts=splitDesignPrompt(builtin);
    assert.doesNotMatch(parts.format,creative[key]);
    setPromptEntries([entry(key,'全部字段围绕轻松合作。章节内容按行动、收获、遗留问题组织；由角色自主决定场所。')]);
    const prompt=configureDesignPrompt(builtin,fixture.sections,{beatTarget:4,chaptersPerEpic:4,intensity:'高压',tone:'冒险'});
    const [body,format]=prompt.split('\n\n【固定返回格式');
    assert.match(body,/按行动、收获、遗留问题组织/);
    assert.doesNotMatch(format,creative[key]);
    assert.ok(!format.includes('高压'));assert.ok(!format.includes('冒险'));
    assert.ok(prompt.includes('<'+parts.tag+'>'));assert.ok(prompt.includes('</'+parts.tag+'>'));
});

test('default storytelling suggestions remain editable when a task uses the default macro',t=>{
    reset(t);const fixture=directorFixture(),builtin=fixture.build(tasks.epic);
    setPromptEntries([entry('epic','{{sd.default}}\n本次可使用同一场所。')]);
    const [body,format]=configureDesignPrompt(builtin,fixture.sections).split('\n\n【固定返回格式');
    assert.match(body,/起：|起 \/ 承 \/ 转 \/ 合/);assert.match(body,/6~14/);
    assert.doesNotMatch(format,/6~14|四处不同|起：/);
});

test('legacy XML templates retain custom field-writing instructions while output tags stay canonical',t=>{
    reset(t);const fixture=directorFixture(),builtin=fixture.build(tasks.epic);
    setPromptEntries([entry('epic','自定义规则\n<StoryEpic>\n标题: 以人物的一句口头禅命名\n篇章: 采用旅行见闻\n章内容:\n1. 按行动、收获、遗留问题组织，不按起承转合组织\n2. 允许继续在同一座城市\n大高潮: 用一次安静的共同决定收束\n伏笔: 只记录已出现的细节\n</StoryEpic>')]);
    const prompt=configureDesignPrompt(builtin,fixture.sections),[body,format]=prompt.split('\n\n【固定返回格式');
    assert.match(body,/以人物的一句口头禅命名/);assert.match(body,/旅行见闻/);assert.match(body,/安静的共同决定/);
    assert.ok(!body.includes('<StoryEpic>'));assert.equal(prompt.split('<StoryEpic>').length-1,1);
    assert.ok(format.includes('章内容:'));assert.doesNotMatch(format,/四处不同|起：/);
});

test('epic free-form chapter content and multiline field notes survive parser and director rendering',()=>{
    const raw='<StoryEpic>\n标题: 一起修船\n篇章: 在同一个船坞逐步完成共同作品\n章内容:\n1. 约定：先修船底；暂缓桅杆\n行动: 互相展示擅长的工具\n收获: 找到适合两人的分工\n2. 行动：试航；回港调整\n遗留问题: 仍需选择帆布\n大高潮: 共同决定把船送给港口学校\n伏笔: 刻着名字的木片；旧帆布\n既成事实: 旧船已经拖入船坞\n';
    const epic=epicFromBlock(parseBlocks(raw+'</StoryEpic>','StoryEpic')[0]);
    assert.equal(epic[EP.chapters].length,2);assert.match(epic[EP.chapters][0],/行动: 互相展示/);
    assert.match(epic[EP.chapters][0],/收获: 找到/);assert.match(epic[EP.chapters][1],/遗留问题: 仍需选择/);
    assert.equal(epic[EP.climax],'共同决定把船送给港口学校');assert.equal(epic[EP.hooks].length,2);
    const rendered=renderEpicSection(epic);assert.equal(rendered.started,true);assert.match(rendered.lines.join('\n'),/互相展示擅长的工具/);
});

test('all narrative parsers preserve custom subheadings within their known top-level fields',()=>{
    const chapter=chapterFromBlock('章标题: 同行\n篇章: 归港\n范围: 船坞\n章目标: 完成一件合作作品\n动机: 彼此都希望尝试\n拍:\n1. 角色摆好工具\n观察: 旧刀柄已磨损\n2. 角色邀请用户选择颜色\n期待: 用户真实回应');
    assert.match(chapter[MAIN_GOAL],/动机: 彼此都希望/);assert.match(chapter[MAIN_BEATS][0],/观察: 旧刀柄/);assert.match(chapter[MAIN_BEATS][1],/期待: 用户/);
    const interlude=interludeChapterFromBlock('标题: 晚餐\n场合: 船坞食堂\n气氛: 轻松\n拍:\n1. 她分好食物\n细节: 先挑掉鱼刺\n2. 大家交换菜谱');
    assert.match(interlude[IL.scene],/气氛: 轻松/);assert.match(interlude[IL.beats][0],/细节: 先挑掉鱼刺/);
    const thread=threadFromBlock('标题: 借工具\n目标: 归还一套工具\n缘由: 彼此借用已久\n切入: 她带来工具箱\n落点: 工具摆回原位\n备注: 各自留下修理心得\n时限: 3');
    assert.match(thread[THREAD_FIELDS.goal],/缘由: 彼此借用/);assert.match(thread[THREAD_FIELDS.land],/备注: 各自留下/);
    const side=interludeFromBlock('标题: 雨声\n内容: 角色在廊下等雨停\n氛围: 可以安静也可以闲聊\n接在: 随时');
    assert.match(side[INTERLUDE_FIELDS.beat],/氛围: 可以安静/);
});

test('case-insensitive aliases and decorated top-level fields still select the correct values',()=>{
    const epic=epicFromBlock('**TITLE**: 小船\n### LINE: 归港\nCHAPTERS:\n1. 修船\n2. 试航\nCLIMAX: 成功返航\nHOOKS: 木片；帆布\nLEDGER: 雨已停');
    assert.equal(epic[EP.title],'小船');assert.equal(epic[EP.chapters].length,2);assert.equal(epic[EP.ledger],'雨已停');
});

test('a single numbered entry retains semicolons while old flat numbered lists still split',()=>{
    assert.deepEqual(splitBeats('1. 她修好木板；留出位置等用户选择'),['她修好木板；留出位置等用户选择']);
    assert.deepEqual(splitBeats('1. 她修好木板；2. 她递来工具'),['她修好木板','她递来工具']);
});

test('legacy decorated field instructions also stay editable',t=>{
    reset(t);const fixture=directorFixture();
    setPromptEntries([entry('epic','<StoryEpic>\n**标题**: 用季节与食物命名\n</StoryEpic>')]);
    assert.match(configureDesignPrompt(fixture.build(tasks.epic),fixture.sections).split('\n\n【固定返回格式')[0],/用季节与食物命名/);
});
