const { app, BrowserWindow } = require("electron");
app.setPath("userData", process.env.FLYX_SEARCH_TEST_PROFILE);
app.whenReady().then(() => {
  const window = new BrowserWindow({ width: 1280, height: 900, show: false,
    webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  window.loadURL("about:blank");
});
app.on("window-all-closed", () => app.quit());
