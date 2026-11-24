import {clone,fail,eventGate} from './model.js';
import {newDocument,readDocument,project,appendOperation,deletedEventIds,pruneEventIds} from './timeline.js';
import {sourceMap,uuid,matchesSourceVersion} from './messages.js';
export const STORAGE_KEY='storyDirectorCoop';

export class CoopStore {
    constructor(host) {
        this.host=host;this.document=null;this.state=null;this.scope='';this.queue=Promise.resolve();
        this.error=null;this.pending=null;this.readonly=false;this.onChange=()=>{};this.excluded=new Map();this.generation=0;
        this.eventPruneTask=null;this.eventPruneBatch=null;
        this.confirmationMigration=false;
    }
    load() {
        this.generation++;
        this.eventPruneTask=null;this.eventPruneBatch=null;
        const scope=this.host.scope();
        this.scope=scope;this.excluded.clear();this.pending=null;this.error=null;this.confirmationMigration=false;
        if(!scope) {this.scope='';this.document=null;this.state=null;return;}
        this.document=readDocument(this.host.metadata()?.[STORAGE_KEY],scope);
        if(this.host.affinityAuthority==='mvu') this.document.settings.affinityAuthority='mvu';
        this.reconcile();
    }
    sources(options) {
        const map=sourceMap(this.host.messages(),options);
        for(const [key,version] of this.excluded) if(matchesSourceVersion(map.get(key),version)) map.delete(key);
        return map;
    }
    project(document=this.document) {
        if(document.journal.some(op=>op.confirmed===undefined)) {
            // 首次升级固定旧档当前有效分支，保留已废弃记录供诊断，不复活早先被替换的计划。
            const applied=new Set(project(document,this.sources({legacyStatus:true})).applied);
            for(const op of document.journal) if(op.confirmed===undefined) op.confirmed=applied.has(op.id);
            this.confirmationMigration=true;
        }
        const state=project(document,this.sources());
        return this.host.projectState?.(state) || state;
    }
    reconcile() {
        if(this.document) this.state=this.project();
        this.onChange();
        return this.state;
    }
    enqueue(change,{retry=false}={}) {
        const scope=this.scope,generation=this.generation;
        const current=()=>scope===this.host.scope() && scope===this.scope && generation===this.generation;
        const run=async()=>{
            if(!scope || !current()) fail('STALE_SCOPE');
            if(this.readonly) fail('READ_ONLY','其他窗口正在维护此聊天；请在当前写入窗口操作');
            if(this.pending && this.error && !retry) fail('SAVE_PENDING','请先重试保存尚未确认的进度');
            const next=clone(this.document || newDocument(scope));
            const before=this.project(next);
            const result=await change(next,before);
            if(!current()) fail('STALE_SCOPE');
            next.revision=(this.document?.revision || 0)+1;next.updatedAt=new Date().toISOString();
            this.project(next);
            this.pending=next;this.error=null;this.onChange();
            try {
                await this.host.persist(next,scope);
                if(!current()) return result;
                const state=this.project(next);
                const retained=new Set(next.journal.filter(op=>op.kind==='plan').map(op=>op.data.eventId));
                const removed=new Set((this.document?.journal || []).filter(op=>op.kind==='plan' && !retained.has(op.data.eventId)).map(op=>op.data.eventId));
                this.document=next;this.state=state;this.pending=null;this.error=null;
                if(removed.size) {
                    if(this.eventPruneBatch?.generation===generation) for(const id of removed) this.eventPruneBatch.ids.delete(id);
                    // Cached reports are disposable, but only after the authoritative save succeeds.
                    try {this.host.pruneEventCaches?.(removed);} catch(error) {console.warn('[Coop] Event cache cleanup failed',error);}
                }
                this.host.broadcast?.(next);this.onChange();return result;
            } catch(error) {
                if(current()) {this.error=error;this.onChange();}
                throw error;
            }
        };
        const task=this.queue.then(run);
        this.queue=task.catch(()=>{});
        return task;
    }
    operation(kind,characterId,data,refs=[],operationId=null) {
        return this.enqueue((document,state)=>{
            const op={id:operationId || uuid(),kind,characterId,data:clone(data),refs:clone(refs),
                mode:state.profiles[characterId]?.mode || 'coop',at:Date.now()};
            if(this.host.affinityAuthority==='mvu') {
                op.mvuAuthority=true;
                if(kind==='plan') {
                    const gate=eventGate(state.profiles[characterId],true);
                    if(!gate) fail('NOT_READY','等待 MVU 好感达到下一阶门槛');
                    op.data.mvuGate=clone(gate);op.data.mvuAffinity=state.profiles[characterId].affinity;
                }
            }
            return appendOperation(document,state,op,this.sources());
        });
    }
    pruneEvents() {
        if(!this.document || this.readonly || this.scope!==this.host.scope()) return Promise.resolve([]);
        const captured=deletedEventIds(this.document,sourceMap(this.host.messages()));
        if(!captured.size) return this.eventPruneTask || Promise.resolve([]);
        const batch=this.eventPruneBatch || (this.eventPruneBatch={scope:this.scope,generation:this.generation,ids:new Set(),task:null});
        for(const id of captured) batch.ids.add(id);
        return this.flushEventPrunes(batch);
    }
    flushEventPrunes(batch=this.eventPruneBatch) {
        if(batch?.task) return batch.task;
        const current=()=>batch && this.eventPruneBatch===batch && batch.scope===this.scope && batch.scope===this.host.scope() && batch.generation===this.generation;
        if(!current() || !batch.ids.size || this.readonly || this.pending && this.error) return Promise.resolve([]);
        let failed=false;
        const task=(async()=>{
            const removed=[];
            while(current() && batch.ids.size && !this.readonly && !(this.pending && this.error)) {
                const captured=new Set(batch.ids);
                try {
                    const pruned=await this.enqueue(document=>pruneEventIds(document,captured));
                    if(!current()) break;
                    for(const id of captured) batch.ids.delete(id);
                    removed.push(...pruned);
                } catch {failed=true;break;}
            }
            return removed;
        })().finally(()=>{
            if(batch.task===task) batch.task=null;
            if(this.eventPruneTask===task) this.eventPruneTask=null;
            // Only drain another explicitly captured request; never rescan a transient chat here.
            if(!failed && current() && batch.ids.size && !this.readonly && !this.pending && !this.error) return this.flushEventPrunes(batch);
        });
        batch.task=task;this.eventPruneTask=task;
        return task;
    }
    retrySave() {
        if(!this.pending) return Promise.resolve();
        const expected=this.pending,scope=this.scope,generation=this.generation;
        return this.enqueue(document=>{
            if(expected.scope!==this.scope) fail('STALE_SCOPE');
            Object.assign(document,clone(expected));
        },{retry:true}).then(()=>this.scope===scope && this.generation===generation?this.flushEventPrunes():[]);
    }
}
