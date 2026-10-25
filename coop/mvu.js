import {object} from './model.js';
export function unwrap(value) {
    if(Array.isArray(value) && (value.length===1 || value.length===2 && typeof value[1]==='string')) return unwrap(value[0]);
    return value;
}
export function extraModel(context) {
    const box=context.extensionSettings?.mvu_settings || context.extension_settings?.mvu_settings || {};
    return /额外模型/.test(String(box['更新方式'] ?? box.updateMode ?? ''));
}
export function readMvuReport(variables) {
    const data=unwrap(variables?.stat_data?.['故事导演']?.Coop);
    const report=unwrap(data?.['回报']);
    return object(report)?report:null;
}
export function isProtectedCoopPath(path) {
    const normalized=String(path || '').replace(/\[['"]?([^'"\]]+)['"]?\]/g,'.$1').replace(/^(stat_data|status_current_variables)\./,'');
    return normalized==='故事导演.Coop' || normalized.startsWith('故事导演.Coop.');
}
export const bindingCapability=()=>({available:false,reason:'当前 MVU 没有经验证的统一写入拦截接口，使用 Coop 自有好感；未启用外部字段绑定。'});
