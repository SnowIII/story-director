/** Explicit names belong to one stable profile ID. Do not infer aliases from surnames or descriptions. */
const readable=value=>String(value ?? '').normalize('NFKC').replace(/\s*[·・•‧∙⋅]\s*/g,'·').replace(/\s+/g,' ').trim();
export const normalizeName=value=>readable(value).toLowerCase();
function invalid(message){const error=new Error(message);error.code='INVALID_ALIASES';throw error;}
export function parseAliases(value=[],name='') {
    const input=typeof value==='string'?value.split(/[,，;；、\n\r]+/):value;
    if(!Array.isArray(input)) invalid('别名须用逗号或换行分隔');
    const seen=new Set([normalizeName(name)]),result=[];
    for(const item of input) {
        if(typeof item!=='string') invalid('每个别名都必须是文字');
        const alias=readable(item),key=normalizeName(alias);
        if(!alias || seen.has(key)) continue;
        if(alias.length>100) invalid('单个别名不能超过100字');
        if(/^(她|他|它|你|您|我|我们|你们|他们|她们|它们)$/u.test(alias)) invalid('请填写明确的人物称呼，不要把人称代词设为别名');
        seen.add(key);result.push(alias);
        if(result.length>12) invalid('每名角色最多保存12个别名');
    }
    return result;
}
export function identityNames(profile) {
    return [...new Set([profile.name,...parseAliases(profile.aliases || [],profile.name)].map(normalizeName).filter(Boolean))];
}
export function assertIdentityAvailable(config,roster) {
    const names=new Set(identityNames(config));
    for(const other of Object.values(roster)) {
        if(other.id===config.id) continue;
        const conflict=identityNames(other).find(name=>names.has(name));
        if(conflict) {
            const error=new Error('称呼“'+conflict+'”已被“'+other.name+'”使用，请用全名或不同的简称区分；不会自动合并两份档案');
            error.code='AMBIGUOUS_IDENTITY';throw error;
        }
    }
}
const asciiWord=char=>!!char && /[a-z0-9_]/i.test(char);
function boundaries(body,start,token) {
    return !(asciiWord(token[0]) && asciiWord(body[start-1])) &&
        !(asciiWord(token.at(-1)) && asciiWord(body[start+token.length]));
}
export function mentionsProfile(profile,value,profiles=[profile]) {
    const body=normalizeName(value);
    if(!body) return false;
    const others=profiles.filter(other=>other.id!==profile.id).flatMap(identityNames);
    for(const token of identityNames(profile)) {
        // Legacy/imported ambiguous names are not guessed, even if a config predates validation.
        if(others.includes(token)) continue;
        for(let at=body.indexOf(token);at>=0;at=body.indexOf(token,at+token.length)) {
            if(!boundaries(body,at,token)) continue;
            let shadowed=false;
            for(const longer of others) {
                if(longer.length<=token.length) continue;
                for(let offset=longer.indexOf(token);offset>=0;offset=longer.indexOf(token,offset+1)) {
                    const start=at-offset;
                    if(start>=0 && body.startsWith(longer,start) && boundaries(body,start,longer)) {shadowed=true;break;}
                }
                if(shadowed) break;
            }
            if(!shadowed) return true;
        }
    }
    return false;
}
