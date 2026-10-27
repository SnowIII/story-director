/** Story evidence must survive display-only decoration and director cleanup. */
export function stripReport(body) {
    return String(body || '').replace(/<CoopReport\b[^>]*>[\s\S]*?<\/CoopReport>/gi,'')
        .replace(/<CoopReport\b[^>]*>[\s\S]*$/gi,'').trim();
}

export function legacyVisibleBody(body) {
    return stripReport(body).replace(/<UpdateVariable>[\s\S]*?<\/UpdateVariable>/gi,'')
        .replace(/<story_director_status>[\s\S]*?<\/story_director_status>/gi,'')
        .replace(/<!--\s*故事导演自检[\s\S]*?-->/g,'')
        .replace(/<故事导演(?:自检|审查|审查说明)>[\s\S]*?<\/故事导演(?:自检|审查|审查说明)>/g,'').trim();
}

// AutoInstructionAppender 会在发送下一轮时清掉历史消息的这些附加指令。
const instructionPattern = /<!--AIA_VISIBLE_START-->[\s\S]*?<!--AIA_VISIBLE_END-->|<!--\s*\[System Note\][\s\S]*?-->|<div class="aia-(?:stealth|visible)-cmd">\[System Note:[\s\S]*?<\/div>|<aia-cmd\b[^>]*>[\s\S]*?<\/aia-cmd>/gi;
export function instructionBlocks(body) {
    return [...String(body || '').matchAll(instructionPattern)].map(match=>match[0]);
}
export function instructionSourceVariants(body,blocks) {
    const raw=String(body || ''),clean=raw.replace(instructionPattern,''),variants=new Set([raw]);
    for(const block of blocks) {
        // 记忆插件可能把原输入包在这个标签里；只还原实际见过的指令块，不信任缓存里的旧哈希。
        if(clean.includes('</本轮用户输入>')) variants.add(clean.replace(/\s*<\/本轮用户输入>/,()=> '\n\n'+block+'\n</本轮用户输入>'));
        variants.add(clean.trimEnd()+'\n\n'+block);
    }
    return [...variants];
}

function variableRanges(body) {
    const ranges=[];
    let start=null, contentDepth=0;
    const payloadAt=to=>start!==null && /^\s*(?:<(?:Analysis|JSONPatch)\b|_\.(?:set|add|assign|insert)\s*\(|\[\s*\{)/i.test(body.slice(start,to).replace(/^<UpdateVariable\b[^>]*>/i,''));
    // A new opener supersedes an earlier mention. A story boundary cancels it.
    for(const match of body.matchAll(/<\/?(UpdateVariable|content)\b[^>]*>/gi)) {
        const closing=/^<\//.test(match[0]), name=match[1].toLowerCase();
        if(name==='content') {
            if(payloadAt(match.index)) continue; // A quoted content tag inside JSON is still variable data.
            start=null;
            contentDepth=Math.max(0,contentDepth+(closing?-1:1));
        } else if(!contentDepth) {
            if(!closing) {if(!payloadAt(match.index)) start=match.index;}
            else if(start!==null) {ranges.push([start,match.index+match[0].length]);start=null;}
        }
    }
    // Incomplete variable payloads are not narrative evidence either.
    if(start!==null && /^\s*(?:<(?:Analysis|JSONPatch)\b|_\.(?:set|add|assign|insert)\s*\(|\[\s*\{)/i.test(body.slice(start).replace(/^<UpdateVariable\b[^>]*>/i,''))) ranges.push([start,body.length]);
    return ranges;
}

function withoutAnalysis(body,{keepInstructions=false}={}) {
    let result=stripReport(body);
    if(!keepInstructions) result=result.replace(instructionPattern,'');
    result=result.replace(/<(build|think|thinking|analysis)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,'');
    // An unfinished analysis block cannot consume a following explicit story.
    result=result.replace(/<(?:build|think|thinking|analysis)\b[^>]*>([\s\S]*)$/gi,(_all,tail)=>{
        const story=tail.search(/<content\b|###\s*正文/i);
        return story<0?'':tail.slice(story);
    });
    return result;
}
export function updateVariableBlocks(body) {
    const clean=withoutAnalysis(body);
    return variableRanges(clean).map(([from,to])=>clean.slice(from,to)).filter(block=>/<\/UpdateVariable\s*>$/i.test(block));
}
export function visibleBody(body,{keepImagePlaceholders=false,keepInstructions=false}={}) {
    let result=withoutAnalysis(body,{keepInstructions});
    for(const [from,to] of variableRanges(result).reverse()) result=result.slice(0,from)+result.slice(to);
    result=result
        .replace(/<story_director_status\b[^>]*>[\s\S]*?<\/story_director_status\s*>/gi,'')
        .replace(/<!--\s*故事导演自检[\s\S]*?-->/gi,'')
        .replace(/<(故事导演(?:自检|审查|审查说明))>[\s\S]*?<\/\1>/gi,'')
        .replace(/(\r?\n)?\[igs-img:\d+\](\r?\n)?/gi,(_all,before,after)=>before && after?'\n':'');
    if(!keepImagePlaceholders) result=result.replace(/(?:\r?\n)?<IMG>\s*\d+\s*<\/IMG>(?:\r?\n)?/gi,'');
    return result.replace(/\r\n?/g,'\n').replace(/\n{3,}/g,'\n\n').trim();
}

export function evidenceText(body,options) {
    return visibleBody(body,options).replace(/\s+/gu,' ').trim();
}
export function hasEvidence(body,quote) {
    const expected=evidenceText(quote);
    return !!expected && evidenceText(body).includes(expected);
}
export function fingerprintBody(body,options) {
    return evidenceText(body,options).replace(/\s*(<\/?[\p{L}_][^>]*>)\s*/gu,'$1');
}

/** Reconstruct only known presentation edits; never trust a claimed old hash. */
export function legacyBodyVariants(raw,limit=128,{keepImagePlaceholders=false}={}) {
    const original=legacyVisibleBody(raw), result=new Set([original]);
    const marker=keepImagePlaceholders?/(\r?\n)?\[igs-img:\d+\](\r?\n)?/i:
        /(\r?\n)?(?:\[igs-img:\d+\]|<IMG>\s*\d+\s*<\/IMG>)(\r?\n)?/i;
    let variants=[original];
    for(let n=0;n<24 && variants.some(value=>marker.test(value));n++) {
        const next=new Set();
        for(const value of variants) {
            const match=marker.exec(value);
            if(!match) {next.add(value);continue;}
            const before=match[1] || '',after=match[2] || '',left=value.slice(0,match.index),right=value.slice(match.index+match[0].length);
            for(const replacement of [before+after,before,after,'']) {
                if(next.size<64) next.add(left+replacement+right);
            }
        }
        variants=[...next];
    }
    for(const value of variants) {
        result.add(value);
        result.add(value.replace(/\n{3,}/g,'\n\n').trim());
    }
    // Old director cleanup collapsed the gaps left by a removed self-check.
    for(const value of [...result]) {
        for(const match of value.matchAll(/\n{2}(?!\n)/g)) {
            for(const count of [3,4]) {
                if(result.size>=limit) return [...result].slice(0,limit);
                result.add(value.slice(0,match.index)+'\n'.repeat(count)+value.slice(match.index+2));
            }
        }
    }
    return [...result].slice(0,limit);
}
