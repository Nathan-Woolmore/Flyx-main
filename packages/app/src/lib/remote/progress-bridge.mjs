const fail=code=>Object.assign(new Error(code),{code});
export const progressIdentity=selection=>{if(!selection||!['movie','tv','anime'].includes(selection.kind)||!Number.isSafeInteger(selection.contentID)||selection.contentID<1)throw fail('PROGRESS_INVALID');if(selection.kind!=='movie'&&(!Number.isSafeInteger(selection.season)||selection.season<0||!Number.isSafeInteger(selection.episode)||selection.episode<1))throw fail('PROGRESS_INVALID');return{contentId:String(selection.contentID),contentType:selection.kind==='movie'?'movie':'tv',malId:selection.kind==='anime'?selection.contentID:undefined,seasonNumber:selection.kind==='movie'?undefined:selection.season,episodeNumber:selection.kind==='movie'?undefined:selection.episode};};
export function createProgressBridge({read,write,begin,scope,finished,now=Date.now}){
 const sessions=new Map();
 return async spec=>{
  const account=scope();if(!account)throw fail('PROGRESS_ACCOUNT_REQUIRED');
  for(const[id,s]of sessions)if(s.expires<=now())sessions.delete(id);
  if(spec.operation==='read'){
   const identity=progressIdentity(spec.selection);const entries=read().filter(e=>e.contentType===identity.contentType&&(identity.malId?e.malId===identity.malId:!e.malId&&e.contentId===identity.contentId)).sort((a,b)=>(b.lastWatchedAt??0)-(a.lastWatchedAt??0));const e=entries[0];
   return{entry:e?{kind:spec.selection.kind,contentID:spec.selection.contentID,season:e.seasonNumber??1,episode:e.episodeNumber??1,position:e.currentTime,duration:e.duration,completed:finished(e),lastWatchedAt:e.lastWatchedAt}:null};
  }
  if(spec.operation==='begin'){
   const identity=progressIdentity(spec.selection),context=begin(identity);if(Number.isFinite(spec.startedAt))context.progressSessionStartedAt=Math.min(context.progressSessionStartedAt,spec.startedAt);if(sessions.size>=128)sessions.delete(sessions.keys().next().value);
   sessions.set(context.progressSessionID,{explicitStartOver:spec.explicitStartOver===true,account,identity,context,sequence:0,title:spec.title,expires:now()+1800000});return{sessionID:context.progressSessionID};
  }
  const session=sessions.get(spec.sessionID);if(!session||session.account!==account||session.expires<=now())throw fail('PROGRESS_EXPIRED');
  if(spec.operation!=='update'||!Number.isSafeInteger(spec.sequence)||spec.sequence<=session.sequence||!Number.isFinite(spec.position)||spec.position<0||spec.position>86400||!Number.isFinite(spec.duration)||spec.duration<0||spec.duration>86400||typeof spec.ended!=='boolean')throw fail('PROGRESS_INVALID');
  const ended=spec.ended&&spec.duration>0&&spec.position>=spec.duration*0.95;
  const stored=write({...session.identity,...session.context,progressSequence:spec.sequence,explicitStartOver:session.explicitStartOver,currentTime:spec.position,duration:spec.duration,title:session.title,completionEvidence:ended?'ended':'position',completed:ended,now:now()});
  if(!stored&&spec.position>=5&&spec.duration>0)throw fail('PROGRESS_STALE');session.sequence=spec.sequence;session.expires=now()+1800000;return{ok:true,stored:!!stored};
 };
}
