"use client";
import { useEffect, useState } from 'react';
import { remoteAPI } from '@/lib/remote/RemoteHost';
export default function RemotePairingSettings(){
 const [state,setState]=useState<Awaited<ReturnType<NonNullable<ReturnType<typeof remoteAPI>>['approvalState']>>|null>(null);
 const [offer,setOffer]=useState<{secret:string;expiresAt:number}|null>(null);
 const [downloads,setDownloads]=useState(false);
 const [transport,setTransport]=useState<{configured:boolean;listening:boolean;pin?:string;port?:number;endpoint?:string}|null>(null);
 const [error,setError]=useState('');const [busy,setBusy]=useState(false);
 useEffect(()=>{const api=remoteAPI();if(!api)return;let active=true;const refresh=()=>api.approvalState().then(value=>{if(active)setState(value);}).catch(()=>{if(active)setError('Remote bridge unavailable');});void api.transportState().then(setTransport);void refresh();const timer=setInterval(refresh,1500);return()=>{active=false;clearInterval(timer);};},[]);
 async function act(action:()=>Promise<unknown>){setBusy(true);setError('');try{await action();const value=await remoteAPI()?.approvalState();if(value)setState(value);}catch{setError('Could not complete the request');}finally{setBusy(false);}}
 if(!state)return error?<p role="alert">{error}</p>:null;
 return <section aria-label="Flyx Remote pairing" style={{padding:24,border:'1px solid #60458a',borderRadius:16,marginTop:20}}><h2>Flyx Remote</h2><p>Approve your iPhone here. Your remembered phone reconnects securely and can be revoked below. Prepared personal-device access expires after 90 days.</p><p>{transport?.listening ? `Remote enabled at ${transport.endpoint ?? `port ${transport.port}`}. Compare this certificate fingerprint on your phone: ${transport.pin}` : "Remote network access is off."}</p>
 <button disabled={busy||!transport?.configured||transport?.listening} onClick={()=>act(async()=>{await remoteAPI()!.startTransport();setTransport(await remoteAPI()!.transportState());})}>Enable secure remote</button>
 {transport?.listening&&<button disabled={busy} onClick={()=>act(async()=>{await remoteAPI()!.stopTransport();setTransport(await remoteAPI()!.transportState());})}>Disable remote and revoke access</button>}
 {!transport?.configured&&<p>TLS identity and local listener configuration are required before enabling remote access.</p>}
 <button disabled={busy} onClick={()=>act(async()=>{const value=await remoteAPI()!.beginPairing();setOffer(value);})}>Begin pairing</button>
 {offer&&Date.now()<offer.expiresAt&&<p>Pairing secret · expires in two minutes: <code style={{overflowWrap:'anywhere'}}>{offer.secret}</code></p>}
 {state.pending&&<div><p>Allow <strong>{state.pending.name}</strong> to browse and control Mac playback?</p><label><input type="checkbox" checked={downloads} onChange={event=>setDownloads(event.target.checked)}/> Allow Mac download management</label><button disabled={busy} onClick={()=>act(()=>remoteAPI()!.approve(state.pending!.id,downloads))}>Approve iPhone</button><button disabled={busy} onClick={()=>act(()=>remoteAPI()!.reject(state.pending!.id))}>Reject</button></div>}
 <ul>{state.devices.map(device=><li key={device.id}>{device.name} <button disabled={busy} onClick={()=>act(()=>remoteAPI()!.revoke(device.id))}>Revoke access</button><DevicePermissions device={device} busy={busy} apply={(watchlist,downloads)=>act(()=>remoteAPI()!.updatePermissions(device.id,watchlist,downloads))}/></li>)}</ul>{error&&<p role="alert">{error}</p>}</section>;
}

function DevicePermissions({device,busy,apply}:{device:{scopes?:string[]};busy:boolean;apply:(watchlist:boolean,downloads:boolean)=>Promise<void>}){const[watchlist,setWatchlist]=useState(device.scopes?.includes('watchlist.write')??false);const[downloads,setDownloads]=useState(device.scopes?.includes('downloads.write')??false);return <div><label><input type="checkbox" checked={watchlist} onChange={event=>setWatchlist(event.target.checked)}/> Allow watchlist saving</label><label><input type="checkbox" checked={downloads} onChange={event=>setDownloads(event.target.checked)}/> Allow Mac download management</label><button disabled={busy} onClick={()=>apply(watchlist,downloads)}>Approve permission changes</button></div>;}
