// The ACP browser boundary check serves static modules from its own HTTP listener.
// A page can retain an active HTTP socket even after the test's last assertion, especially in a
// runner-owned warm Chromium. Closing the server before the page waits on that socket forever.
export async function closeAcpFixture(page, server) {
  try {
    await page?.close();
  } finally {
    // A shared context can fail to dispose within its bound and leave a preconnect/request alive;
    // do not let server.close() depend on the browser successfully dropping every socket.
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}
