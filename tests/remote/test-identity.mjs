// Disposable synthetic TLS identity: generated only for tests, never shipped.
import {execFileSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
export function makeTestIdentity(){
 const dir=mkdtempSync(path.join(tmpdir(),'flyx-test-tls-'));
 try{
  execFileSync('openssl',['req','-newkey','rsa:2048','-nodes','-x509','-days','2','-config',fileURLToPath(new URL('./fixtures/test-cert.cnf',import.meta.url)),'-keyout',path.join(dir,'key.pem'),'-out',path.join(dir,'cert.pem')],{stdio:'ignore'});
  return{key:readFileSync(path.join(dir,'key.pem')),cert:readFileSync(path.join(dir,'cert.pem'))};
 }finally{rmSync(dir,{recursive:true,force:true});}
}
