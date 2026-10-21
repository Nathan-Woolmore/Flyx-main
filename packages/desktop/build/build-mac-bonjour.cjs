"use strict";
const path = require("node:path");
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const { Arch } = require("builder-util");

function buildMacBonjour(ctx, deps = {}) {
  if (ctx.electronPlatformName !== "darwin") return;
  const arch = typeof ctx.arch === "string" ? ctx.arch : Arch[ctx.arch];
  const archArgs = arch === "universal" ? ["-arch", "arm64", "-arch", "x86_64"]
    : arch === "arm64" ? ["-arch", "arm64"] : arch === "x64" ? ["-arch", "x86_64"] : null;
  if (!archArgs) throw new Error(`Unsupported native Bonjour architecture: ${arch}`);
  const headers = deps.headers || process.env.FLYX_NODE_HEADERS || path.resolve(path.dirname(process.execPath), "..", "include", "node");
  if (!(deps.exists || fs.existsSync)(path.join(headers, "node_api.h"))) {
    throw new Error("Native Bonjour requires Node-API headers. Set FLYX_NODE_HEADERS to the Node include/node directory.");
  }
  const destination = path.join(ctx.appOutDir, `${ctx.packager.appInfo.productFilename}.app`, "Contents", "Resources", "native");
  (deps.mkdir || fs.mkdirSync)(destination, { recursive: true });
  (deps.execFile || execFileSync)("/usr/bin/xcrun", ["clang++", "-std=c++17", "-O2", ...archArgs,
    "-mmacosx-version-min=12.0", "-DNAPI_VERSION=8", "-shared", "-undefined", "dynamic_lookup", "-I", headers,
    path.join(__dirname, "mac-bonjour.cc"), "-lSystem", "-o", path.join(destination, "cast-bonjour.node")], { stdio: "inherit" });
  console.log(`  • [after-pack] built in-process native macOS Bonjour (${arch})`);
}
module.exports = { buildMacBonjour };
