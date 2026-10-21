import {randomUUID} from 'node:crypto';
const fail=code=>Object.assign(new Error(code),{code});
const selectionFrom=source=>{if(source.selection)return source.selection;try{const[kind,id,season,episode]=JSON.parse(source.identity);return{kind,contentID:Number(id),season:Number(season),episode:Number(episode)};}catch{throw fail('PROGRESS_INVALID');}};
export function createRemoteProgress(request,phoneMedia,{now=Date.now,makeID=randomUUID}={}){
 const sessions=new Map();let tvSession,timer,recording=false;
 const begin=async(source,owner,handle)=>{const result=await request({operation:'begin',selection:selectionFrom(source),title:source.title,startedAt:source.startedAt,explicitStartOver:source.explicitStartOver});const id=makeID();sessions.set(id,{owner,handle,identity:source.identity,rendererID:result.sessionID,sequence:0,expires:now()+1800000});return{sessionID:id};};
 const update=async(session,body)=>{if(!Number.isSafeInteger(body.sequence)||body.sequence<=session.sequence||!Number.isFinite(body.position)||body.position<0||body.position>86400||!Number.isFinite(body.duration)||body.duration<0||body.duration>86400||typeof body.ended!=='boolean')throw fail('PROGRESS_INVALID');const result=await request({operation:'update',sessionID:session.rendererID,sequence:body.sequence,position:body.position,duration:body.duration,ended:body.ended});session.sequence=body.sequence;session.expires=now()+1800000;return result;};
 const api={
  async handle(body,owner){
   for(const[id,s]of sessions)if(s.expires<=now())sessions.delete(id);
   if(body.operation==='read')return request({operation:'read',selection:body.selection});
   if(body.operation==='begin'){if(sessions.size>=128)throw fail('PROGRESS_BUSY');const source=phoneMedia.inspectForTransfer(owner,body.handle);return begin(source,owner,body.handle);}
   if(body.operation!=='update'||Object.keys(body).some(k=>!['operation','sessionID','sequence','position','duration','ended'].includes(k)))throw fail('PROGRESS_INVALID');
   const session=sessions.get(body.sessionID);if(!session||session.owner!==owner||session.expires<=now())throw fail('PROGRESS_EXPIRED');const source=phoneMedia.inspectForTransfer(owner,session.handle);if(source.identity!==session.identity)throw fail('PROGRESS_EXPIRED');return update(session,body);
  },
  async recordSnapshot(source){
   if(source?.output!=='tv'||!Number.isFinite(source.position))return;
   if(tvSession?.stamp!==source.stamp){const value=await begin(source,'native-tv',source.stamp);tvSession={stamp:source.stamp,id:value.sessionID,position:source.position,at:now(),continuous:0};}
   const session=sessions.get(tvSession.id);if(!session){tvSession=undefined;return;}
   const delta=source.position-tvSession.position,elapsed=(now()-tvSession.at)/1000;if(delta<0||delta>elapsed+2)tvSession.continuous=0;else if(!source.paused)tvSession.continuous+=delta;tvSession.position=source.position;tvSession.at=now();return update(session,{sequence:session.sequence+1,position:source.position,duration:source.duration??0,ended:source.ended===true&&tvSession.continuous>=Math.min(5,source.duration??5)});
  },
  start(snapshot){if(timer)return;timer=setInterval(async()=>{if(recording)return;recording=true;try{await api.recordSnapshot(await snapshot());}catch{}finally{recording=false}},5000);timer.unref?.();},
  stop(){clearInterval(timer);timer=undefined;tvSession=undefined;sessions.clear();}
 };return api;
}
