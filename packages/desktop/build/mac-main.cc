// Copyright (c) 2022 Slack Technologies, Inc.
// Adapted from Electron v43.4.0 shell/app/electron_main_mac.cc and uv_stdio_fix.cc.
// Electron's MIT license applies; see mac-main-LICENSE.txt.
// Rebuild the primary app executable so Apple ld assigns a distinct build UUID.
// This stays the app's own main executable: no exec wrapper, terminal, daemon,
// network helper, permission grant, or network-privacy exception is involved.
#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <sys/stat.h>
#include <unistd.h>

#ifndef FLYX_MAC_BUNDLE_ID
#error FLYX_MAC_BUNDLE_ID is required
#endif
#ifndef FLYX_MAC_VERSION
#error FLYX_MAC_VERSION is required
#endif
__attribute__((used)) static const char kFlyxProgramIdentity[] =
    FLYX_MAC_BUNDLE_ID ":" FLYX_MAC_VERSION;

extern "C" int ElectronMain(int argc, char* argv[]);
extern "C" int ElectronInitializeICUandStartNode(int argc, char* argv[]);
namespace electron::fuses { bool IsRunAsNodeEnabled(); }

static void FixStdioStreams() {
  struct stat st;
  if (fstat(STDIN_FILENO, &st) < 0 && errno == EBADF)
    (void)freopen("/dev/null", "r", stdin);
  if (fstat(STDOUT_FILENO, &st) < 0 && errno == EBADF)
    (void)freopen("/dev/null", "w", stdout);
  if (fstat(STDERR_FILENO, &st) < 0 && errno == EBADF)
    (void)freopen("/dev/null", "w", stderr);
}

int main(int argc, char* argv[]) {
  FixStdioStreams();
  const char* runAsNode = getenv("ELECTRON_RUN_AS_NODE");
  // Preserve the shipped framework's existing RunAsNode fuse check.
  if (electron::fuses::IsRunAsNodeEnabled() && runAsNode && *runAsNode)
    return ElectronInitializeICUandStartNode(argc, argv);
  return ElectronMain(argc, argv);
}
