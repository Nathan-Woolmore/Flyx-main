import fs from 'node:fs';
import {open} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import os from 'node:os';import path from 'node:path';
import {SignJWT,jwtVerify} from 'jose';
import {createFileAccessBudget} from '../../../packages/app/src/lib/downloads/file-access-budget.mjs';
import {sessionWithinBudget} from '../../../packages/app/src/lib/auth/session-budget.mjs';
import {resolvePhoneSources} from '../../../packages/app/src/lib/remote/source-resolution.mjs';
import {createRendererAdapter} from '../../../packages/app/src/lib/remote/renderer.mjs';
import {createPhoneMedia} from '../../../packages/desktop/src/remote/phone-media.mjs';
const limited=process.argv[2]==='limited',folder=fs.mkdtempSync(path.join(os.tmpdir(),'flyx79-workers-')),fifo=path.join(folder,'blocked-file');
execFileSync('/usr/bin/mkfifo',[fifo]);
const secret=new TextEncoder().encode('synthetic-worker-starvation-secret-never-user-credentials');
const token=await new SignJWT({sub:'synthetic-account'}).setProtectedHeader({alg:'HS256'}).setIssuedAt().setExpirationTime('1m').sign(secret);
const gate=createFileAccessBudget({timeoutMS:80});let opens=0,closedLate=0,desktopCalls=0;const handles=[];
const work=async()=>{opens++;const handle=await open(fifo,'r');handles.push(handle);return{handle};};
const pending=Array.from({length:5},()=>limited?gate(work,async value=>{closedLate++;await value.handle.close();}):work());
await new Promise(resolve=>setTimeout(resolve,25));
let signatureVerified=false,errorCode,grant;const began=Date.now();
const adapter=createRendererAdapter({navigate:()=>desktopCalls++,waitForPlayer:()=>desktopCalls++,player:{play:()=>desktopCalls++,pause:()=>desktopCalls++},resolvePhoneTitle:selected=>resolvePhoneSources(selected,{fetcher:async url=>{
 try{await sessionWithinBudget(async()=>{await jwtVerify(token,secret,{algorithms:['HS256']});signatureVerified=true;return {isAdmin:true};},{timeoutMS:100});}
 catch(error){return Response.json({ok:false,code:error.code},{status:503});}
 const provider=new URL(url,'http://fixture').searchParams.get('provider');
 return provider==='local'?Response.json({ok:false},{status:404}):Response.json({ok:true,sources:[{url:'http://127.0.0.1:3891/api/stream/proxy?synthetic=79',contentType:'application/x-mpegURL',quality:'720p',language:'sub'}]});
}})});
const media=createPhoneMedia(payload=>adapter({action:'phoneMedia',payload}),{origin:'http://127.0.0.1:3891'});
try{grant=await media('prepare',{selection:{kind:'anime',contentID:38000,season:1,episode:1}},'synthetic-owner');}catch(error){errorCode=error.code;}
if(limited){await Promise.all(pending);await Promise.all(Array.from({length:20},()=>gate(work,async value=>value.handle.close())));}
const opensBeforeRelease=opens,signatureBeforeRelease=signatureVerified,elapsedMS=Date.now()-began;
const writer=fs.openSync(fifo,fs.constants.O_RDWR|fs.constants.O_NONBLOCK);
await Promise.allSettled(pending);await new Promise(resolve=>setTimeout(resolve,80));
await Promise.all(handles.map(handle=>handle.close().catch(()=>{})));fs.closeSync(writer);fs.rmSync(folder,{recursive:true,force:true});
console.log(JSON.stringify({limited,opensBeforeRelease,closedLate,signatureVerified:signatureBeforeRelease,errorCode,grantCreated:!!grant,format:grant?.format,sourceSelection:grant?.sourceInfo?.selection,desktopCalls,elapsedMS}));
