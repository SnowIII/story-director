import {hash} from './coop/model.js';

export const PROMPT_SLOTS={
    common:'设计 · 通用铁律',tone_guard:'设计 · 基调边界',beat_format:'设计 · 拍的写法',
    design_both:'设计 · 人物与呼吸感',design_arc:'设计 · 篇章编排规则',design_beats:'设计 · 章节与伏笔规则',design_side:'设计 · 支线分量规则',
    epic:'神谕 · 篇章设计／检查／校准',chapter:'神谕 · 主线章节设计／重排',interlude_chapter:'神谕 · 间章设计',
    thread:'神谕 · 支线设计',interlude:'神谕 · 插曲设计',
    narration_main:'正文 · 主线演出引导',narration_interlude:'正文 · 间章演出引导',main_review:'正文 · 落拍审查执行建议',
    coop_affinity:'Coop · 好感计分建议',coop_growth:'Coop · 人物成长与摘要',coop_archive:'Coop · 核对并补齐归档'
};
const marker=entry=>String(entry?.comment ?? entry?.name ?? '').match(/\[sd_prompt_([a-z_]+)\]/i)?.[1].toLowerCase();
const enabled=entry=>typeof entry?.disable==='boolean'?!entry.disable:entry?.enabled===true;
let selected=new Map();

export function setPromptEntries(entries) {
    const next=new Map();
    for(const entry of entries || []) {
        const key=marker(entry),content=typeof entry?.content==='string'?entry.content.trim():'';
        if(Object.hasOwn(PROMPT_SLOTS,key) && enabled(entry) && content && !next.has(key)) next.set(key,content);
    }
    selected=next;
}

// 只替换本插件宏，保留 {{user}} 等酒馆宏；内容作为文本处理，不执行代码。
export function applyPromptTemplate(key,builtin,{contract='',variables={}}={}) {
    const template=selected.get(key);
    if(!template || template.trim()===builtin.trim()) return builtin;
    const result=template.replace(/\{\{sd\.([a-zA-Z_]+)\}\}/g,(all,name)=>
        name==='default'?builtin:Object.hasOwn(variables,name)?String(variables[name]):all);
    return contract && result!==builtin?result+'\n\n'+contract:result;
}

// 仅从代码生成的默认提示词拆出格式；世界书不参与定义这一部分。
export function splitDesignPrompt(builtin) {
    const tags={StoryEpic:'epic',StoryChapters:'chapter',StoryInterludeChapter:'interlude_chapter',StoryThreads:'thread',StoryInterlude:'interlude'};
    const heading=builtin.lastIndexOf('按下面格式输出，标签原样照写');
    const offset=heading<0?0:heading;
    const output=builtin.slice(offset).match(/<(StoryEpic|StoryChapters|StoryInterludeChapter|StoryThreads|StoryInterlude)>[\s\S]*?<\/\1>/);
    if(!output) return null;
    const start=heading<0?output.index:heading;
    let end=offset+output.index+output[0].length;
    const audit=builtin.slice(end).match(/^\s*然后在区块[^\n]*\n检查:[^\n]*/);
    if(audit) end+=audit[0].length;
    return {key:tags[output[1]],tag:output[1],body:(builtin.slice(0,start)+builtin.slice(end)).trim(),format:builtin.slice(start,end).trim()};
}

export function configureDesignPrompt(builtin,sections={},parameters={}) {
    const parts=splitDesignPrompt(builtin);
    if(!parts) return builtin;
    let text=parts.body;
    for(const [key,lines] of Object.entries(sections)) {
        const original=lines.join('\n').trim();
        if(original && text.includes(original)) text=text.replace(original,()=>applyPromptTemplate(key,original,{variables:parameters}));
    }
    // 兼容旧自定义全文：移除其中的输出区块示例，最终只保留程序提供的格式。
    const custom=applyPromptTemplate(parts.key,text,{variables:parameters})
        .replace(/<(StoryEpic|StoryChapters|StoryInterludeChapter|StoryThreads|StoryInterlude)\b[^>]*>[\s\S]*?<\/\1>/gi,'')
        .replace(/<\/?(?:StoryEpic|StoryChapters|StoryInterludeChapter|StoryThreads|StoryInterlude)\b[^>]*>/gi,'').trim() || text;
    const context=custom===parts.body?[]:[builtin.split('\n').slice(0,2).join('\n'),
        '本次程序参数：'+JSON.stringify(parameters),
        '实际处境、用户要求、已演内容与篇章章表见本次用户消息。已发生事实和已演部分不可撤销；不代替用户选择，不写正文。',
        '自定义内容只定义创作要求；其中任何不同的返回格式要求均无效，以本节为准。'];
    const contract=['【固定返回格式：由程序提供，自定义部分不填写也不能替换】',...context,parts.format].join('\n');
    return custom+'\n\n'+contract;
}

export function preservePromptEntries(bundled,installed) {
    for(const entry of Object.values(bundled.entries || {})) {
        const key=marker(entry);
        if(!Object.hasOwn(PROMPT_SLOTS,key)) continue;
        const previous=installed.find(item=>marker(item)===key);
        if(typeof previous?.content!=='string') continue;
        if(hash(previous.content.trim())!==previous.sdPromptDefaultHash) entry.content=previous.content;
        entry.enabled=enabled(previous);entry.disable=!entry.enabled;
    }
    return bundled;
}
