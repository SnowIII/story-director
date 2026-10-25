import {text,hash,activeEvent,RANK_COUNT,RELATIONSHIP_RANK} from './model.js';
import {candidates} from './roster.js';
import {safeJson,uuid} from './messages.js';
import {bindingCapability} from './mvu.js';
const esc=value=>String(value ?? '').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const labels={off:'不管理',affinity:'仅维护好感',coop:'好感＋Coop',hook:'反常切入',dilemma:'困境与提问',
    waiting_user:'等待用户回应',waiting_route:'等待确认关系路线',resolution:'破局与收束',completed:'已完成'};
export function mountCoopUI(runtime,{container=null,onOpen=null}={}) {
    document.querySelectorAll('#story-director-coop-entry').forEach(entry=>entry.remove());
    const embedded=!!container;
    let panel=document.getElementById('story-director-coop-panel'), tab='roles', chosen='';
    if(panel) return {open:()=>{onOpen?.();panel.hidden=false;}};
    panel=document.createElement(embedded?'div':'aside');panel.id='story-director-coop-panel';panel.hidden=!embedded;
    panel.classList.toggle('sdc-embedded',embedded);
    panel.setAttribute('role',embedded?'region':'dialog');panel.setAttribute('aria-label','Coop 羁绊');
    (container || document.body).appendChild(panel);
    const run=async task=>{try {await task();} catch(error){runtime.notice(error);}};
    function open() {
        onOpen?.();panel.hidden=false;render();
        panel.querySelector(embedded?'nav button':'[data-action="close"]')?.focus();
    }
    function card(p) {
        const helpId='sdc-profile-'+hash(p.id);
        const unfinished=Object.values(p.events).find(e=>e.phase!=='completed');
        const next=p.rank<RANK_COUNT?p.thresholds[p.rank]:'—';
        return '<article class="sdc-card"><div class="sdc-row"><strong>'+esc(p.name)+'</strong><span>'+esc(labels[p.mode])+'</span></div>'+
            ((p.aliases || []).length?'<p class="sdc-field-help">别名／简称：'+esc(p.aliases.join('、'))+'</p>':'')+
            '<p>'+ (p.lock?'🔒 ':'')+'好感 '+p.affinity+'／100 · Rank '+p.rank+'／'+RANK_COUNT+' · 下一阶门槛 '+next+'</p>'+
            (p.lock?'<p class="sdc-lock">完成 Rank '+p.lock.targetRank+' 羁绊事件后解锁；增减均暂停，不补发积分。</p>':'')+
            '<label>管理模式 <select data-mode="'+esc(p.id)+'">'+['off','affinity','coop'].map(mode=>'<option value="'+mode+'"'+(mode===p.mode?' selected':'')+'>'+labels[mode]+'</option>').join('')+'</select></label>'+
            '<div class="sdc-actions">'+
            (p.mode==='coop' && p.lock && !unfinished?'<button data-action="start" data-id="'+esc(p.id)+'">开始下一阶事件</button>':'')+
            (p.mode==='coop' && unfinished?'<button data-action="'+(unfinished.paused?'resume':'pause')+'" data-id="'+esc(p.id)+'" data-event="'+esc(unfinished.id)+'">'+(unfinished.paused?'继续事件':'暂停事件')+'</button>':'')+
            (p.mode==='coop' && unfinished?.paused?'<button data-action="replan" data-id="'+esc(p.id)+'" data-event="'+esc(unfinished.id)+'">重设未演部分</button>':'')+
            '<button data-action="history" data-id="'+esc(p.id)+'">历阶摘要／档案</button></div>'+
            '<details><summary>编辑角色说明</summary><form data-edit="'+esc(p.id)+'">'+
            '<label>名称<input name="name" value="'+esc(p.name)+'" placeholder="填写正文中使用的角色名或常用称呼" aria-describedby="'+helpId+'-name" required maxlength="100"></label>'+
            '<p id="'+helpId+'-name" class="sdc-field-help">用于界面显示和对话识别，建议与正文中的称呼一致。</p>'+
            '<label>别名／简称（可选）<textarea name="aliases" rows="2" maxlength="1400" placeholder="例：英妮缇雅，维赛塔&#10;同一人物的其他称呼，用逗号或换行分隔。" aria-describedby="'+helpId+'-aliases">'+esc((p.aliases || []).join('，'))+'</textarea></label>'+
            '<p id="'+helpId+'-aliases" class="sdc-field-help">所有别名共用这一份好感、Rank 和摘要。只填明确称呼，避免“她”“老师”等泛称；与其他角色重名会提示冲突，不会自动合并档案。</p>'+
            '<label>补充设定（可选）<textarea name="description" rows="4" maxlength="12000" placeholder="可留空。神谕会自动从角色卡和故事上下文提取已有设定。&#10;这里只补充你希望额外说明的性格、背景或关系限制。" aria-describedby="'+helpId+'-description">'+esc(p.description)+'</textarea></label>'+
            '<p id="'+helpId+'-description" class="sdc-field-help">设计事件时，神谕会读取角色卡、相关世界书、近期对话和历阶摘要。需要额外补充时再填写；已有内容会保留，已发生的历史请在摘要中修正。</p>'+
            '<p>固定四阶门槛：30 → 60 → 90 → 100。</p>'+
            '<button type="submit">保存</button></form></details></article>';
    }
    function roles(state) {
        const list=Object.values(state.profiles);
        const choices=candidates(runtime.host.context()), available=choices.filter(c=>!state.profiles[c.id]);
        return '<p>只有你加入并启用的角色才会维护好感或生成 Coop。出场和被提及不会自动加入。</p>'+
            '<p>固定四阶门槛：30 → 60 → 90 → 100；事件完成并归档后才解锁。</p>'+
            '<form id="sdc-add-card"><label>当前角色卡／群聊成员<select name="candidate"'+(!available.length?' disabled':'')+'>'+
            (choices.length?choices.map(c=>'<option value="'+esc(c.id)+'"'+(state.profiles[c.id]?' disabled':'')+
                (c.id===(available[0] || choices[0]).id?' selected':'')+'>'+esc(c.name)+(state.profiles[c.id]?'（已管理）':'')+'</option>').join(''):
                '<option value="" selected disabled>暂未读取到角色卡／群聊成员</option>')+'</select></label>'+
            '<label>管理模式<select name="mode"><option value="affinity">仅维护好感</option><option value="coop">好感＋Coop</option></select></label>'+
            '<button type="submit"'+(!available.length?' disabled':'')+'>加入所选角色</button></form>'+
            '<p class="sdc-note">这里读取酒馆当前角色卡或群聊成员，不会自动识别卡内 NPC。整合卡中的具体人物请用下面的「手动添加卡内 NPC」。</p>'+
            (choices.length && !available.length?'<p>当前角色卡／群聊成员均已加入管理，请在下方档案中修改模式。</p>':'')+
            '<details><summary>手动添加卡内 NPC</summary><form id="sdc-add-npc">'+
            '<label>NPC 名称<input name="name" placeholder="例：艾琳（与正文或角色设定中的称呼一致）" aria-describedby="sdc-npc-name-help" required maxlength="100"></label>'+
            '<p id="sdc-npc-name-help" class="sdc-field-help">填写要单独维护好感和 Coop 的具体人物名，便于在对话中识别。</p>'+
            '<label>别名／简称（可选）<textarea name="aliases" rows="2" maxlength="1400" placeholder="例：英妮缇雅，维赛塔&#10;同一人物的其他称呼，用逗号或换行分隔。" aria-describedby="sdc-npc-aliases-help"></textarea></label>'+
            '<p id="sdc-npc-aliases-help" class="sdc-field-help">全名和别名会归到同一个人物档案，不会重复加分或另开 Coop 线。共用姓氏可能有歧义，请只加入能明确指代此人的称呼。</p>'+
            '<label>补充设定（可选）<textarea name="description" rows="4" maxlength="12000" placeholder="可留空。神谕会从当前角色卡、世界书和故事上下文提取已有设定。&#10;例：对陌生人保持戒心，但答应过的事一定做到。仅填写你希望额外补充的内容。" aria-describedby="sdc-npc-description-help"></textarea></label>'+
            '<p id="sdc-npc-description-help" class="sdc-field-help">不必手动抄写人物档案，留空也能添加。设计事件时由神谕提取已有设定；这里仅作额外补充，不能用来改写已发生的历史。</p>'+
            '<label>管理模式<select name="mode"><option value="affinity">仅维护好感</option><option value="coop">好感＋Coop</option></select></label>'+
            '<label>初始好感<input name="initialAffinity" type="number" min="0" max="100" value="0" placeholder="0～100，通常从 0 开始" aria-describedby="sdc-initial-affinity-help"></label>'+
            '<p id="sdc-initial-affinity-help" class="sdc-field-help">设定两人已有的关系基础，通常填 0。启用 Coop 且达到首阶门槛时，会封顶到 30 并锁定；Rank 仍需完成事件提升。</p>'+
            '<button type="submit">添加 NPC</button></form></details>'+
            (list.length?list.map(card).join(''):'<p class="sdc-empty">管理名单为空。先选择角色，再开始互动。</p>');
    }
    function eventPage(state) {
        const event=activeEvent(state);
        if(runtime.job) return '<p>'+esc(runtime.job.label || '正在设计所选角色的当前阶事件')+'……</p><button data-action="abort">中断生成</button>';
        if(!event) {
            const pending=Object.values(state.profiles).filter(p=>p.mode==='coop' && p.lock);
            return '<p>当前没有正在演出的 Coop 事件。</p>'+pending.map(card).join('');
        }
        const p=state.profiles[event.characterId], plan=event.plan;
        return '<h3>'+esc(p.name)+' · Rank '+event.targetRank+' · '+esc(plan.title)+'</h3>'+
            '<p>当前阶段：'+esc(labels[event.phase])+'</p><p>'+esc(plan.scene)+'</p>'+
            '<p class="sdc-lock">好感 '+p.affinity+' 已锁定。事件结束并归档成功后解锁。</p>'+
            (event.phase==='waiting_route' || event.phase==='resolution' && event.targetRank===RELATIONSHIP_RANK?'<p>请根据你的真实回应确认关系路线。确认后继续聊天，演绎收束；改变心意时可以重新选择。</p>'+
                '<button data-action="route" data-route="friendship">确认为挚友／伙伴</button> <button data-action="route" data-route="romance">确认为恋人</button>':'')+
            (event.phase==='resolution'?'<p>若本阶已经在正文中收束，但回报缺失，可只补齐归档。</p><button data-action="archive">核对并补齐归档</button>':'')+
            '<div class="sdc-actions"><button data-action="pause" data-id="'+esc(p.id)+'" data-event="'+esc(event.id)+'">暂停演出</button></div>'+
            '<details><summary>幕后计划（包含剧透）</summary><pre>'+esc(JSON.stringify(plan,null,2))+'</pre></details>';
    }
    function archive(state) {
        const profiles=Object.values(state.profiles);
        const p=state.profiles[chosen] || profiles[0];
        if(!p) return '<p>尚无角色档案。</p>';
        chosen=p.id;
        const activity=runtime.affinityActivity(p.id);
        return '<label>查看角色<select id="sdc-history-role">'+profiles.map(item=>'<option value="'+esc(item.id)+'"'+(item.id===p.id?' selected':'')+'>'+esc(item.name)+'</option>').join('')+'</select></label>'+
            '<p>路线：'+esc(p.route==='romance'?'恋人':p.route==='friendship'?'挚友／伙伴':'尚未确认')+'</p>'+
            '<p>已公开人物细节：'+esc([...p.traits,...p.facts,...p.boundaries].join('；') || '尚无')+'</p>'+
            '<p>未回收伏笔：'+esc(p.openHooks.join('；') || '尚无')+'</p>'+
            (p.history.length?p.history.map(h=>'<article class="sdc-card"><strong>Rank '+h.rank+'</strong><p>'+esc(h.summary)+'</p>'+
                '<p>实际选择：'+esc(h.choice)+'</p><p>结果：'+esc(h.outcome)+'</p>'+
                '<p>未解决：'+esc(h.openHooks.join('；') || '无')+'</p><p>已回收：'+esc(h.closedHooks.join('；') || '无')+'</p>'+
                '<details><summary>修正本阶摘要</summary><form data-summary="'+esc(h.eventId)+'" data-character="'+esc(p.id)+'">'+
                '<textarea name="summary" aria-label="本阶经历摘要" placeholder="概括本阶实际发生的矛盾、用户选择、结果、人物变化和未解决伏笔，建议 100～200 字。" rows="4" minlength="20" maxlength="1200">'+esc(h.summary)+'</textarea><p class="sdc-field-help">后续事件会读取这份摘要。只修正有依据的概括，不改写已发生的选择，并核对后续经历是否仍一致。</p><button type="submit">确认修正并保存</button></form></details></article>').join(''):'<p>尚未完成 Rank 事件。完成后会在这里逐阶保存摘要。</p>')+
            '<details><summary>好感变化记录（最近 30 次）</summary>'+p.scoreLog.slice(-30).reverse().map(log=>
                '<p>'+esc((log.actual>=0?'+':'')+log.actual)+' · '+esc(log.reasonCode==='AFFINITY_LOCKED'?'未完成事件，好感锁定':log.reason)+
                ' · '+log.before+' → '+log.after+'</p>').join('')+'</details>'+
            '<details open><summary>最近互动处理</summary><p class="sdc-field-help">查看本轮是否已计分、正常没有变化、被好感锁定，或因依据和来源变化而未结算。</p>'+
            (activity.length?activity.map(item=>'<p>第 '+(item.index+1)+' 条消息 · '+esc(item.label)+'</p>').join(''):
                '<p>尚无可核对的互动回报。</p>')+'</details>';
    }
    function diagnostics() {
        const state=runtime.state(),store=runtime.store,profiles=Object.values(state.profiles);
        const event=activeEvent(state),locked=profiles.filter(p=>p.lock);
        const paused=profiles.flatMap(p=>Object.values(p.events)).filter(e=>e.paused && e.phase!=='completed');
        const ready=profiles.filter(p=>p.mode==='coop' && p.lock && !Object.values(p.events).some(e=>e.phase!=='completed'));
        const skipped=state.skipped || [];
        const stale=skipped.filter(item=>['STALE_SOURCE','STALE_DEPENDENCY'].includes(item.code)).length;
        const invalid=skipped.length-stale;
        let saving='当前没有待保存的改动';
        if(store.pending) saving=store.error?'保存失败，进度尚未确认；请点击“重试保存”。'+(store.error.message || ''):'正在保存，请等待服务器确认';
        let scene='暂无正在演出的 Coop 事件';
        if(runtime.job) scene=(runtime.job.label || '正在设计事件')+'，请等待或在“当前事件”中中断';
        else if(event) scene=(state.profiles[event.characterId]?.name || '角色')+' · Rank '+event.targetRank+' · '+(labels[event.phase] || event.phase);
        else if(paused.length || ready.length) scene=[paused.length?paused.length+' 条事件已暂停，可在“管理角色”中继续':'',
            ready.length?ready.length+' 名角色的升阶事件已就绪，可在“管理角色”中开始':''].filter(Boolean).join('；');
        const rows=[
            ['保存状态',saving],
            ['写入权限',store.readonly?'当前窗口只读，无法保存改动；请按上方提示处理':'当前窗口可以维护和保存 Coop 档案'],
            ['角色档案',profiles.length+' 个：好感＋Coop '+profiles.filter(p=>p.mode==='coop').length+'，仅维护好感 '+profiles.filter(p=>p.mode==='affinity').length+'，不管理 '+profiles.filter(p=>p.mode==='off').length],
            ['当前事件',scene],
            ['好感锁定',locked.length?locked.length+' 名角色等待完成事件后解锁；锁定期间增减均不结算':'当前没有角色被事件门槛锁定'],
            ['消息回退',skipped.length?(stale?stale+' 条记录因来源消息或前置进度变化而失效；进度已按有效记录重新计算。':'')+
                (invalid?invalid+' 条记录未通过校验，请查看技术详情。':''):'未发现因消息改动而失效的进度记录'],
            ['最近提示',runtime.notices[0]?.message || '本次页面运行暂无提示']
        ];
        return '<details><summary>运行状态与诊断</summary><p class="sdc-field-help">用于确认数据能否保存、事件在等什么，以及消息改动是否导致进度回退。</p><div class="sdc-card">'+
            rows.map(([name,value])=>'<p><strong>'+esc(name)+'：</strong>'+esc(value)+'</p>').join('')+'</div>'+
            '<details><summary>技术详情（原始 JSON）</summary><pre>'+esc(JSON.stringify({scope:store.scope,revision:store.document.revision,
                invalidated:skipped,notices:runtime.notices},null,2))+'</pre></details></details>';
    }
    function settings() {
        return '<label><input id="sdc-auto" type="checkbox"'+(runtime.store.document.settings.autoStart?' checked':'')+'> 在角色可参与且场景空闲时自动开始已就绪事件</label>'+
            '<label>新事件默认轮数<select id="sdc-rounds"><option value="3"'+(runtime.store.document.settings.eventRounds===3?' selected':'')+'>三轮：切入、困境、收束</option><option value="2"'+(runtime.store.document.settings.eventRounds===2?' selected':'')+'>两轮：切入与困境合并</option></select></label>'+
            '<p>关闭自动开始不解除好感锁。始终只处理管理名单中的角色。</p>'+
            '<p>外部 MVU 字段绑定：'+esc(bindingCapability().reason)+'</p>'+
            '<div class="sdc-actions"><button type="button" data-action="export">导出当前聊天 Coop 档案</button>'+
            '<button type="button" data-action="import" aria-controls="sdc-import">恢复同聊天档案</button></div>'+
            '<input id="sdc-import" type="file" accept="application/json,.json" hidden>'+
            '<p>恢复会核对当前聊天的消息来源。其他聊天的经历不会凭空变成当前事实。</p>'+
            diagnostics();
    }
    function render() {
        if(panel.hidden) return;
        const state=runtime.state(), focus=panel.contains(document.activeElement);
        if(focus && document.activeElement?.matches('input:not([type="checkbox"]),textarea')) return;
        panel.innerHTML=(embedded?'':'<header><strong>♡ Coop／羁绊</strong><button data-action="close" aria-label="关闭 Coop 面板">✕</button></header>')+
            '<nav>'+[['roles','管理角色'],['event','当前事件'],['archive','历阶摘要'],['settings','设置']].map(([key,label])=>
                '<button data-tab="'+key+'" aria-pressed="'+(tab===key)+'">'+label+'</button>').join('')+'</nav>'+
            '<div class="sdc-body">'+(!state?'<p>'+esc(runtime.notices[0]?.message || '请先打开一个可保存的角色聊天。')+'</p>':
                (runtime.store.readonly?'<p class="sdc-warning">当前窗口只读。<button data-action="takeover">接管写入</button></p>':'')+
                (runtime.store.pending?'<p class="sdc-warning">归档待保存。'+(runtime.store.error?esc(runtime.store.error.message)+' <button data-action="retry">重试保存</button>':'正在等待服务器确认……')+'</p>':'')+
                (runtime.notices[0]?'<p role="status">'+esc(runtime.notices[0].message)+' <button data-action="dismiss">知道了</button></p>':'')+
                ({roles:roles,event:eventPage,archive:archive,settings:settings}[tab])(state))+'</div>';
        if(runtime.store.readonly || runtime.store.pending) panel.querySelectorAll('form button,form input,form textarea,form select,[data-mode],[data-action="start"],[data-action="resume"],[data-action="route"],[data-action="import"],#sdc-import').forEach(node=>{node.disabled=true;});
    }
    panel.addEventListener('click',event=> {
        const button=event.target.closest('button');if(!button) return;
        if(button.dataset.tab){tab=button.dataset.tab;render();return;}
        const action=button.dataset.action, key=button.dataset.id;
        if(action==='close'){panel.hidden=true;return;}
        if(action==='history'){chosen=key;tab='archive';render();}
        if(action==='start') run(()=>runtime.generate(key));
        if(action==='replan') run(()=>runtime.generate(key,{replanEventId:button.dataset.event}));
        if(action==='pause') run(()=>runtime.pause(key,button.dataset.event));
        if(action==='resume') run(()=>runtime.resume(key,button.dataset.event));
        if(action==='route') run(()=>runtime.route(button.dataset.route));
        if(action==='archive') run(()=>runtime.recoverArchive());
        if(action==='abort') runtime.abort();
        if(action==='retry') run(()=>runtime.store.retrySave());
        if(action==='takeover') run(()=>runtime.takeover());
        if(action==='dismiss'){runtime.notices.shift();render();}
        if(action==='import') panel.querySelector('#sdc-import')?.click();
        if(action==='export') {
            const url=URL.createObjectURL(new Blob([runtime.export()],{type:'application/json'}));
            const a=document.createElement('a');a.href=url;a.download='Coop-羁绊档案.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
        }
    });
    panel.addEventListener('change',event=>{
        const node=event.target;
        if(node.dataset.mode) run(async()=>{
            const p=runtime.state().profiles[node.dataset.mode];
            try {await runtime.configure({...p,mode:node.value});}
            catch(error) {if(error.code==='CAP_CONFIRMATION' && window.confirm(error.message)) await runtime.configure({...p,mode:node.value,acceptCap:true});else throw error;}
        });
        if(node.id==='sdc-history-role'){chosen=node.value;render();}
        if(node.id==='sdc-auto') run(()=>runtime.configureSettings({autoStart:node.checked}));
        if(node.id==='sdc-rounds') run(()=>runtime.configureSettings({eventRounds:Number(node.value)}));
        if(node.id==='sdc-import' && node.files?.[0]) run(async()=>{
            const data=safeJson(await node.files[0].text(),8*1024*1024);
            if(data.scope!==runtime.store.scope) throw new Error('只允许恢复当前聊天的档案；其他聊天请使用宿主分支功能。');
            if(window.confirm('用所选文件恢复当前聊天的 Coop 档案？')) await runtime.restore(data);
        });
    });
    panel.addEventListener('submit',event=>{
        event.preventDefault();const form=event.target, data=new FormData(form);
        run(async()=>{
            let input;
            if(form.id==='sdc-add-card') {
                const candidate=candidates(runtime.host.context()).find(c=>c.id===data.get('candidate'));
                if(!candidate || runtime.state().profiles[candidate.id]) throw new Error('该角色已加入管理或当前角色卡已切换，请重新选择。');
                input={...candidate,mode:data.get('mode')};
            } else if(form.id==='sdc-add-npc') {
                if(Object.values(runtime.state().profiles).some(p=>p.name===text(data.get('name'),100))) throw new Error('同名角色已有档案，请在现有行中修改模式或说明。');
                input={id:'npc:'+uuid(),name:data.get('name'),aliases:data.get('aliases'),description:data.get('description'),
                    mode:data.get('mode'),initialAffinity:Number(data.get('initialAffinity'))};
            } else if(form.dataset.edit) {
                input={...runtime.state().profiles[form.dataset.edit],name:data.get('name'),aliases:data.get('aliases'),description:data.get('description')};
            } else if(form.dataset.summary) {
                await runtime.editSummary(form.dataset.character,form.dataset.summary,data.get('summary'));
            }
            if(input) {
                try {await runtime.configure(input);}
                catch(error){if(error.code==='CAP_CONFIRMATION' && window.confirm(error.message)) await runtime.configure({...input,acceptCap:true});else throw error;}
                if(form.id==='sdc-add-npc') form.reset();
            }
        });
    });
    panel.addEventListener('keydown',event=>{if(event.key==='Escape' && !embedded){event.stopPropagation();panel.hidden=true;}});
    runtime.onChange(render);
    return {open,render};
}
