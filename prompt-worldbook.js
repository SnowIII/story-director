import {hash} from './coop/model.js';

export const PROMPT_SLOTS={
    common:'设计 · 通用铁律',tone_guard:'设计 · 基调边界',beat_format:'设计 · 拍的写法',
    design_both:'设计 · 人物与呼吸感',design_arc:'设计 · 篇章编排规则',design_beats:'设计 · 章节与伏笔规则',design_side:'设计 · 支线分量规则',
    epic:'神谕 · 篇章设计／检查／校准',chapter:'神谕 · 主线章节设计／重排',interlude_chapter:'神谕 · 间章设计',
    thread:'神谕 · 支线设计',interlude:'神谕 · 插曲设计',
    narration_main:'正文 · 主线演出引导',narration_interlude:'正文 · 间章演出引导',main_review:'正文 · 落拍审查执行建议',
    coop_affinity:'Coop · 好感计分建议',coop_growth:'Coop · 人物成长与摘要',coop_archive:'Coop · 核对并补齐归档'
};
// 字段名与兼容别名属于传输协议，字段内部的叙事小标题不是新属性。
export const DESIGN_FIELDS={
    epic:['标题','title','篇章','总纲','纲','line','章内容','章节表','章','chapters','走向','movements','大高潮','高潮','climax','伏笔','hooks','既成事实','事实','ledger'],
    chapter:['章标题','标题','title','篇章','分卷','弧线','arc','story','范围','边界','scope','章目标','目标','goal','拍','beats'],
    interlude_chapter:['标题','title','场合','地点','scene','拍','beats'],
    thread:['标题','title','目标','goal','切入','起始迹象','entry','落点','收束','land','时限','due'],
    interlude:['标题','title','内容','一拍','beat','接在','after']
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
    // 兼容旧自定义全文：保留本任务字段中的内容要求，只移除其外层格式。
    const custom=applyPromptTemplate(parts.key,text,{variables:parameters})
        .replace(/<(StoryEpic|StoryChapters|StoryInterludeChapter|StoryThreads|StoryInterlude)\b[^>]*>([\s\S]*?)<\/\1>/gi,(_,tag,body)=>
            tag.toLowerCase()===parts.tag.toLowerCase() && new RegExp('(?:^|\\n)\\s*(?:[-*+>#]+\\s*)*(?:'+DESIGN_FIELDS[parts.key].join('|')+')\\*{0,3}\\s*[:：=]','i').test(body)
                ? '【自定义字段内容要求；用于设计，不视为已发生事实】\n'+body.trim() : '')
        .replace(/<\/?(?:StoryEpic|StoryChapters|StoryInterludeChapter|StoryThreads|StoryInterlude)\b[^>]*>/gi,'').trim() || text;
    const runtime=Object.fromEntries(Object.entries(parameters).filter(([key])=>
        ['task','beatTarget','beatBudget','interludeBeats','chaptersPerEpic','keep','remaining','regenerate','epicMode'].includes(key)));
    const task=parts.key==='epic' ? parameters.epicMode==='audit' ? '检查这一部篇章还成不成立，保留已演章节'
        : parameters.epicMode==='evolve' ? '校准篇章未演章节' : '设计篇章'
        : {chapter:'设计或重排当前章节，已经演过的部分不许动；整章重设按程序指定范围执行',
            interlude_chapter:'设计间章',thread:'设计支线',interlude:'设计插曲'}[parts.key];
    const context=custom===parts.body?[]:['本次任务：'+task,
        '本次程序参数：'+JSON.stringify(runtime),
        '实际处境、用户要求、已演内容与篇章章表见本次用户消息。已发生事实和已演部分不可撤销。',
        '各字段的情节、文风、叙事结构和内部组织遵循自定义创作规则；本节仅固定标签、顶层字段、列表写法和运行参数。'];
    const contract=['【固定返回格式：仅约束标签、顶层字段与数据结构】',...context,
        '字段值的具体写法优先遵循用户自定义创作规则，内置默认建议只补充未自定义的部分。',
        '下列括号内文字是内容占位，不要照抄。字段名原样保留，字段值按创作规则填写；编号条目可包含分号和自定义小标题。',parts.format].join('\n');
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
