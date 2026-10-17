// The ACP browser boundary check serves static modules from its own HTTP listener.
// A page can retain an active HTTP socket even after the test's last assertion, especially in a
// runner-owned warm Chromium. Closing the server before the page waits on that socket forever.
export async function closeAcpFixture(page, server) {
  try {
    await page?.close();
  } finally {
    // Stop accepting first, then sweep: a shared context can leave a preconnect/request alive,
    // and closing connections before close() would let a new one arrive between the two calls.
    const closed = new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    server.closeAllConnections();
    await closed;
  }
}
