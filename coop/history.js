import {fail,text} from './model.js';

export function continuity(profile) {
    if(profile.history.length!==profile.rank || profile.history.some((h,i)=>h.rank!==i+1 || !h.summary)) fail('HISTORY_MISSING');
    const parts=['【角色固定种子】',JSON.stringify(profile.seeds || {}),'【全部已完成 Rank 摘要，均为有效历史】'];
    for(const h of profile.history) parts.push('Rank '+h.rank+' [事件 '+h.eventId+']\n'+h.summary+
        '\n用户实际选择：'+h.choice+'\n实际结果：'+h.outcome+
        '\n新增人物事实：'+h.facts.join('；')+'\n未解决：'+h.openHooks.join('；')+'\n已回收：'+h.closedHooks.join('；'));
    parts.push('【当前关系】'+profile.route,'【已确认习惯】'+profile.traits.join('；'),
        '【已确认事实】'+profile.facts.join('；'),'【当前边界】'+profile.boundaries.join('；'),
        '【未回收伏笔／承诺】'+profile.openHooks.join('；'));
    const result=parts.join('\n\n');
    if(result.length>30000) fail('CONTEXT_BUDGET','完整历阶摘要超出预算，请整理档案；不会静默丢弃前阶记录');
    return result;
}
export function publicMemory(profile) {
    if(profile.mode!=='coop') return '';
    return profile.name+((profile.aliases || []).length?'（别名：'+profile.aliases.join('、')+'）':'')+'：关系 '+profile.route+'，已完成 Rank '+profile.rank+
        '\n已实际公开的习惯／关系变化：'+[...profile.traits.slice(-6),...profile.boundaries.slice(-4),...profile.facts.slice(-5)].map(x=>text(x,220)).join('；');
}
