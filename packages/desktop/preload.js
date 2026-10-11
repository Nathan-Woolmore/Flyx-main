/**
 * Flyx Desktop — Preload bridge.
 *
 * Tiny surface: identity, LAN URLs, restart/update events. All real data
 * (LAN URLs + QR codes, network mode) still comes from the web app's own
 * /api/network and /api/settings/network endpoints, so the UI works
 * unchanged on hosted deployments too.
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("flyxDesktop", {
  isDesktop: true,
  // Only this explicitly approved silent test package supplies the flag.
  silentPlaybackMode: process.argv.includes("--flyx-cast-test"),
  platform: process.platform,
  // Explicit, typed Cast operations only. Never expose ipcRenderer or a
  // raw socket/channel/namespace API to the renderer.
  cast: {
    discover: () => ipcRenderer.invoke("flyx:cast-discover"),
    cancelDiscovery: () => ipcRenderer.invoke("flyx:cast-cancel-discovery"),
    getState: () => ipcRenderer.invoke("flyx:cast-state"),
    connect: (receiver) => ipcRenderer.invoke("flyx:cast-connect", receiver),
    load: (media) => ipcRenderer.invoke("flyx:cast-load", media),
    control: (command) => ipcRenderer.invoke("flyx:cast-control", command),
    disconnect: () => ipcRenderer.invoke("flyx:cast-disconnect"),
    onState: (callback) => {
      const listener = (_event, state) => callback(state);
      ipcRenderer.on("flyx:cast-state", listener);
      return () => ipcRenderer.removeListener("flyx:cast-state", listener);
    },
  },
  getVersion: () => ipcRenderer.invoke("flyx:get-version"),
  getLANUrls: () => ipcRenderer.invoke("flyx:get-lan-urls"),
  getLocalUrl: () => ipcRenderer.invoke("flyx:get-local-url"),
  onServerRestarting: (cb) =>
    ipcRenderer.on("flyx:server-restarting", () => cb()),
  onServerReady: (cb) => ipcRenderer.on("flyx:server-ready", () => cb()),
  onUpdateDownloaded: (cb) =>
    ipcRenderer.on("flyx:update-downloaded", (_event, info) => cb(info)),
  // Manual GitHub-release updates (works for portable + installer).
  checkUpdates: () => ipcRenderer.invoke("flyx:check-updates"),
  downloadUpdate: () => ipcRenderer.invoke("flyx:download-update"),
  // Hand a host stream URL to VLC on this machine ({ url, title, startTime }).
  // Resolves { ok, method: "spawn" | "playlist", path?, error? }.
  openInVlc: (payload) => ipcRenderer.invoke("flyx:open-in-vlc", payload),
  onUpdateStatus: (cb) => {
    const listener = (_event, status) => cb(status);
    ipcRenderer.on("flyx:update-status", listener);
    return () => ipcRenderer.removeListener("flyx:update-status", listener);
  },
  // Window hidden to tray / shown again — the watch page pauses playback
  // and stops buffering while hidden, then resumes on show.
  onWindowHidden: (cb) => {
    const listener = () => cb();
    ipcRenderer.on("flyx:window-hidden", listener);
    return () => ipcRenderer.removeListener("flyx:window-hidden", listener);
  },
  onWindowShown: (cb) => {
    const listener = () => cb();
    ipcRenderer.on("flyx:window-shown", listener);
    return () => ipcRenderer.removeListener("flyx:window-shown", listener);
  },
});
