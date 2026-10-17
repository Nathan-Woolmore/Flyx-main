import {createRemoteProgress} from './progress.mjs';
import {createRemoteSources} from './sources.mjs';
import {createTransferRuntime} from './transfer-runtime.mjs';
import {createPhoneMedia} from './phone-media.mjs';
import {createManga} from './manga.mjs';
import {playbackFailure,playbackMessages} from './playback-errors.mjs';
import {createWatchlist} from './watchlist.mjs';
import { createSecureTransport } from './transport.mjs';
import { createDownloads } from './downloads.mjs';
import { randomBytes, randomUUID } from 'node:crypto';
import { RemoteCore } from './remote-core.mjs';
import { PairingApproval } from './pairing.mjs';
import { catalogFailure, catalogMessages, createCatalog } from './catalog.mjs';
import { createRemoteHandler } from './protocol.mjs';
export function installRemoteBridge({audioLocked = false, mediaOrigin, handleTrusted, send, isMainFrame, deviceStore, tlsProvider, persistEnabled = async()=>{}, transportEndpoint, transportHost = "127.0.0.1", transportAllowedHosts = ["127.0.0.1"], timeoutMS = 25000, makeID = randomUUID, makeToken = () => randomBytes(32).toString('base64url'), makeSecret = () => randomBytes(32).toString('hex'), now = Date.now}) {
  const waiting = new Map();
  function request(action, payload) {
    if (waiting.size >= 16) return Promise.reject(new Error('Mac busy'));
    const requestID = makeID();
    return new Promise((resolve,reject) => {
      const timer=setTimeout(() => {waiting.delete(requestID);reject(action==='catalog'?catalogFailure('CATALOG_TIMEOUT'):new Error('Mac renderer timed out'));},timeoutMS);
      waiting.set(requestID,{resolve,reject,timer,action});
      try { send('flyx:remote-request',{requestID,action,payload}); }
      catch(error) {clearTimeout(timer);waiting.delete(requestID);reject(error);}
    });
  }
  const core=new RemoteCore({now,makeID,makeToken,dispatch:command => {if(audioLocked&&['volume','mute'].includes(command.type))throw Object.assign(new Error('Mac silent playback setting is enabled'),{code:'PLAYBACK_AUDIO_LOCKED'});return request('command',command);},loadDevices:deviceStore?.loadDevices,saveDevices:deviceStore?.saveDevices});
  const pairing=new PairingApproval({core,makeSecret,makeID,now,enrollmentStore:deviceStore});
  const local=(channel,fn) => handleTrusted(channel,(event,payload) => {if(!isMainFrame(event)) throw new Error('Untrusted remote sender'); return fn(payload);});
  local('flyx:remote-reply', reply => {
    const pending=waiting.get(reply?.requestID); if(!pending) return;
    waiting.delete(reply.requestID); clearTimeout(pending.timer);
    reply.ok ? pending.resolve(reply.data) : pending.reject(playbackMessages[reply.errorCode]?playbackFailure(reply.errorCode):['catalog','watchlist','manga'].includes(pending.action)?catalogFailure(catalogMessages[reply.errorCode]?reply.errorCode:'CATALOG_UNAVAILABLE'):new Error('Mac operation failed'));
  });
  local('flyx:remote-pair-begin',()=>pairing.begin());
  local('flyx:remote-approval-state',()=>pairing.snapshot());
  local('flyx:remote-approve',payload=>pairing.approve(payload.id,['catalog.read','playback.control',...(payload.downloads===true?['downloads.read','downloads.write']:[])]));
  local('flyx:remote-reject',payload=>pairing.reject(payload.id));
  local('flyx:remote-permissions',payload=>core.updateScopes(payload.id,['catalog.read','playback.control',...(payload.watchlist===true?['watchlist.write']:[]),...(payload.downloads===true?['downloads.read','downloads.write']:[])]));
  local('flyx:remote-revoke',payload=>({ok:core.revoke(payload.id)}));
  let transport, transportInfo;
  local('flyx:remote-transport-state',()=>({configured:!!tlsProvider,listening:!!transportInfo,endpoint:transportEndpoint,...transportInfo}));
  async function startTransport(remember=true){
    if(!tlsProvider||transport)throw new Error('Secure transport setup required');
    const material=await tlsProvider();transport=createSecureTransport({handle:handleRequest,...material,host:transportHost,allowedHosts:transportAllowedHosts});
    try{transportInfo=await transport.start();progress?.start(()=>request('transfer',{method:'snapshot',origin:'tv'}));if(remember)await persistEnabled(true);return {configured:true,listening:true,endpoint:transportEndpoint,...transportInfo};}
    catch(error){await transport?.stop();transport=undefined;transportInfo=undefined;throw error;}
  }
  async function stopTransport(remember=true){
    if(remember)await persistEnabled(false);
    progress?.stop();await transport?.stop();transport=undefined;transportInfo=undefined;if(remember){core.revokeAll();deviceStore?.clearPending();}else core.clearMemory();pairing.cancel();return {ok:true};
  }
  local('flyx:remote-transport-start',()=>startTransport(true));
  local('flyx:remote-transport-stop',()=>stopTransport(true));
  const downloads=createDownloads(spec=>request('downloads',spec));
  const catalog=createCatalog(path=>request('catalog',{path}));
  const watchlist=createWatchlist(spec=>request('watchlist',spec),catalog);
  const manga=createManga(spec=>request('manga',spec));
  const phoneMedia=mediaOrigin?createPhoneMedia(spec=>request('phoneMedia',spec),{origin:mediaOrigin}):undefined;
  const progress=phoneMedia?createRemoteProgress(spec=>request('progress',spec),phoneMedia):undefined;
  const transfers=phoneMedia?createTransferRuntime(spec=>request('transfer',spec),phoneMedia,{onOriginSnapshot:source=>progress.recordSnapshot(source)}):undefined;
  const sources=createRemoteSources(spec=>request('sources',spec));
  const handleRequest=createRemoteHandler({progress,sources,transfers,core,pairing,catalog,downloads,watchlist,manga,phoneMedia,pendingSession:token=>deviceStore?.pendingToken(token)??false,status:async()=>({...await request('status',{}),audioControl:!audioLocked})});
  return {handle:handleRequest, resume:()=>startTransport(false), async dispose(){ await transfers?.dispose();await stopTransport(false); for(const p of waiting.values()){clearTimeout(p.timer);p.reject(new Error('Bridge stopped'));} waiting.clear(); }};
}
