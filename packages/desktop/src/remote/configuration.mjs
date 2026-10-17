import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
export function privateIPv4(value){const p=String(value).split('.').map(Number);return p.length===4&&p.every(n=>Number.isInteger(n)&&n>=0&&n<=255)&&(p[0]===10||p[0]===192&&p[1]===168||p[0]===172&&p[1]>=16&&p[1]<=31);}
export function privateAddresses(){return Object.values(os.networkInterfaces()).flat().filter(v=>v&&!v.internal&&v.family==='IPv4'&&privateIPv4(v.address)).map(v=>v.address);}
function privateFile(file,root){const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077)!==0||process.getuid&&stat.uid!==process.getuid()||path.dirname(fs.realpathSync(file))!==root)throw new Error('Remote identity must remain in private local files');return file;}
export function loadRemoteConfiguration({dataDir,env=process.env,addresses=privateAddresses()}){
 const folder=path.join(dataDir,'remote'),file=path.join(folder,'config.json');
 if(!fs.existsSync(file))return null;
 const folderStat=fs.lstatSync(folder);if(!folderStat.isDirectory()||folderStat.isSymbolicLink()||(folderStat.mode&0o077)!==0)throw new Error('Remote configuration directory is not private');
 const root=fs.realpathSync(folder);privateFile(file,root);const config=JSON.parse(fs.readFileSync(file,'utf8'));
 const host=config.host,bindAddress=config.bindAddress,port=config.port;
 if(typeof host!=='string'||! /^[a-z0-9][a-z0-9-]*\.local$/i.test(host)||!privateIPv4(bindAddress)||!addresses.includes(bindAddress)||!Number.isSafeInteger(port)||port<1024||port>65535||config.enabled!==undefined&&typeof config.enabled!=='boolean')throw new Error('Remote LAN configuration is invalid or unavailable');
 const certFile=privateFile(config.certFile,root),keyFile=privateFile(config.keyFile,root);
 return{host:host.toLowerCase(),bindAddress,port,endpoint:`https://${host.toLowerCase()}:${port}`,enabled:config.enabled===true,
  tlsProvider:async()=>({cert:fs.readFileSync(certFile),key:fs.readFileSync(keyFile),port}),
  persistEnabled(enabled){if(typeof enabled!=='boolean')throw new Error('Invalid opt-in state');privateFile(file,root);const temporary=path.join(root,'.config-'+crypto.randomUUID()+'.tmp');
   try{fs.writeFileSync(temporary,JSON.stringify({...config,enabled},null,2)+'\n',{mode:0o600,flag:'wx'});fs.renameSync(temporary,file);config.enabled=enabled;}finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
  }};
}
