import fs from 'node:fs';
import vm from 'node:vm';
import * as model from '../model.js';

export function directorFixture() {
    const source=fs.readFileSync(new URL('../index.js',import.meta.url),'utf8');
    const settings={beatTarget:4,interludeBeats:3,chaptersPerEpic:4,intensity:'normal',tone:'auto',run:{}};
    const root={[model.NS]:{主线:model.emptyMain(),[model.EPIC]:model.emptyEpic(),支线:{},插曲:{}}};
    const context=vm.createContext({...model,settings:()=>settings,rootOf:()=>root,liveThreads:()=>[],completedChapterGoals:()=>[],chaptersPerEpic:()=>settings.chaptersPerEpic,
        INTENSITIES:{normal:{label:'适中'}},BEAT_MIN:3,BEAT_MAX:8});
    vm.runInContext(source.slice(source.indexOf('const COMMON_RULES ='),source.indexOf('async function buildUserPrompt(')),context);
    // 使用上游真实的预算与出口函数，让隔离的 askOracle 测试也遵循 0.41.10 的调用契约。
    vm.runInContext(source.slice(source.indexOf('const DESIGN_MIN_MAX_TOKENS ='),source.indexOf('function taskFromText(')),context);
    const sections=vm.runInContext('({common:COMMON_RULES,tone_guard:TONE_GUARD,design_both:DESIGN_BOTH,design_side:DESIGN_SIDE})',context);
    const build=(name,options={})=>{context.options=options;return vm.runInContext(name+'(options)',context);};
    return {source,settings,root,context,sections,build};
}
