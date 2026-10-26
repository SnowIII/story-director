import {clone,fail} from './model.js';
import {newDocument,readDocument,project,appendOperation} from './timeline.js';
import {sourceMap,uuid,matchesSourceVersion} from './messages.js';
export const STORAGE_KEY='storyDirectorCoop';

export class CoopStore {
    constructor(host) {
        this.host=host;this.document=null;this.state=null;this.scope='';this.queue=Promise.resolve();
        this.error=null;this.pending=null;this.readonly=false;this.onChange=()=>{};this.excluded=new Map();this.generation=0;
    }
    load() {
        this.generation++;
        const scope=this.host.scope();
        this.scope=scope;this.excluded.clear();this.pending=null;this.error=null;
        if(!scope) {this.scope='';this.document=null;this.state=null;return;}
        this.document=readDocument(this.host.metadata()?.[STORAGE_KEY],scope);
        this.reconcile();
    }
    sources() {
        const map=sourceMap(this.host.messages());
        for(const [key,version] of this.excluded) if(matchesSourceVersion(map.get(key),version)) map.delete(key);
        return map;
    }
    reconcile() {
        if(this.document) this.state=project(this.document,this.sources());
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
            const before=project(next,this.sources());
            const result=await change(next,before);
            if(!current()) fail('STALE_SCOPE');
            next.revision=(this.document?.revision || 0)+1;next.updatedAt=new Date().toISOString();
            project(next,this.sources());
            this.pending=next;this.error=null;this.onChange();
            try {
                await this.host.persist(next,scope);
                if(!current()) return result;
                const state=project(next,this.sources());
                this.document=next;this.state=state;this.pending=null;this.error=null;
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
            return appendOperation(document,state,op,this.sources());
        });
    }
    retrySave() {
        if(!this.pending) return Promise.resolve();
        const expected=this.pending;
        return this.enqueue(document=>{
            if(expected.scope!==this.scope) fail('STALE_SCOPE');
            Object.assign(document,clone(expected));
        },{retry:true});
    }
}
