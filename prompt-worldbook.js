import {hash} from './coop/model.js';
import {FIELD_PROMPTS,fieldPromptName,FIELD_PROMPT_DEFAULT_NOTE} from './prompt-fields.js';
export {FIELD_PROMPTS,fieldPromptName,FIELD_PROMPT_DEFAULT_NOTE} from './prompt-fields.js';

export const PROMPT_SLOTS=Object.fromEntries(Object.keys(FIELD_PROMPTS).map(key=>[key,fieldPromptName(key)]));
export const PRETHINK_PROMPTS=Object.fromEntries(Object.entries({epic:'篇章',chapter:'主线',interlude_chapter:'间章',thread:'支线',interlude:'插曲'})
    .map(([task,label])=>[task,{key:'return_prethink_'+task,marker:'[sd_return_prethink_'+task+']',name:'返回前置内容 · '+label+' · preThink（默认不输出）'}]));
const preThinkKeys=new Set(Object.values(PRETHINK_PROMPTS).map(prompt=>prompt.key));
// 字段名与兼容别名属于传输协议，字段内部的叙事小标题不是新属性。
export const DESIGN_FIELDS={
    epic:['标题','title','篇章','总纲','纲','line','章内容','章节表','章','chapters','走向','movements','大高潮','高潮','climax','伏笔','hooks','既成事实','事实','ledger'],
    chapter:['章标题','标题','title','篇章','分卷','弧线','arc','story','范围','边界','scope','章目标','目标','goal','拍','beats'],
    interlude_chapter:['标题','title','场合','地点','scene','拍','beats'],
    thread:['标题','title','目标','goal','切入','起始迹象','entry','落点','收束','land','时限','due'],
    interlude:['标题','title','内容','一拍','beat','接在','after']
};
const marker=entry=>{
    const name=String(entry?.comment ?? entry?.name ?? '');
    const task=name.match(/\[sd_return_prethink_([a-z_]+)\]/i)?.[1].toLowerCase();
    return Object.hasOwn(PRETHINK_PROMPTS,task) ? PRETHINK_PROMPTS[task].key
        : name.match(/\[sd_field_([a-z_]+)\]/i)?.[1].toLowerCase();
};
const knownKey=key=>Object.hasOwn(PROMPT_SLOTS,key) || preThinkKeys.has(key);
const enabled=entry=>typeof entry?.disable==='boolean'?!entry.disable:entry?.enabled===true;
let selected=new Map();

export function setPromptEntries(entries) {
    const next=new Map();
    for(const entry of entries || []) {
        const key=marker(entry),content=typeof entry?.content==='string'?entry.content.trim():'';
        if(knownKey(key) && enabled(entry) && content && !next.has(key))
            next.set(key,content);
    }
    selected=next;
}

// 只替换本插件宏，保留 {{user}} 等酒馆宏；内容作为文本处理，不执行代码。
export function applyPromptTemplate(key,builtin,{contract='',variables={}}={}) {
    const template=selected.get(key);
    if(!template || template===builtin.trim()) return builtin;
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

export function configureDesignPrompt(builtin,_sections={},parameters={}) {
    const parts=splitDesignPrompt(builtin);
    if(!parts) return builtin;
    const fields=Object.entries(FIELD_PROMPTS).filter(([,field])=>field.task===parts.key).map(([key,field])=>
        '【'+field.label+'；返回字段「'+field.field+'」】\n'+applyPromptTemplate(key,field.content,{variables:parameters})
            .replace(/<\/?(?:StoryEpic|StoryChapters|StoryInterludeChapter|StoryThreads|StoryInterlude)\b[^>]*>/gi,''));
    const preThink=applyPromptTemplate(PRETHINK_PROMPTS[parts.key].key,'',{variables:parameters}).trim();
    const runtime=Object.fromEntries(Object.entries(parameters).filter(([key])=>
        ['task','beatTarget','beatBudget','interludeBeats','chaptersPerEpic','keep','remaining','regenerate','rejected','epicMode'].includes(key)));
    const task=parts.key==='epic' ? parameters.epicMode==='audit' ? '检查这一部篇章还成不成立，保留已演章节'
        : parameters.epicMode==='evolve' ? '校准篇章未演章节' : '设计篇章'
        : {chapter:'设计或重排当前章节，已经演过的部分不许动；整章重设按程序指定范围执行',
            interlude_chapter:'设计间章',thread:'设计支线',interlude:'设计插曲'}[parts.key];
    const context=['本次任务：'+task,
        '本次程序参数：'+JSON.stringify(runtime),
        '实际处境、用户要求、已演内容与篇章章表见本次用户消息。已发生事实和已演部分不可撤销。',
        '仅字段内部的写法按对应字段条目执行，不把一项字段要求套到其他字段。任务、真实设定和已演进度仍以程序与上下文为准。'];
    const format=preThink ? parts.format.replace('且**只输出一个区块**','先输出 <preThink>〔按返回前置内容配置填写〕</preThink>，再输出一个剧情结果区块') : parts.format;
    const contract=['【固定返回格式：仅约束标签、顶层字段与数据结构】',...context,
        '字段值的具体写法遵循上面的对应字段规则；标签、顶层字段、编号、数量和运行边界以本节为准。',
        ...(preThink ? ['返回前置内容是面向用户的补充说明，先放在一个闭合的 <preThink> 区块内，再输出下列剧情结果。两种区块不得嵌套；检查结论仍写在结果区块之后，不放入 preThink。'] : []),
        '下列括号内文字是内容占位，不要照抄。字段名原样保留，字段值按创作规则填写；编号条目可包含分号和自定义小标题。',format].join('\n');
    const preamble=preThink ? '\n\n【返回前置内容】\n'+preThink : '';
    return parts.body+'\n\n【各字段的生成写法】\n只在对应字段采用以下规则。内置任务说明不额外规定字段小标题与内部组织。\n\n'+fields.join('\n\n')+preamble+'\n\n'+contract;
}

export function preservePromptEntries(bundled,installed) {
    for(const entry of Object.values(bundled.entries || {})) {
        const key=marker(entry);
        if(!knownKey(key)) continue;
        const previous=installed.find(item=>marker(item)===key) || (preThinkKeys.has(key)
            ? installed.find(item=>String(item?.comment ?? item?.name ?? '').toLowerCase().includes('[sd_return_prethink]')) : null);
        if(typeof previous?.content!=='string') continue;
        const edited=hash(previous.content.trim())!==previous.sdPromptDefaultHash;
        if(edited) entry.content=previous.content;
        // 0.43.0 的未改默认条目随新默认关闭；已定制或使用本版名称的开关照旧保留。
        const disabledDefault=previous.sdPromptDefaultDisabled===true || String(previous.comment ?? previous.name ?? '').includes(FIELD_PROMPT_DEFAULT_NOTE);
        const oldDefault=Object.hasOwn(PROMPT_SLOTS,key) && !edited && !disabledDefault;
        entry.enabled=oldDefault ? false : enabled(previous);entry.disable=!entry.enabled;
    }
    return bundled;
}
