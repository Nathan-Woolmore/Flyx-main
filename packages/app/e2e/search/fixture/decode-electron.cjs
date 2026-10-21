// A hidden isolated profile for generated silent video only. No Flyx preload, Cast or app hooks.
const { app, BrowserWindow } = require("electron");
app.setPath("userData", process.env.FLYX_DECODE_TEST_PROFILE);
app.whenReady().then(() => {
  const window = new BrowserWindow({
    width: 400,
    height: 300,
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  window.webContents.setAudioMuted(true);
  window.loadURL("about:blank");
});
app.on("window-all-closed", () => app.quit());
