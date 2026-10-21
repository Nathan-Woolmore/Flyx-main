import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {nativeSwiftFixture} from './native-swift-fixture.mjs';

test('actual iOS parser and session preserve enrollment across wrong/expired codes, old hosts, approval, cancel and retry',{skip:process.platform!=='darwin'},async()=>{
  const folder=await mkdtemp(path.join(os.tmpdir(),'flyx-session81-'));
  const app=fileURLToPath(new URL('../../ios/Flyx Remote/App/',import.meta.url));
  let fixture;
  try {
    const source=await readFile(path.join(app,'FlyxRemoteApp.swift'),'utf8');
    const session=source.slice(source.indexOf('// Only the phone'),source.indexOf('struct BridgeInfo:'));
    const extracted=path.join(folder,'RemoteSession.swift');
    await writeFile(extracted,'import Foundation\nimport Observation\n'+session,{mode:0o600});
    fixture=await nativeSwiftFixture([path.join(app,'ConnectionCode.swift'),path.join(app,'RememberedConnection.swift'),extracted,fileURLToPath(new URL('./fixtures/ConnectionSession81.swift',import.meta.url))]);
    const {stdout}=await promisify(execFile)(fixture.binary,[],{timeout:20000,maxBuffer:1024*1024});
    assert.match(stdout,/native connection\/session checks passed/);
    process.stdout.write(stdout);
  }finally{await fixture?.cleanup();await rm(folder,{recursive:true,force:true});}
});
