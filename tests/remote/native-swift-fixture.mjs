import {mkdtemp, rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec = promisify(execFile);

export async function nativeSwiftFixture(sources, extraArgs = []) {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'flyx-native81-'));
  const binary = path.join(folder, 'checks');
  try {
    await exec('/usr/bin/xcrun', ['swiftc', '-swift-version', '6', '-parse-as-library', '-DDEBUG',
      '-module-cache-path', path.join(folder, 'module-cache'), ...sources, '-o', binary, ...extraArgs], {timeout:120000,maxBuffer:2*1024*1024});
    return {binary, cleanup:()=>rm(folder,{recursive:true,force:true})};
  } catch(error) {await rm(folder,{recursive:true,force:true});throw error;}
}
