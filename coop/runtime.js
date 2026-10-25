import {clone,fail,text,hash,activeEvent,profileOf,historySignature,RANK_COUNT} from './model.js';
import {CoopStore} from './store.js';
import {configureRoster} from './roster.js';
import {appendOperation,project,readDocument} from './timeline.js';
import {validateAffinityProposal} from './affinity.js';
import {continuity,publicMemory} from './history.js';
import {ensureMessageIds,sourceMap,sourceForId,ref,references,parseReports,stripReport,uuid,modelJson} from './messages.js';
import {designMessages,renderScene,reportContract} from './prompts.js';
import {extraModel,readMvuReport} from './mvu.js';

export class CoopRuntime {
    constructor(host) {
        this.host=host;this.store=new CoopStore(host);this.snapshot=null;this.snapshots=new Map();
        this.job=null;this.notices=[];this.listeners=new Set();this.scene=false;this.lease=null;
        this.disposed=false;this.queue=Promise.resolve();this.lastAutoFailure=0;this.pendingMvuReports=new Map();
        const broadcast=host.broadcast;
        host.broadcast=document=>{
            broadcast?.(document);
            this.channel?.postMessage({scope:this.store.scope,document,state:this.state()});
        };
        this.store.onChange=()=>this.changed();
    }
    onChange(fn) {this.listeners.add(fn);return ()=>this.listeners.delete(fn);}
    changed() {
        const scene=this.occupies();
        if(scene!==this.scene) {this.scene=scene;this.host.sceneChanged?.(scene);}
        this.host.syncPrompts?.();
        for(const listener of this.listeners) listener();
    }
    notice(error) {
        const code=error.code || 'ERROR';
        if(['ALREADY_COMMITTED','WAITING_USER'].includes(code)) return;
        const chinese={NOT_MANAGED:'已忽略未管理角色的回报',STALE_SOURCE:'这份回报所属的消息已改变，已忽略',
            STALE_POLICY:'角色管理设置已变化，旧回报已忽略',STALE_EVENT:'事件已经推进或回退，旧回报已忽略',
            INVALID_EVIDENCE:'回报缺少可核对的正文／用户回应依据，本次没有结算',
            INVALID_PLAN:'事件设计格式不完整，请重新设计',SUMMARY_MISSING:'事件摘要未完整生成，等待有效归档回报',
            CONTINUITY_CONFLICT:'新内容与已确认历史存在冲突，请核对档案或重设未演部分'};
        this.notices.unshift({code,message:chinese[code] || error.message,detail:error.message,at:Date.now()});
        this.notices=this.notices.slice(0,25);this.changed();
    }
    state() {return this.store.state;}
    event() {return this.state()?activeEvent(this.state()):null;}
    occupies() {return !!this.event() || !!this.job;}
    load() {
        const task=(this.loading || Promise.resolve()).catch(()=>{}).then(()=>this.loadNow());
        this.loading=task;return task;
    }
    async loadNow() {
        this.abort();
        this.snapshot=null;this.snapshots.clear();this.pendingMvuReports.clear();
        this.channel?.close();this.channel=null;
        await this.releaseLease();
        try {this.store.load();} catch(error) {this.store.state=null;this.notice(error);return;}
        await this.acquireLease();
        if(globalThis.window && typeof globalThis.BroadcastChannel==='function' && this.store.scope) {
            this.channel=new BroadcastChannel('story-director-coop:'+this.store.scope);
            this.channel.onmessage=event=>{
                const data=event.data;
                if(!this.store.readonly || data?.scope!==this.store.scope || !data.document || data.document.revision<=(this.store.document?.revision || 0)) return;
                this.store.document=readDocument(data.document,this.store.scope);
                this.store.state=clone(data.state);
                const meta=this.host.metadata();if(meta) meta.storyDirectorCoop=clone(data.document);
                this.changed();
            };
        }
        this.changed();
    }
    async acquireLease() {
        const scope=this.store.scope;
        if(!scope) return;
        if(this.lease?.scope===scope) return;
        const locks=this.host.locks || globalThis.navigator?.locks;
        if(!locks) {
            this.store.readonly=true;this.notice({code:'READ_ONLY',message:'当前浏览器缺少写入互斥能力，Coop 档案只读。'});return;
        }
        this.store.readonly=true;
        let release;
        const held=new Promise(resolve=>{release=resolve;});
        const acquired=new Promise(resolve=>{
            this.lockRequest=locks.request('story-director-coop:'+scope,{ifAvailable:true},async lock=>{
                if(!lock || this.store.scope!==scope || this.disposed) {resolve(false);return;}
                this.lease={scope,release};this.store.readonly=false;resolve(true);this.changed();
                await held;
            }).catch(error=>{this.notice(error);resolve(false);});
        });
        if(!await acquired) this.notice({code:'READ_ONLY',message:'另一个窗口正在维护此聊天。关闭该窗口后可点击“接管写入”。'});
    }
    releaseLease() {
        const done=this.lockRequest;
        this.lease?.release();this.lease=null;this.lockRequest=null;
        return done || Promise.resolve();
    }
    async takeover() {
        await this.host.reload?.();
        await this.acquireLease();
    }
    abort() {const job=this.job;if(job){job.controller.abort();this.job=null;this.changed();}}
    async configure(input) {
        const roleId=input.id;
        if(this.job?.characterId===roleId) this.abort();
        await this.store.enqueue((document,state)=>{
            const previousEvent=activeEvent(state);
            if(previousEvent?.characterId===roleId && input.mode!=='coop') {
                appendOperation(document,state,{id:uuid(),kind:'pause',characterId:roleId,
                    data:{eventId:previousEvent.id},refs:[],mode:'coop'},this.store.sources());
            }
            configureRoster(document,state,input);
            const nextState=project(document,this.store.sources());
            const p=nextState.profiles[roleId];
            if(p.mode==='coop' && !p.lock && p.rank<RANK_COUNT && p.affinity>=p.thresholds[p.rank]) {
                appendOperation(document,nextState,{id:uuid(),kind:'activate',characterId:roleId,
                    data:{thresholds:clone(p.thresholds)},refs:[],mode:'coop'},this.store.sources());
            }
        });
    }
    async configureSettings(settings) {
        return this.store.enqueue(document=>{
            if(settings.autoStart!==undefined) document.settings.autoStart=!!settings.autoStart;
            if(settings.eventRounds!==undefined) {
                if(![2,3].includes(settings.eventRounds)) fail('INVALID_NUMBER');
                document.settings.eventRounds=settings.eventRounds;
            }
        });
    }
    async generate(characterId,{replanEventId=null}={}) {
        if(this.job || this.event()) fail('SCENE_BUSY','请先暂停当前事件或等待生成完成');
        if(this.store.pending) fail('SAVE_PENDING','请先完成尚未确认的保存');
        const p=profileOf(this.state(),characterId);
        if(p.mode!=='coop' || !p.lock) fail('NOT_READY','该角色尚未解锁下一阶事件');
        if(this.store.readonly) fail('READ_ONLY');
        continuity(p);
        const existing=replanEventId?p.events[replanEventId]:null;
        if(replanEventId && (!existing || !existing.paused)) fail('NOT_PAUSED');
        const scope=this.store.scope, policy=p.policyRevision, gate=p.lock.id;
        const history=hash(continuity(p)), controller=new AbortController();
        ensureMessageIds(this.host.messages());
        const contextRefs=[...this.store.sources().values()].slice(-24).map(ref);
        const contextKey=JSON.stringify(contextRefs);
        const job={id:uuid(),characterId,controller,scope};this.job=job;this.changed();
        try {
            let context=await this.host.contextText(p);
            context+='\n【本事件指定轮数】'+this.store.document.settings.eventRounds+'；2轮把切入与困境合并，3轮分别演绎。';
            context+='\n【共享世界事实；角色只可使用其已知信息】\n'+JSON.stringify(this.state().sharedFacts);
            if(existing) context+='\n【只重设未演部分，不改已发生事实】\n'+JSON.stringify({phase:existing.phase,
                progress:existing.progress,question:existing.plan.question,answer:existing.answerSource?.body});
            if(controller.signal.aborted) fail('CANCELLED');
            const messages=designMessages(p,context);
            const raw=await this.host.ask(messages,controller.signal,()=>this.changed());
            if(controller.signal.aborted || this.job!==job || this.store.scope!==scope) fail('STALE_TASK');
            ensureMessageIds(this.host.messages());
            const fresh=profileOf(this.state(),characterId);
            if(fresh.mode!=='coop' || fresh.policyRevision!==policy || fresh.lock?.id!==gate || hash(continuity(fresh))!==history) fail('STALE_TASK');
            if(JSON.stringify([...this.store.sources().values()].slice(-24).map(ref))!==contextKey) fail('STALE_TASK','生成期间场景发生变化，请重试设计');
            const parsed=modelJson(raw);
            const map=this.store.sources(), last=[...map.values()].filter(s=>!s.isSystem).at(-1);
            const refs=last?references(last):[];
            await this.store.operation(existing?'replan':'plan',characterId,
                {eventId:existing?.id || 'event-'+uuid(),gateId:gate,plan:parsed,historySignature:historySignature(fresh)},refs);
        } catch(error) {
            if(error instanceof SyntaxError) error=Object.assign(new Error('事件设计返回格式不完整，请重试'),{code:'INVALID_PLAN'});
            if(!['CANCELLED','STALE_TASK'].includes(error.code)) this.notice(error);throw error;
        }
        finally {if(this.job===job){this.job=null;this.changed();}}
    }
    async pause(characterId,eventId) {
        this.abort();return this.store.operation('pause',characterId,{eventId});
    }
    async resume(characterId,eventId) {
        return this.store.operation('resume',characterId,{eventId});
    }
    async route(route) {
        const e=this.event();
        if(!e?.answerSource) fail('WAITING_USER');
        return this.store.operation('route',e.characterId,{eventId:e.id,route},[ref(e.answerSource)]);
    }
    async editSummary(characterId,eventId,summary) {
        const p=profileOf(this.state(),characterId), h=p.history.find(item=>item.eventId===eventId);
        summary=text(summary,1200);
        if(!h || p.mode!=='coop' || summary.length<20) fail('INVALID_SUMMARY','摘要至少需要20字，且必须属于已管理的有效历阶记录');
        this.abort();
        return this.store.enqueue((document,state)=>{
            const event=activeEvent(state);
            if(event?.characterId===characterId) appendOperation(document,state,{id:uuid(),kind:'pause',characterId,
                data:{eventId:event.id},refs:[],mode:'coop'},this.store.sources());
            document.summaryEdits=document.summaryEdits || {};
            document.summaryEdits[eventId]={summary,version:h.summaryVersion+1,sourceVersion:h.source.version,reviewedAt:Date.now()};
        });
    }
    async recoverArchive() {
        const event=this.event();
        if(this.store.pending) fail('SAVE_PENDING','请先完成尚未确认的保存');
        if(!event || event.phase!=='resolution' || this.job) fail('NOT_READY','只在已有真实收束正文但归档回报不完整时使用');
        const p=profileOf(this.state(),event.characterId);
        const source=[...this.store.sources().values()].filter(s=>!s.isUser && !s.isSystem && s.userId===event.answerSource?.id &&
            s.index>event.answerSource.index && this.host.messages()[s.index]?.extra?.sdCoopSnapshot?.event?.id===event.id &&
            this.host.messages()[s.index]?.extra?.sdCoopSnapshot?.event?.phase==='resolution' &&
            this.host.messages()[s.index]?.extra?.sdCoopSnapshot?.event?.version===event.version).at(-1);
        if(!source) fail('INVALID_SOURCE','尚无用户回应后的收束正文，请继续当前事件');
        const version=event.version,scope=this.store.scope,controller=new AbortController();
        const job={id:uuid(),characterId:p.id,controller,scope,label:'补齐事件归档'};this.job=job;this.changed();
        try {
            const messages=[{role:'system',content:[
                '仅为已经发生的 Coop 事件核对并补齐归档，不继续创作剧情，不代写用户行动。',
                '若现有正文未实际达到本阶局部目标，输出 {"ready":false,"reason":"缺什么"}。',
                '若已完成，输出 {"ready":true,"evidence":"收束正文准确短句","completion":{summary,outcome,outcomeEvidence,choice,choiceEvidence,traits:[],facts:[],boundaries:[],openHooks:[],closedHooks:[],conflicts:[]}}。',
                '所有依据必须逐字引用提供的原文。摘要约100～200字，区分事实、猜测和未解决事项。只输出JSON。'
            ].join('\n')},{role:'user',content:JSON.stringify({targetRank:event.targetRank,goal:event.plan.goal,
                route:event.route,question:event.plan.question,userResponse:event.answerSource.body,
                routeResponse:event.routeSource?.body,currentReply:source.body,
                earlierActs:event.progress.map(v=>({phase:v.phase,evidence:v.evidence})),history:continuity(p)})}];
            const raw=await this.host.ask(messages,controller.signal);
            if(controller.signal.aborted || this.job!==job || this.store.scope!==scope ||
                this.event()?.version!==version || this.store.sources().get(source.id)?.version!==source.version) fail('STALE_TASK');
            const result=modelJson(raw);
            if(result.ready!==true) fail('NOT_COMPLETE',text(result.reason,400) || '当前正文尚未达到收束条件');
            await this.store.operation('beat',p.id,{eventId:event.id,characterId:p.id,eventVersion:version,
                phase:'resolution',source,evidence:result.evidence,completion:result.completion},references(source),
                'archive:'+event.id+':'+source.id+':'+source.version);
        } catch(error) {if(!['CANCELLED','STALE_TASK'].includes(error.code)) this.notice(error);throw error;}
        finally {if(this.job===job){this.job=null;this.changed();}}
    }
    async prepare() {
        if(!this.store.document || this.store.scope!==this.host.scope() || this.store.readonly) return;
        ensureMessageIds(this.host.messages());
        this.store.reconcile();
        const sources=this.store.sources(), user=[...sources.values()].filter(s=>s.isUser).at(-1);
        if(!user) {this.snapshot=null;this.changed();return;}
        const e=this.event();
        if(e && ['waiting_user','waiting_route','resolution'].includes(e.phase) &&
            user.index>e.questionSource.index && (e.answerSource?.id!==user.id || e.answerSource?.version!==user.version)) {
            await this.store.operation('answer',e.characterId,{eventId:e.id,source:user},[ref(user),ref(e.questionSource)]);
        }
        const roster=Object.values(this.state().profiles);
        const profiles=roster.filter(p=>p.mode!=='off' && (this.host.available(p,roster) || p.id===this.event()?.characterId));
        const snapshot={nonce:'turn-'+uuid(),scope:this.store.scope,userId:user.id,userVersion:user.version,
            byExtra:extraModel(this.host.context()),roles:{},event:null};
        profiles.forEach(p=>{snapshot.roles[p.id]={policyRevision:p.policyRevision,locked:!!p.lock,thresholds:clone(p.thresholds)};});
        const current=this.event();
        if(current) snapshot.event={id:current.id,characterId:current.characterId,version:current.version,phase:current.phase};
        this.snapshot=snapshot;this.snapshots.set(snapshot.nonce,snapshot);
        while(this.snapshots.size>80) this.snapshots.delete(this.snapshots.keys().next().value);
        this.changed();
    }
    injection() {
        if(!this.state()) return '';
        const event=this.event(), parts=[];
        const user=[...this.store.sources().values()].filter(s=>s.isUser).at(-1);
        const held=event && event.playedUsers.includes(user?.id) && !['waiting_user','waiting_route'].includes(event.phase);
        if(event) parts.push(held?'【Coop 等待新的用户互动】本次用户互动已推进过一幕，只接住当前余温，不演下一幕，不代替用户回应。':
            renderScene(this.state().profiles[event.characterId],event));
        const roster=Object.values(this.state().profiles);
        const profiles=roster.filter(p=>p.mode!=='off' && (this.host.available(p,roster) || p.id===event?.characterId));
        const memories=profiles.map(publicMemory).filter(Boolean);
        if(memories.length) parts.push('【Coop 已确认记忆；仅在场景相关时自然体现】\n'+memories.join('\n'));
        if(!this.store.readonly && this.snapshot?.scope===this.store.scope) {
            const selected=profiles.filter(p=>this.snapshot.roles[p.id]);
            const validEvent=!held && event?.id===this.snapshot.event?.id && event?.version===this.snapshot.event?.version?event:null;
            parts.push(reportContract(selected,validEvent,this.snapshot,this.snapshot.byExtra));
        }
        return parts.filter(Boolean).join('\n\n');
    }
    async receive(messageIndex,external=null) {
        if(!this.store.document || this.store.readonly || this.store.scope!==this.host.scope()) return;
        ensureMessageIds(this.host.messages());
        const message=this.host.messages()[messageIndex];
        if(!message || message.is_user || message.is_system) return;
        const source=sourceForId(this.host.messages(),messageIndex);
        if(!source?.userId) return;
        const reports=external?[external]:parseReports(message.mes);
        const saved=message.extra?.sdCoopReports;
        const parsed=reports.length?reports:(saved?.version===source.version?saved.reports:[]);
        if(!external && reports.length) {
            message.extra=message.extra || {};
            message.extra.sdCoopReports={version:source.version,reports};
            message.mes=stripReport(message.mes);
            this.host.renderMessage?.(messageIndex);
        }
        for(const report of parsed) {
            const snapshot=this.snapshots.get(report.nonce) || message.extra?.sdCoopSnapshot;
            if(!snapshot || snapshot.nonce!==report.nonce || snapshot.scope!==this.store.scope ||
                snapshot.userId!==source.userId || snapshot.userVersion!==source.userVersion) continue;
            if(!!external!==snapshot.byExtra) continue;
            message.extra=message.extra || {};message.extra.sdCoopSnapshot=clone(snapshot);
            snapshot.messageId=source.id;snapshot.messageVersion=source.version;
            for(const proposal of (Array.isArray(report.affinity)?report.affinity:[]).slice(0,20)) {
                try {
                    const p=this.state().profiles[proposal.characterId];
                    const data=validateAffinityProposal(proposal,p,source,snapshot.roles[proposal.characterId]);
                    if(p.scoreLog.some(log=>log.interactionId!==source.userId && (log.source.userIndex ?? -1)>source.userIndex)) {
                        fail('STALE_SOURCE','更晚的互动已经结算，这份过期计分未采用');
                    }
                    await this.store.operation('affinity',p.id,data,references(source),'score:'+p.id+':'+source.userId+':'+source.id+':'+source.version);
                } catch(error) {this.notice(error);}
            }
            if(report.event && snapshot.event) {
                try {
                    const r=report.event, p=this.state().profiles[r.characterId], expected=snapshot.event;
                    if(!p || p.mode!=='coop' || snapshot.roles[p.id]?.policyRevision!==p.policyRevision) fail('NOT_MANAGED');
                    if(r.eventId!==expected.id || r.characterId!==expected.characterId || r.eventVersion!==expected.version || r.phase!==expected.phase) fail('STALE_EVENT');
                    await this.store.operation('beat',p.id,{...r,source},references(source),
                        'beat:'+r.eventId+':'+r.phase+':'+source.id+':'+source.version);
                } catch(error) {this.notice(error);}
            }
        }
        this.store.reconcile();
    }
    async receiveMvu(variables) {
        const report=readMvuReport(variables);
        if(!report) return;
        const snapshot=this.snapshots.get(report.nonce);
        const index=this.host.messages().findIndex(m=>(snapshot?.messageId && m.sd_coop_id===snapshot.messageId) ||
            m.extra?.sdCoopSnapshot?.nonce===report.nonce);
        if(index<0) {this.pendingMvuReports.set(report.nonce,clone(report));return;}
        if(index>=0) await this.receive(index,report);
    }
    async afterMessage(index) {
        let assigned=null;
        if(this.host.messages()[index] && !this.host.messages()[index].is_user) {
            ensureMessageIds(this.host.messages());
            const source=sourceForId(this.host.messages(),index);
            const nonce=parseReports(this.host.messages()[index].mes)[0]?.nonce;
            assigned=(nonce && this.snapshots.get(nonce)) ||
                [...this.snapshots.values()].findLast(s=>s.userId===source?.userId && (!s.messageId || s.messageId===source.id));
            if(assigned && source?.userId===assigned.userId) {
                const message=this.host.messages()[index];
                message.extra=message.extra || {};
                message.extra.sdCoopSnapshot=clone(assigned);
                assigned.messageId=source.id;assigned.messageVersion=source.version;
            }
        }
        await this.receive(index);
        const pending=this.pendingMvuReports.get(assigned?.nonce);
        if(pending) {this.pendingMvuReports.delete(assigned.nonce);await this.receive(index,pending);}
        await this.maybeAuto();
    }
    async maybeAuto() {
        if(!this.store.document?.settings.autoStart || this.store.readonly || this.occupies() || !this.host.autoAllowed?.() ||
            Date.now()-this.lastAutoFailure<60000) return;
        const roster=Object.values(this.state().profiles);
        const profiles=roster.filter(p=>p.mode==='coop' && p.lock && this.host.available(p,roster) &&
            !Object.values(p.events).some(e=>e.phase!=='completed')).sort((a,b)=>(a.scoreLog.at(-1)?.source.index ?? 0)-(b.scoreLog.at(-1)?.source.index ?? 0));
        if(profiles[0]) try {await this.generate(profiles[0].id);} catch {this.lastAutoFailure=Date.now();}
    }
    async restore(document) {
        if(document?.scope!==this.store.scope) fail('STALE_SCOPE','只允许恢复当前聊天的档案');
        const restored=readDocument(document,this.store.scope);
        project(restored,this.store.sources());
        this.abort();
        return this.store.enqueue(next=>Object.assign(next,restored));
    }
    export() {return JSON.stringify(this.store.document,null,2);}
    dispose() {this.abort();this.releaseLease();this.channel?.close();this.disposed=true;this.listeners.clear();}
}
