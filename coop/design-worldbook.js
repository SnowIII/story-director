import {preservePromptEntries} from '../prompt-worldbook.js';

// 本版只开放页面输出字段的写法。Coop 设计、阶级蓝图与形式库使用代码内置规则。
export function designTemplates() { return {}; }

// 整本替换时只带回当前字段配置；旧版条目按新的条目集合直接移除，不留存档。
export function preserveDesignTemplates(bundled,installed) {
    return preservePromptEntries(bundled,installed);
}
