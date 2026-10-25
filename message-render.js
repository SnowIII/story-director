/** Refresh cleaned replies through the host's display lifecycle, without replaying a model reply. */
export function createMessageRefreshQueue({getMessages,getScope,render,notify,onError=()=>{}}) {
    const pending=new Map();
    let scheduled=false,flushing=false;
    const report=error=>{try{onError(error);}catch{/* A diagnostic must not stop later refreshes. */}};
    const schedule=()=>{
        if(scheduled || flushing) return;
        scheduled=true;
        queueMicrotask(()=>{void flush();});
    };
    async function flush() {
        scheduled=false;flushing=true;
        try {
            while(pending.size) {
                const [index,job]=pending.entries().next().value;
                pending.delete(index);
                if(getScope()!==job.scope || getMessages()?.[index]!==job.message) continue;
                try {
                    render(index,job.message);
                    await notify(index);
                } catch(error) {report(error);}
            }
        } catch(error) {report(error);}
        finally {flushing=false;if(pending.size) schedule();}
    }
    return index=>{
        if(!Number.isInteger(index) || index<0) return false;
        const message=getMessages()?.[index];
        if(!message || message.is_user || message.is_system || typeof message.mes!=='string') return false;
        pending.set(index,{message,scope:getScope()});
        schedule();
        return true;
    };
}
