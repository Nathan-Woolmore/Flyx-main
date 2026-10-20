// Fail closed while retaining the complete session/signature/account checks.
/** @param {()=>Promise<any>} authenticate @param {{timeoutMS?:number,signal?:AbortSignal}} options */
export async function sessionWithinBudget(authenticate,{timeoutMS=1000,signal}={}) {
 if(signal?.aborted)throw signal.reason??new DOMException('Request cancelled','AbortError');
 let timer,abort;
 const guard=new Promise((_,reject)=>{
  timer=setTimeout(()=>reject(Object.assign(new Error('Mac session verification timed out'),{code:'PHONE_AUTH_TIMEOUT'})),timeoutMS);
  abort=()=>reject(signal.reason??new DOMException('Request cancelled','AbortError'));
  if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});
 });
 try {return await Promise.race([Promise.resolve().then(authenticate),guard]);}
 finally {clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}
