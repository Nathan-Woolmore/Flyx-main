// Node's filesystem and asynchronous crypto share the libuv worker pool.
// One blocked drive must not occupy every worker during a library refresh.
export function createFileAccessBudget({timeoutMS=1000,maxQueued=16}={}) {
 let active=false;const queue=[];
 const drain=()=>{
  if(active)return;
  const next=queue.shift();if(next)start(next);
 };
 const start=entry=>{
  if(entry.expired||Date.now()>=entry.deadline){clearTimeout(entry.timer);entry.resolve(null);drain();return;}
  active=true;
  Promise.resolve().then(entry.work).then(async value=>{
   if(entry.expired){if(value!=null)await entry.dispose(value);}
   else {clearTimeout(entry.timer);entry.resolve(value);}
  },()=>{clearTimeout(entry.timer);entry.resolve(null);}).catch(()=>{}).finally(()=>{
   // A caller timeout does NOT cancel an OS open. Hold its slot until the
   // real work and any late handle cleanup finish; never launch replacements.
   active=false;drain();
  });
 };
 /** @param {()=>Promise<any>} work @param {(value:any)=>Promise<unknown>} dispose @returns {Promise<any>} */
 return (work,dispose=async()=>{})=>new Promise(resolve=>{
  if(active&&queue.length>=maxQueued){resolve(null);return;}
  const entry={work,dispose,resolve,expired:false,deadline:Date.now()+timeoutMS,timer:undefined};
  entry.timer=setTimeout(()=>{
   entry.expired=true;const index=queue.indexOf(entry);if(index>=0)queue.splice(index,1);resolve(null);
  },timeoutMS);
  if(active)queue.push(entry);else start(entry);
 });
}
