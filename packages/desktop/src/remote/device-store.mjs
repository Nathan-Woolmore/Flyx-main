import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
export function createDeviceStore(folder,now=Date.now){
 const file=path.join(folder,'devices.json');
 function read(){
  const dir=fs.lstatSync(folder);if(!dir.isDirectory()||dir.isSymbolicLink()||(dir.mode&0o077)!==0)throw new Error('Private device directory required');
  if(!fs.existsSync(file))return {version:1,devices:[],pending:[]};
  const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077)!==0||process.getuid&&stat.uid!==process.getuid())throw new Error('Private device store required');
  const state=JSON.parse(fs.readFileSync(file,'utf8'));if(state.version!==1||!Array.isArray(state.devices)||!Array.isArray(state.pending))throw new Error('Invalid device store');return state;
 }
 function write(state){const temporary=path.join(folder,'.devices-'+crypto.randomUUID()+'.tmp');try{fs.writeFileSync(temporary,JSON.stringify(state,null,2)+'\n',{mode:0o600,flag:'wx'});fs.renameSync(temporary,file);}finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}}
 function validate(record){if(!record||typeof record.id!=='string'||!/^[a-zA-Z0-9-]{8,80}$/.test(record.id)||typeof record.name!=='string'||record.name.length<1||record.name.length>80||!/^[a-f0-9]{64}$/.test(record.digest)||!Number.isFinite(record.expires))throw new Error('Invalid remembered device');return record;}
 return {
  // Migrate approved devices (including old timed-out pairings) to permanent
  // access. Revoked devices have already been removed from this list. Pending
  // enrollment below still requires timely, explicit approval on the Mac.
  loadDevices(){const state=read();const devices=state.devices.map(validate);if(devices.some(v=>v.expires!==0)){state.devices=devices.map(v=>({...v,expires:0}));write(state);}return state.devices;},
  saveDevices(devices){const state=read();state.devices=devices.map(validate);write(state);},
  pending(){return read().pending.map(validate).find(v=>v.expires>now())??null;},
  pendingToken(token){if(typeof token!=='string'||token.length>512)return false;const record=this.pending();return !!record&&crypto.timingSafeEqual(crypto.createHash('sha256').update(token).digest(),Buffer.from(record.digest,'hex'));},
  removePending(id){const state=read();state.pending=state.pending.filter(v=>v.id!==id);write(state);},
  clearPending(){const state=read();state.pending=[];write(state);}
 };
}
