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
    return contract && !template.includes('{{sd.default}}')?result+'\n\n'+contract:result;
}

export function configureDesignPrompt(builtin,sections={},parameters={}) {
    const tags={StoryEpic:'epic',StoryChapters:'chapter',StoryInterludeChapter:'interlude_chapter',StoryThreads:'thread',StoryInterlude:'interlude'};
    const output=builtin.match(/<(StoryEpic|StoryChapters|StoryInterludeChapter|StoryThreads|StoryInterlude)>[\s\S]*?<\/\1>/);
    let text=builtin;
    for(const [key,lines] of Object.entries(sections)) {
        const original=lines.join('\n');
        if(original && text.includes(original)) text=text.replace(original,()=>applyPromptTemplate(key,original,{variables:parameters}));
    }
    if(!output) return text;
    // 只保留字段和列表结构，不把默认示例中的创作偏好再次强加给自定义提示词。
    const schema=output[0].split('\n').flatMap(line=>{
        if(/^<\/?Story\w+>$/.test(line)) return [line];
        const field=line.match(/^([^\s<>:：]{1,20})[:：]/);
        if(field) return [field[1]+': '+(['拍','章内容'].includes(field[1])?'':field[1]==='时限'?'整数':field[1]==='接在'?'数字或随时':'填写实际内容')];
        return /^\d+\./.test(line)?[line.replace(/^(\d+\.).*/, '$1 具体内容')]:[];
    }).join('\n');
    const contract=['【程序任务与输出契约：保留，不由自定义规则改写】',builtin.split('\n').slice(0,2).join('\n'),
        '本次程序参数：'+JSON.stringify(parameters),
        '实际处境、用户要求、已演内容与篇章章表见本次用户消息。已发生事实和已演部分不可撤销；不代替用户选择，不写正文。',
        '只输出一个下列区块，标签和字段原样保留；列表条数遵守本次程序参数，不能照抄示例条数：',schema,
        parameters.epicMode==='audit'?'区块外再写一行“检查: 照旧”或具体调整原因。':''].filter(Boolean).join('\n');
    return applyPromptTemplate(tags[output[1]],text,{contract,variables:parameters});
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
