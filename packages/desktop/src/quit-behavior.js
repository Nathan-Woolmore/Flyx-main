/** Keep user Quit requests in the background; explicit shutdown still exits. */
function installQuitBehavior({ app, shouldBackground, background, shutdown }) {
  app.on("before-quit", (event) => {
    if (shouldBackground()) {
      event.preventDefault();
      background();
      return;
    }
    shutdown();
  });
}

module.exports = { installQuitBehavior };
