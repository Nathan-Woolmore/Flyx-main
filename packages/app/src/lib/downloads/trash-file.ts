import fs from "node:fs/promises";
import { constants, type BigIntStats } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { localFileRevision } from "./local-files";
import type { DownloadJob } from "./types";

const execute = promisify(execFile);
// Fixed code, never interpolate a path into executable source. A file-reference URL
// pins the verified filesystem object while Foundation performs its recoverable move.
export const NATIVE_TRASH_SCRIPT = `ObjC.import('Foundation');
function run(args){
 var fm=$.NSFileManager.defaultManager,err=Ref();
 var u=$.NSURL.fileURLWithPath(args[0]).fileReferenceURL;
 if(!u)throw Error('DOWNLOAD_CHANGED');
 var a=fm.attributesOfItemAtPathError(u.path,err);
 if(!a||ObjC.unwrap(u.path)!==args[0]||ObjC.unwrap(a.objectForKey('NSFileType'))!=='NSFileTypeRegular'||ObjC.unwrap(a.objectForKey('NSFileSystemFileNumber').stringValue)!==args[1]||ObjC.unwrap(a.objectForKey('NSFileSize').stringValue)!==args[2])throw Error('DOWNLOAD_CHANGED');
 if(!fm.trashItemAtURLResultingItemURLError(u,null,err))throw Error('DOWNLOAD_TRASH_FAILED');
 return JSON.stringify({ok:true});
}`;

export async function trashManagedDownload(
 job:DownloadJob,jobs:DownloadJob[],directory:string,revision:unknown,
 run:typeof execute=execute,
):Promise<void>{
 if(process.platform!=="darwin"||process.env.FLYX_DESKTOP!=="true")throw new Error("DOWNLOAD_TRASH_FAILED");
 if(job.status!=="done"||!job.filepath||typeof revision!=="string"||!/^[a-f0-9]{64}$/.test(revision)||revision!==job.fileRevision)throw new Error("DOWNLOAD_CHANGED");
 const root=path.resolve(job.collectionRoot||directory),file=path.resolve(job.filepath);
 if(path.dirname(file)!==root||![".mp4",".m4v",".cbz"].includes(path.extname(file).toLowerCase())||jobs.some(other=>other.id!==job.id&&other.filepath&&path.resolve(other.filepath)===file))throw new Error("DOWNLOAD_CHANGED");
 let canonicalRoot:string,canonicalFile:string,stat:BigIntStats;
 try{
  canonicalRoot=await fs.realpath(root);canonicalFile=await fs.realpath(file);
  const checked=await fs.lstat(file,{bigint:true});
  if(!checked.isFile()||checked.isSymbolicLink()||checked.nlink!==1n||path.dirname(canonicalFile)!==canonicalRoot||localFileRevision(checked)!==revision)throw new Error("DOWNLOAD_CHANGED");
  // O_NOFOLLOW and descriptor identity also reject a replaced final component.
  const handle=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{if(localFileRevision(await handle.stat({bigint:true}))!==revision)throw new Error("DOWNLOAD_CHANGED");}finally{await handle.close();}
  stat=checked;
 }catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")throw new Error("DOWNLOAD_MISSING");throw new Error("DOWNLOAD_CHANGED");}
 // Includes other processes and already-open local playback. New local playback is
 // fenced by the manager before validation, including opens racing the fence.
 try{
  const result=await run('/usr/sbin/lsof',['-nP','-t','--',canonicalFile],{timeout:5000,maxBuffer:8192});
  if(result.stdout.trim())throw new Error("DOWNLOAD_IN_USE");
 }catch(error){
  if((error as Error).message==="DOWNLOAD_IN_USE")throw error;
  if((error as {code?:unknown}).code!==1)throw new Error("DOWNLOAD_TRASH_FAILED");
 }
 try{
  if(await fs.realpath(root)!==canonicalRoot||await fs.realpath(file)!==canonicalFile||localFileRevision(await fs.lstat(file,{bigint:true}))!==revision)throw new Error("DOWNLOAD_CHANGED");
  const result=await run('/usr/bin/osascript',['-l','JavaScript','-e',NATIVE_TRASH_SCRIPT,'--',canonicalFile,String(stat.ino),String(stat.size)],{timeout:15000,maxBuffer:8192});
  if(JSON.parse(result.stdout).ok!==true)throw new Error("DOWNLOAD_TRASH_FAILED");
 }catch(error){
  if((error as Error).message==="DOWNLOAD_CHANGED")throw error;
  try{await fs.lstat(file);}catch(check){if((check as NodeJS.ErrnoException).code==="ENOENT")throw new Error("DOWNLOAD_TRASH_UNCONFIRMED");}
  throw new Error("DOWNLOAD_TRASH_FAILED");
 }
}
