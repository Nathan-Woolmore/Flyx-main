import https from 'node:https';
import { X509Certificate } from 'node:crypto';
export function certificatePin(cert) { return new X509Certificate(cert).fingerprint256.replaceAll(':','').toLowerCase(); }
export function createSecureTransport({handle,key,cert,host='127.0.0.1',port=0,allowedHosts=['127.0.0.1'],createServer=https.createServer,now=Date.now}) {
  if(!Number.isSafeInteger(port)||port<0||port>65535)throw new Error('Invalid port');
  if(!key || !cert || !Array.isArray(allowedHosts) || !allowedHosts.length) throw new Error('TLS identity and allowed hosts required');
  const pin=certificatePin(cert), clients=new Map(), sockets=new Set();let server;
  const handler=async(req,res)=>{
    const respond=(status,body,contentType)=>{if(res.writableEnded)return;res.writeHead(status,{'content-type':Buffer.isBuffer(body)?contentType:'application/json','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(Buffer.isBuffer(body)?body:JSON.stringify(body));};
    try {
      const authority=req.headers.host ?? ''; const hostname=authority.replace(/:[0-9]+$/,'').toLowerCase();
      if(!allowedHosts.includes(hostname)||req.headers.origin||!['GET','POST','DELETE'].includes(req.method))return respond(403,{error:'Request refused'});
      const address=req.socket.remoteAddress ?? 'unknown', previous=clients.get(address);
      if(!previous||now()-previous.start>=60000) {if(clients.size>=256)clients.clear();clients.set(address,{start:now(),count:1});}
      else if(++previous.count>120)return respond(429,{error:'Too many requests'});
      if(Number(req.headers['content-length']??0)>16384)return respond(413,{error:'Request too large'});
      if(req.method==='POST' && !/^application\/json(?:;|$)/i.test(req.headers['content-type']??''))return respond(415,{error:'JSON required'});
      let length=0;const chunks=[];
      for await(const chunk of req){length+=chunk.length;if(length>16384){respond(413,{error:'Request too large'});req.destroy();return;}chunks.push(chunk);}
      const body=length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
      if(body && (typeof body!=='object'||Array.isArray(body)))return respond(400,{error:'Invalid JSON body'});
      const result=await handle({method:req.method,path:req.url,headers:{authorization:req.headers.authorization,origin:req.headers.origin},body});
      respond(result.status,result.body,result.contentType);
    }catch {respond(400,{error:'Request failed'});}
  };
  return {pin, async start(){
    if(server)throw new Error('Already listening');
    server=createServer({key,cert,minVersion:'TLSv1.2',maxHeaderSize:8192},handler);
    server.requestTimeout=30000;server.headersTimeout=10000;server.keepAliveTimeout=1000;
    server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen({host,port},resolve);});
    return {port:server.address().port,pin};
  },async stop(){if(!server)return;const current=server;server=undefined;for(const socket of sockets)socket.destroy();await new Promise(resolve=>current.close(resolve));clients.clear();}};
}
