"use client";
import {orderedStartupSources,fastStartRank} from "@/components/player/source-quality";
import {getPlayerPreferences} from "@/lib/utils/player-preferences";
import {resolvePhoneSources} from "./source-resolution.mjs";
import {createProgressBridge} from './progress-bridge.mjs';
import {getAllWatchProgress,updateWatchProgress,beginProgressSession,isProgressFinished,WATCH_PROGRESS_KEY} from '@/lib/watch-progress';
import {createWatchlistStore} from './watchlist-store.mjs';
import {accountKey,resolveAccountScope,ACCOUNT_SCOPE_EVENT} from '@/lib/account-storage';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { getDesktopCastBridge } from '@/lib/desktop-cast';
import {waitForRemotePlayer} from './wait-for-player.mjs';
import { createRendererAdapter } from './renderer.mjs';
export interface RemoteAPI {
 updatePermissions(id:string,watchlist:boolean,downloads:boolean):Promise<unknown>;
 onRequest(callback:(request:any)=>void):()=>void;
 reply(reply:any):Promise<void>;
 beginPairing():Promise<{secret:string;expiresAt:number}>;
 approvalState():Promise<{pending:{id:string;name:string}|null;devices:{id:string;name:string;scopes?:string[]}[]}>;
 approve(id:string,downloads?:boolean):Promise<unknown>;
 transportState():Promise<{configured:boolean;listening:boolean;pin?:string;port?:number;endpoint?:string}>; startTransport():Promise<unknown>;stopTransport():Promise<unknown>; reject(id:string):Promise<unknown>; revoke(id:string):Promise<unknown>;
}
export function remoteAPI():RemoteAPI|undefined { return (window as unknown as {flyxDesktop?:{remote?:RemoteAPI}}).flyxDesktop?.remote; }
function video():HTMLVideoElement { const element=document.querySelector<HTMLVideoElement>('video[data-flyx-remote-player]');if(!element)throw new Error('No active Mac player');return element; }
export default function RemoteHost() {
 const router=useRouter();
 useEffect(()=>{
  const api=remoteAPI();if(!api)return;
  const snapshot=()=>{const v=document.querySelector<HTMLVideoElement>('video[data-flyx-remote-player]');if(!v)return {state:'idle',position:0,duration:0,output:'mac',outputName:'Mac'};const metadata=navigator.mediaSession?.metadata;const artwork=metadata?.artwork?.find(image=>image.src.startsWith('https://'))?.src;return {state:v.ended?'ended':v.paused?'paused':'playing',position:Number.isFinite(v.currentTime)?v.currentTime:0,duration:Number.isFinite(v.duration)?v.duration:0,title:metadata?.title?.slice(0,200),artworkURL:artwork,output:'mac',outputName:'Mac',volume:v.volume,isMuted:v.muted};};
  let uiEpoch=0;const activity=()=>{uiEpoch+=1;};window.addEventListener('pointerdown',activity,true);window.addEventListener('keydown',activity,true);const stamps=new WeakMap<HTMLVideoElement,{src:string;id:string}>();
  const watchlist=createWatchlistStore({storage:window.localStorage,key:()=>accountKey('flyx_watchlist_v1'),changed:()=>window.dispatchEvent(new Event(ACCOUNT_SCOPE_EVENT))});
  const progress=createProgressBridge({read:getAllWatchProgress,write:updateWatchProgress,begin:beginProgressSession,scope:()=>accountKey(WATCH_PROGRESS_KEY),finished:isProgressFinished});
  const adapter=createRendererAdapter({progress:async(spec:any)=>{await resolveAccountScope();return progress(spec);},resolvePhoneTitle:async(selection:any)=>{
    return resolvePhoneSources(selection, {fetcher:fetch, order:(sources:any[])=>orderedStartupSources(sources,getPlayerPreferences().preferredQuality), recovery:(sources:any[])=>[...sources].sort((a,b)=>fastStartRank(b)-fastStartRank(a))});
  },resolveCastMedia:async(source:any)=>{const q=new URLSearchParams({format:'json',target:'cast',url:source.url,title:source.title??'Flyx'});const response=await fetch('/api/stream/vlc?'+q,{credentials:'same-origin',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(20000)});const value=await response.json();if(!response.ok||!value.ok)throw Object.assign(new Error('Cast source unavailable'),{code:'TRANSFER_UNSUPPORTED'});return{url:value.url,title:source.title,contentType:source.contentType};},manga:async(spec:any)=>{
    const path=spec.operation==='chapter'?'/api/manga/chapter-pages?'+new URLSearchParams({mangaID:spec.mangaID,chapterID:spec.chapterID}):'/api/manga/image?'+new URLSearchParams({url:spec.url,...(spec.referer?{referer:spec.referer}:{})});
    const response=await fetch(path,{credentials:'same-origin',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(20000)});if(!response.ok)throw Object.assign(new Error('Reader unavailable'),{code:'MANGA_UNAVAILABLE'});
    if(spec.operation==='chapter')return response.json();
    const mimeType=(response.headers.get('content-type')??'').split(';')[0];if(!['image/png','image/jpeg','image/webp','image/gif'].includes(mimeType)||Number(response.headers.get('content-length')??0)>8388608)throw new Error('Unsupported page');
    const bytes=new Uint8Array(await response.arrayBuffer());if(bytes.length>8388608)throw new Error('Page too large');let binary='';for(let offset=0;offset<bytes.length;offset+=32768)binary+=String.fromCharCode(...bytes.subarray(offset,offset+32768));return{mimeType,base64:btoa(binary)};
  },watchlist:async(spec:any)=>{try{await resolveAccountScope();return watchlist(spec);}catch(error){if(error instanceof Error&&'code'in error)throw error;throw Object.assign(new Error('Watchlist unavailable'),{code:'WATCHLIST_UNAVAILABLE'});}},cast:getDesktopCastBridge(),downloads:async(spec:any)=>{
    if(!/^\/api\/downloads(?:\/[a-f0-9-]{36}(?:\/retry)?)?$/.test(spec.path)||!['GET','POST','DELETE'].includes(spec.method))throw new Error('Invalid download route');
    const response=await fetch(spec.path,{method:spec.method,credentials:'same-origin',redirect:'error',cache:'no-store',headers:spec.body?{'Content-Type':'application/json'}:undefined,body:spec.body?JSON.stringify(spec.body):undefined});if(!response.ok)throw new Error('Download failed');return response.json();
  },navigate:async(target:string)=>router.push(target), player:{isReady:()=>{const v=video();return v.readyState>=2&&!!v.currentSrc&&!v.error;},stamp:()=>{const v=video();let value=stamps.get(v);if(!value||value.src!==v.currentSrc){value={src:v.currentSrc,id:crypto.randomUUID()};stamps.set(v,value);}return value.id+':'+uiEpoch;},transferID:()=>video().dataset.flyxRemoteTransfer??'',markTransfer:(id:string)=>{video().dataset.flyxRemoteTransfer=id;},seekAndWait:async(seconds:number)=>{const v=video();if(!Number.isFinite(v.duration)||seconds>v.duration)throw new Error('Invalid seek');v.currentTime=seconds;const end=Date.now()+5000;while(Date.now()<end){if(video()!==v)throw new Error('Player changed');if(!v.seeking&&Math.abs(v.currentTime-seconds)<1)return;await new Promise(r=>setTimeout(r,50));}throw new Error('Seek unconfirmed');},identity:()=>video().dataset.flyxRemoteReady ?? '',setVolume:(value:number)=>{video().volume=value;},setMuted:(value:boolean)=>{video().muted=value;},play:()=>video().play(),pause:()=>video().pause(),seek:(seconds:number)=>{const v=video();if(!Number.isFinite(v.duration)||seconds>v.duration)throw new Error('Invalid seek');v.currentTime=seconds;},snapshot},fetchJSON:async(path:string)=>{const response=await fetch(path,{credentials:'same-origin',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(20000)});if(!response.ok)throw Object.assign(new Error('Catalogue request failed'),{code:response.status===404?'CATALOG_NOT_FOUND':response.status===429?'CATALOG_RATE_LIMITED':response.status===401?'CATALOG_SESSION_REQUIRED':'CATALOG_UNAVAILABLE'});return response.json();},waitForPlayer:async(command:any)=>waitForRemotePlayer(command,{getVideo:()=>document.querySelector<HTMLVideoElement>('video[data-flyx-remote-player]'),selectEpisode:(selection:any)=>window.dispatchEvent(new CustomEvent('flyx:remote-select-episode',{detail:selection}))})
  });
  const unsubscribe=api.onRequest(async(request:any)=>{try{await api.reply({requestID:request.requestID,ok:true,data:await adapter(request)});}catch(error){const errorCode=error instanceof Error&&error.name==='TimeoutError'?'CATALOG_TIMEOUT':error instanceof Error&&'code'in error?String(error.code):undefined;await api.reply({requestID:request.requestID,ok:false,errorCode});}});
  return()=>{unsubscribe();window.removeEventListener('pointerdown',activity,true);window.removeEventListener('keydown',activity,true);};
 },[router]);
 return null;
}
