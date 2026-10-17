declare module "yazl" {
  import { EventEmitter } from "node:events";
  import { Readable } from "node:stream";
  export class ZipFile extends EventEmitter {
    outputStream: Readable;
    addBuffer(
      buffer: Buffer,
      path: string,
      options?: { compress?: boolean; mtime?: Date; forceZip64Format?: boolean },
    ): void;
    addReadStreamLazy(
      path: string,
      options: { size?: number; compress?: boolean; mtime?: Date },
      callback: (done: (error: Error | null, stream?: Readable) => void) => void,
    ): void;
    end(options?: { forceZip64Format?: boolean }): void;
  }
}
