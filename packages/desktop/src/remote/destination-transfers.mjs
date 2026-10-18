import {publicSourceInfo} from './source-info.mjs';
import {randomUUID} from 'node:crypto';

const failure=code=>Object.assign(new Error(code),{code});
const validSnapshot=s=>s&&typeof s.identity==='string'&&s.identity.length>0&&s.identity.length<=512&&typeof s.stamp==='string'&&s.stamp.length>0&&s.stamp.length<=512&&Number.isFinite(s.position)&&s.position>=0&&s.position<=86400&&typeof s.paused==='boolean';
const same=(a,b)=>a.identity===b.identity&&a.stamp===b.stamp;
const publicStatus=s=>({identity:s.identity,position:s.position,paused:s.paused,output:s.output});

/**
 * Owner-bound prepare/commit/cancel state machine. Adapters must guard every
 * mutation with the supplied origin stamp / destination ticket. No URL, cookie
 * or credential is returned by this module. A prepared destination is paused.
 */
export function createDestinationTransfers(adapter,{now=Date.now,makeID=randomUUID,ttlMS=30000,schedule=(fn,ms)=>{const timer=setTimeout(fn,ms);timer.unref?.();return()=>clearTimeout(timer);}}={}) {
 const records=new Map();let disposed=false;
 const check=record=>{if(disposed||record.cancelled||record.expires<=now())throw failure('TRANSFER_CANCELLED');};
 const cleanup=async record=>{if(record.cleaned)return;try{await adapter.cleanupDestination({id:record.id,destination:record.destination,stage:record.stage});record.cleaned=true;}catch{record.rollbackUnconfirmed=true;}};
 const restore=async record=>{if(!record.stopAttempted||record.restored)return;try{await adapter.restoreOrigin({id:record.id,origin:record.origin,stop:record.stop});record.restored=true;}catch{record.rollbackUnconfirmed=true;}};
 const rollback=async record=>{await restore(record);await cleanup(record);};
 const cancel=async record=>{
  if(record.phase==='committed')return{phase:'committed',alreadyCommitted:true,status:record.result.status};
  record.cancelled=true;record.abort.abort();record.cancelTimer?.();
  // In-flight prepare/commit owns its cleanup; this avoids cleaning an adapter
  // before it has recorded its target. Its late reply cannot commit.
  if(!record.running)await rollback(record);
  record.phase='cancelled';return{phase:'cancelled',rollbackConfirmed:!record.running&&!record.rollbackUnconfirmed};
 };
 const get=(id,owner)=>{const record=records.get(id);if(!record||record.owner!==owner)throw failure('TRANSFER_EXPIRED');return record;};
 const prune=()=>{for(const[id,r]of records){if(r.expires<=now()&&!r.running){if(r.phase!=='committed')void cancel(r);records.delete(id);}}};
 async function prepare(body,owner){
  prune();if(disposed||records.size>=32||[...records.values()].filter(r=>r.owner===owner&&!['committed','cancelled','failed'].includes(r.phase)).length>=2)throw failure('TRANSFER_BUSY');
  if(!['mac','phone','tv'].includes(body.origin)||!['mac','phone','tv'].includes(body.destination)||body.origin===body.destination||typeof owner!=='string'||!owner)throw failure('TRANSFER_INVALID');
  if(body.destination==='tv'&&(typeof body.receiverID!=='string'||!/^[a-zA-Z0-9._-]{1,128}$/.test(body.receiverID)))throw failure('TRANSFER_INVALID');
  if(Object.keys(body).some(k=>!['operation','id','origin','destination','receiverID','phoneHandle','position','paused'].includes(k)))throw failure('TRANSFER_INVALID');
  if(body.id!==undefined&&(typeof body.id!=='string'||!/^[a-zA-Z0-9-]{8,80}$/.test(body.id)))throw failure('TRANSFER_INVALID');
  const id=body.id??makeID();if(records.has(id))throw failure('TRANSFER_BUSY');
  const record={id,owner,origin:null,destination:body.destination,phase:'preparing',expires:now()+ttlMS,abort:new AbortController(),running:true,cancelled:false,stopAttempted:false};records.set(id,record);
  record.cancelTimer=schedule(()=>void cancel(record),ttlMS);
  try{
   const origin=await adapter.snapshotOrigin({...body,owner});check(record);if(!validSnapshot(origin))throw failure('TRANSFER_UNSUPPORTED');record.origin=origin;
   record.stage=await adapter.prepareDestination({id,owner,origin,destination:body.destination,receiverID:body.receiverID,signal:record.abort.signal});check(record);
   const current=await adapter.snapshotOrigin({...body,owner});check(record);if(!validSnapshot(current)||!same(origin,current))throw failure('TRANSFER_ORIGIN_CHANGED');
   if(!await adapter.destinationIsCurrent({id,destination:record.destination,stage:record.stage}))throw failure('TRANSFER_DESTINATION_CHANGED');check(record);
   if(record.stage?.publicData&&Object.keys(record.stage.publicData).some(k=>!['handle','format','position','duration','paused','sourceInfo'].includes(k)))throw failure('TRANSFER_INVALID');
   if(record.stage?.publicData?.handle&&!/^[a-zA-Z0-9-]{8,80}$/.test(record.stage.publicData.handle))throw failure('TRANSFER_INVALID');
   if(record.stage?.publicData)record.stage.publicData={...record.stage.publicData,sourceInfo:publicSourceInfo(record.stage.publicData.sourceInfo)};
   record.phase='prepared';return{id,phase:'prepared',origin:body.origin,destination:body.destination,status:publicStatus(current),...(record.stage?.publicData?{destinationData:record.stage.publicData}:{})};
  }catch(error){record.phase=record.cancelled?'cancelled':'failed';record.cancelTimer?.();await rollback(record);if(record.rollbackUnconfirmed)throw failure('TRANSFER_ROLLBACK_UNCONFIRMED');throw error;}finally{record.running=false;}
 }
 async function commit(body,owner){
  if(Object.keys(body).some(k=>!['operation','id','position','paused','nativeReady'].includes(k)))throw failure('TRANSFER_INVALID');
  const record=get(body.id,owner);if(record.phase==='committed'||record.phase==='awaiting-native-confirm'||record.phase==='awaiting-origin-confirm')return record.result;
  if(record.running||record.phase!=='prepared')throw failure('TRANSFER_NOT_READY');check(record);record.running=true;record.phase='committing';
  try{
   const current=await adapter.refreshOrigin({id:record.id,owner,origin:record.origin,position:body.position,paused:body.paused});check(record);
   if(!validSnapshot(current)||!same(current,record.origin))throw failure('TRANSFER_ORIGIN_CHANGED');
   if(!await adapter.destinationIsCurrent({id:record.id,destination:record.destination,stage:record.stage}))throw failure('TRANSFER_DESTINATION_CHANGED');check(record);
   const acknowledged=await adapter.activateDestination({id:record.id,destination:record.destination,stage:record.stage,snapshot:current,nativeReady:body.nativeReady,signal:record.abort.signal});check(record);
   if(!validSnapshot(acknowledged)||acknowledged.identity!==current.identity||Math.abs(acknowledged.position-current.position)>1||acknowledged.paused!==current.paused)throw failure('TRANSFER_DESTINATION_UNCONFIRMED');
   // Acknowledgement is necessary but insufficient: re-read origin ownership
   // immediately before its adapter performs the guarded stop.
   const latest=await adapter.refreshOrigin({id:record.id,owner,origin:record.origin,position:body.position,paused:body.paused});check(record);
   if(!validSnapshot(latest)||!same(latest,record.origin))throw failure('TRANSFER_ORIGIN_CHANGED');
   record.stopAttempted=true;record.stop=await adapter.stopOrigin({id:record.id,owner,origin:latest});check(record);
   const final=await adapter.finalizeDestination({id:record.id,destination:record.destination,stage:record.stage,snapshot:record.stop?.snapshot??latest});check(record);
   if(!validSnapshot(final)||final.identity!==latest.identity||Math.abs(final.position-(record.stop?.snapshot??latest).position)>1||final.paused!==latest.paused)throw failure('TRANSFER_DESTINATION_UNCONFIRMED');
   record.phase=record.destination==='phone'&&adapter.confirmPhone?'awaiting-native-confirm':record.origin.output==='phone'?'awaiting-origin-confirm':'committed';if(record.phase==='committed'){record.cancelTimer?.();record.expires=now()+60000;}record.result={id:record.id,phase:record.phase,status:publicStatus(final)};if(record.phase==='committed')await adapter.completeOrigin?.({id:record.id,origin:record.origin}).catch(()=>{});return record.result;
  }catch(error){record.phase=record.cancelled?'cancelled':'failed';record.cancelTimer?.();await rollback(record);if(record.rollbackUnconfirmed)throw failure('TRANSFER_ROLLBACK_UNCONFIRMED');throw error;}finally{record.running=false;}
 }
 return{
  async handle(operation,body,owner){if(operation==='prepare')return prepare(body,owner);const record=get(body.id,owner);if(operation==='confirm'){
   if(record.phase==='committed')return record.result;
   if(record.running||!['awaiting-native-confirm','awaiting-origin-confirm'].includes(record.phase)||body.nativeReady!==true||!Number.isFinite(body.position)||body.position<0||body.position>86400)throw failure('TRANSFER_NOT_READY');
   check(record);record.running=true;
   try{
    if(record.phase==='awaiting-origin-confirm'){
     if(typeof body.paused!=='boolean'||body.paused!==record.result.status.paused)throw failure('TRANSFER_INVALID');
     const current=await adapter.refreshOrigin({id:record.id,owner,origin:record.origin,position:body.position,paused:body.paused});check(record);
     if(!validSnapshot(current)||!same(current,record.origin))throw failure('TRANSFER_ORIGIN_CHANGED');
     if(!await adapter.destinationIsCurrent({id:record.id,destination:record.destination,stage:record.stage}))throw failure('TRANSFER_DESTINATION_CHANGED');check(record);
     const final=await adapter.finalizeDestination({id:record.id,destination:record.destination,stage:record.stage,snapshot:current,signal:record.abort.signal});check(record);
     if(!validSnapshot(final)||final.identity!==current.identity||Math.abs(final.position-current.position)>1||final.paused!==current.paused)throw failure('TRANSFER_DESTINATION_UNCONFIRMED');
     record.result.status=publicStatus(final);
    }else{
     if(Math.abs(body.position-record.result.status.position)>1)throw failure('TRANSFER_NOT_READY');
     await adapter.confirmPhone({id:record.id,owner,stage:record.stage});check(record);
    }
    record.phase='committed';record.result.phase='committed';await adapter.completeOrigin?.({id:record.id,origin:record.origin}).catch(()=>{});record.cancelTimer?.();record.expires=now()+60000;return record.result;
   }catch(error){record.phase=record.cancelled?'cancelled':'failed';record.cancelTimer?.();await rollback(record);if(record.rollbackUnconfirmed)throw failure('TRANSFER_ROLLBACK_UNCONFIRMED');throw error;}finally{record.running=false;}
  }if(operation==='cancel')return cancel(record);if(operation==='status')return{id:record.id,phase:record.running&&record.cancelled?'cancelling':record.phase,rollbackConfirmed:!record.running&&!record.rollbackUnconfirmed,...(record.result?{status:record.result.status}:{})};if(operation==='commit')return commit(body,owner);throw failure('TRANSFER_INVALID');},
  async dispose(){disposed=true;await Promise.all([...records.values()].map(cancel));records.clear();}
 };
}
