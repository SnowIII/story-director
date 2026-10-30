/** Reload updated code once the host is idle; keep drafts and pending saves in place. */
export function createUpdateReloader({version,readVersion,isBusy,flush,reload,notify=()=>{},onError=()=>{},
    storage,setTimer=setTimeout,clearTimer=clearTimeout}) {
    let observed=null,pending=false,stopped=false,timer=null,task=null,retryDelay=0;
    const key='story-director-auto-reload-version';
    let lastReload=null;
    try {lastReload=storage?.getItem(key);} catch {/* Storage can be unavailable. */}
    const remember=value=>{
        lastReload=value;
        try {if(value) storage?.setItem(key,value);else storage?.removeItem(key);} catch {/* Reload still works without storage. */}
    };
    const schedule=delay=>{
        if(timer!==null) clearTimer(timer);
        if(!stopped) timer=setTimer(()=>{void check();},delay);
    };
    function request() {
        if(stopped || pending) return;
        pending=true;
        notify();
        schedule(1000);
    }
    function dispose() {stopped=true;if(timer!==null) clearTimer(timer);}
    function check() {
        if(stopped) return Promise.resolve(false);
        if(task) return task;
        retryDelay=0;
        task=(async()=>{
            const latest=await readVersion();
            if(typeof latest!=='string' || !latest.trim()) throw new Error('无法读取故事导演版本');
            if(latest!==version) {
                if(lastReload===latest && !pending) {observed=null;return false;}
                if(observed===latest) request();
                observed=latest;
            } else {observed=null;remember(null);}
            if(!pending || isBusy()) return false;
            await flush();
            if(stopped || isBusy()) return false;
            remember(latest);
            dispose();
            reload();
            return true;
        })().catch(error=>{retryDelay=10000;onError(error);return false;}).finally(()=>{
            task=null;
            if(!stopped) schedule(retryDelay || (pending || observed?1000:30000));
        });
        return task;
    }
    schedule(30000);
    return {request,check,dispose};
}
