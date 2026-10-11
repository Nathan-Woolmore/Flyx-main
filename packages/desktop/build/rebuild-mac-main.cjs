"use strict";
const path = require("path");
const { execFileSync } = require("child_process");
const { Arch } = require("builder-util");

function rebuildMacMain(ctx, deps = {}) {
  if (ctx.electronPlatformName !== "darwin") return;
  const appInfo = ctx.packager.appInfo;
  const app = path.join(ctx.appOutDir, `${appInfo.productFilename}.app`);
  const binary = path.join(app, "Contents", "MacOS", appInfo.productFilename);
  const arch = typeof ctx.arch === "string" ? ctx.arch : Arch[ctx.arch];
  const archArgs = arch === "universal" ? ["-arch", "arm64", "-arch", "x86_64"]
    : arch === "arm64" ? ["-arch", "arm64"] : arch === "x64" ? ["-arch", "x86_64"] : null;
  if (!archArgs) throw new Error(`Unsupported Mac primary executable architecture: ${arch}`);
  if (!appInfo.id || !appInfo.version) throw new Error("Mac main build requires app ID and version.");
  const run = deps.execFile || execFileSync;
  run("/usr/bin/xcrun", ["clang++", "-std=c++17", "-O2", ...archArgs,
    "-mmacosx-version-min=12.0", `-DFLYX_MAC_BUNDLE_ID=${JSON.stringify(appInfo.id)}`,
    `-DFLYX_MAC_VERSION=${JSON.stringify(appInfo.version)}`,
    path.join(__dirname, "mac-main.cc"), "-F", path.join(app, "Contents", "Frameworks"),
    "-framework", "Electron Framework", "-Wl,-rpath,@executable_path/../Frameworks",
    "-Wl,-headerpad_max_install_names", "-o", binary], { stdio: "inherit" });
  console.log(`  • [after-pack] rebuilt primary executable for ${appInfo.id} (${arch})`);
}
module.exports = { rebuildMacMain };
