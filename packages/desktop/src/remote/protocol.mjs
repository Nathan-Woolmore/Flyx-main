import {catalogMessages} from './catalog.mjs';
import {playbackMessages} from './playback-errors.mjs';
export function createRemoteHandler({core, pairing, catalog, home, reviews, status, downloads, watchlist, manga, phoneMedia, sources, transfers, progress, pendingSession}) {
  return async ({method, path, headers = {}, body}) => {
    try {
      if (typeof path !== 'string' || path.length > 2048) return {status:400, body:{error:'Invalid request'}};
      const url = new URL(path, 'https://remote.invalid');
      if (url.origin !== 'https://remote.invalid') return {status:400, body:{error:'Invalid path'}};
      if (headers.origin || headers.Origin) return {status:403, body:{error:'Browser origins are not allowed'}};
      if (method === 'GET' && url.pathname === '/remote/v1/info') return {status:200, body:{protocolVersion:1, name:'Flyx Mac', capabilities:['catalog.read','playback.control'],features:['catalog.minVotes',...(reviews?['catalog.reviews.v1']:[]),...(home?['catalog.home.v1','catalog.home.categories.v1']:[]),...(downloads?['downloads.library.v1']:[]),...(progress?['player.progress.v1']:[]),...(phoneMedia?['phone.direct.mp4','phone.direct.hls']:[]),...(sources?['player.sources.v1']:[]),...(transfers?['player.transfer.api.v2','player.transfer.confirm.v2']:[])]}};
      if (method === 'POST' && url.pathname === '/remote/v1/pair/request') return {status:202, body:pairing.request(body ?? {})};
      if (method === 'POST' && url.pathname === '/remote/v1/pair/collect') return {status:200, body:pairing.collect(body?.requestID)};
      if (method === 'POST' && url.pathname === '/remote/v1/pair/cancel') return {status:200, body:pairing.cancelRequest(body??{})};
      const authorization = headers.authorization ?? headers.Authorization ?? '';
      if (!authorization.startsWith('Bearer ')) return {status:401, body:{error:'Pairing required'}};
      const token = authorization.slice(7);
      if(method==='GET'&&url.pathname==='/remote/v1/session'){try{const device=core.authorize(token,'catalog.read');return{status:200,body:{deviceID:device.id,scopes:[...device.scopes],expiresAt:device.expires}};}catch(error){if(pendingSession?.(token))return{status:403,body:{error:'Approval pending'}};throw error;}}
      if(url.pathname==='/remote/v1/progress'&&method==='POST'){const device=core.authorize(token,body?.operation==='read'?'catalog.read':'playback.control');if(!progress)throw Object.assign(new Error('Unavailable'),{code:'PROGRESS_UNAVAILABLE'});return{status:200,body:await progress.handle(body??{},device.id)};}
      if(url.pathname==='/remote/v1/sources'&&method==='POST'){const device=core.authorize(token,'playback.control');if(!sources)throw Object.assign(new Error('Unavailable'),{code:'SOURCE_UNAVAILABLE'});return{status:200,body:await sources(body??{},device.id)};}
      if(url.pathname==='/remote/v1/transfers'&&method==='POST'){const device=core.authorize(token,'playback.control');if(!transfers)throw Object.assign(new Error('Unavailable'),{code:'TRANSFER_UNSUPPORTED'});return{status:200,body:await transfers.handle(body?.operation,body??{},device.id)};}
      if(url.pathname==='/remote/v1/media'&&method==='POST'){const device=core.authorize(token,'playback.control');if(!phoneMedia)throw Object.assign(new Error('Unavailable'),{code:'PHONE_MEDIA_UNAVAILABLE'});return{status:200,body:await phoneMedia(body?.operation,body??{},device.id)};}
      if(url.pathname==='/remote/v1/manga/chapter'&&method==='POST'){const device=core.authorize(token,'catalog.read');return{status:200,body:await manga('chapter',body??{},device.id)};}
      if(url.pathname==='/remote/v1/manga/image'&&method==='GET'){const device=core.authorize(token,'catalog.read');const image=await manga('image',{handle:url.searchParams.get('handle'),page:Number(url.searchParams.get('page'))},device.id);return{status:200,body:image.bytes,contentType:image.contentType};}
      if(url.pathname==='/remote/v1/watchlist'&&['GET','POST'].includes(method)){
        core.authorize(token,'catalog.read');
        if(method==='POST'){try{core.authorize(token,'watchlist.write');}catch{return{status:403,body:{code:'WATCHLIST_PERMISSION_REQUIRED',error:'Allow watchlist saving for this phone in Flyx on your Mac.'}};}}
        return{status:200,body:await watchlist(method==='GET'?'list':body?.operation,body)};
      }
      if(url.pathname==='/remote/v1/downloads' && ['GET','POST'].includes(method)) {
        const operation=method==='GET'?'list':body?.operation;
        core.authorize(token,operation==='list'?'downloads.read':'downloads.write');
        return {status:200,body:await downloads(operation,body)};
      }
      if (method === 'POST' && url.pathname === '/remote/v1/commands') return {status:200, body:await core.command(token, body)};
      if (method === 'GET' && url.pathname === '/remote/v1/status') { core.authorize(token,'playback.control'); return {status:200, body:await status()}; }
      if(method==='GET'&&url.pathname==='/remote/v1/reviews'){
        core.authorize(token,'catalog.read');
        if(!reviews)return{status:404,body:{code:'REVIEWS_UNAVAILABLE',error:'Reviews are unavailable'}};
        if([...url.searchParams.keys()].some(k=>!['kind','id','page'].includes(k)))return{status:400,body:{error:'Invalid reviews request'}};
        return{status:200,body:await reviews({kind:url.searchParams.get('kind'),id:url.searchParams.get('id'),page:Number(url.searchParams.get('page')??1)})};
      }
      if (method === 'GET' && url.pathname === '/remote/v1/home') {
        core.authorize(token,'catalog.read');
        if(!home)return{status:404,body:{code:'HOME_UNAVAILABLE',error:'Update Flyx on your Mac to load Home.'}};
        if([...url.searchParams.keys()].some(k=>!['refresh','category'].includes(k))||!['0','1',null].includes(url.searchParams.get('refresh'))||!['all','movie','tv','anime','manga',null].includes(url.searchParams.get('category')))return{status:400,body:{error:'Invalid Home request'}};
        return{status:200,body:await home({refresh:url.searchParams.get('refresh')==='1',category:url.searchParams.get('category')??'all'})};
      }
      if (method === 'GET' && ['/remote/v1/catalog','/remote/v1/details'].includes(url.pathname)) {
        core.authorize(token,'catalog.read');
        const number=key=>url.searchParams.has(key)?Number(url.searchParams.get(key)):undefined;
        return {status:200, body:await catalog({kind:url.searchParams.get('kind'), query:url.searchParams.get('q') ?? '', page:Number(url.searchParams.get('page') ?? 1),genre:url.searchParams.get('genre')??'',yearFrom:number('yearFrom'),yearTo:number('yearTo'),minRating:number('minRating')??0,minVotes:number('minVotes'),sort:url.searchParams.get('sort')??'popularity', id:url.searchParams.get('id'), season:number('season')}, url.pathname.endsWith('/details'))};
      }
      return {status:404, body:{error:'Unsupported operation'}};
    } catch (error) {
      const pairingMessages={PAIRING_CODE_EXPIRED:'This connection code expired. Create a new code on your Mac.',PAIRING_CODE_REJECTED:'The connection code was not accepted. Copy the complete current code from your Mac.',PAIRING_LIMITED:'Too many pairing attempts. Create a new code on your Mac.',PAIRING_BUSY:'Another iPhone is awaiting approval. Finish or cancel that request on your Mac.'};
      if(pairingMessages[error.code])return{status:error.code==='PAIRING_LIMITED'?429:error.code==='PAIRING_BUSY'?409:error.code==='PAIRING_CODE_EXPIRED'?410:400,body:{code:error.code,error:pairingMessages[error.code]}};
      if(playbackMessages[error.code])return{status:error.code==='PLAYBACK_OUTPUT_CHANGED'?409:error.code==='PLAYBACK_AUDIO_LOCKED'?423:502,body:{code:error.code,error:playbackMessages[error.code]}};
      if(error.name==='CatalogRequestError')return{status:400,body:{error:error.message,code:'CATALOG_INVALID_REQUEST'}};
      if(catalogMessages[error.code])return{status:error.code==='WATCHLIST_SCOPE_CHANGED'?409:error.code==='CATALOG_NOT_FOUND'?404:error.code==='CATALOG_RATE_LIMITED'?429:error.code==='CATALOG_TIMEOUT'?504:502,body:{error:catalogMessages[error.code],code:error.code}};
      const unauthorized = error.message === 'Unauthorized';
      return {status:unauthorized ? 401 : 400, body:{error:unauthorized ? 'Pairing required or permission revoked' : 'Request failed'}};
    }
  };
}
