import {preservePromptEntries} from '../prompt-worldbook.js';

// 字段写法与可选返回前置内容在通用层配置。Coop 设计、阶级蓝图与形式库使用代码内置规则。
export function designTemplates() { return {}; }

// 整本替换时带回当前字段与前置内容配置；旧版条目按新的条目集合直接移除，不留存档。
export function preserveDesignTemplates(bundled,installed) {
    return preservePromptEntries(bundled,installed);
}
