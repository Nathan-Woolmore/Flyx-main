import {createDestinationTransfers} from './destination-transfers.mjs';
export function createTransferRuntime(request,phoneMedia,options={}){

 const phoneSnapshot=(owner,handle,position,paused)=>{if(!Number.isFinite(position)||position<0||position>86400||typeof paused!=='boolean')throw new Error('Invalid phone position');return{...phoneMedia.inspectForTransfer(owner,handle),position,paused,output:'phone'};};
 const adapter={
  snapshotOrigin:async body=>{const value=body.origin==='phone'?phoneSnapshot(body.owner,body.phoneHandle,body.position,body.paused):await request({method:'snapshot',origin:body.origin});return value;},
  refreshOrigin:async({owner,origin,position,paused})=>origin.output==='phone'?phoneSnapshot(owner,origin.stamp,position,paused):request({method:'snapshot',origin:origin.output}),
  prepareDestination:async spec=>{if(spec.destination==='phone'){const grant=phoneMedia.prepareForTransfer(spec.owner,spec.origin);return{phoneHandle:grant.handle,publicData:{handle:grant.handle,format:grant.format,position:grant.position,duration:grant.duration,paused:true}};}const{signal,...safe}=spec;return request({method:'prepare',...safe});},
  destinationIsCurrent:async spec=>spec.destination==='phone'?phoneMedia.transferIsCurrent(spec.stage.owner,spec.stage.phoneHandle):request({method:'isCurrent',...spec}),
  activateDestination:async spec=>{if(spec.destination==='phone'){if(spec.nativeReady!==true)throw new Error('Phone not ready');return{...spec.snapshot,output:'phone'};}const{signal,...safe}=spec;return request({method:'activate',...safe});},
  stopOrigin:async spec=>{await options.onOriginSnapshot?.(spec.origin).catch(()=>{});return spec.origin.output==='phone'?{snapshot:spec.origin}:request({method:'stopOrigin',...spec});},
  finalizeDestination:async spec=>spec.destination==='phone'?{...spec.snapshot,output:'phone'}:request({method:'activate',...spec}),
  restoreOrigin:async spec=>spec.origin?.output==='phone'?undefined:request({method:'restoreOrigin',...spec}),
  cleanupDestination:async spec=>{if(spec.destination==='phone'){if(spec.stage?.phoneHandle){const owner=spec.stage.owner;return phoneMedia('close',{handle:spec.stage.phoneHandle},owner);}return;}return request({method:'cleanup',...spec});},
  completeOrigin:async spec=>spec.origin.output==='tv'?request({method:'completeOrigin',...spec}):undefined,
  confirmPhone:async spec=>phoneMedia.activateTransfer(spec.owner,spec.stage.phoneHandle),
 };
 const transfers=createDestinationTransfers(adapter,options);
 // Keep owner private on phone stages for cleanup; it is never part of publicData.
 const prepare=adapter.prepareDestination;adapter.prepareDestination=async spec=>({...await prepare(spec),owner:spec.owner});
 return transfers;
}
