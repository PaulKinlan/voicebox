// The page's /live connection sends this credential on open. Direct-socket live fixtures
// must make the same claim before asking the model to mutate the workspace.
export async function authenticateLiveRoom(base, ws) {
  const page = await fetch(`${base}/`);
  if (!page.ok) throw new Error(`room HTML unavailable (${page.status})`);
  const token = /<meta name="voicebox-session-token" content="([0-9a-f]+)"/.exec(await page.text())?.[1];
  if (!token) throw new Error("room HTML did not carry the session token");
  return await new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      ws.removeEventListener("message", onMessage);
      ws.removeEventListener("close", onClose);
    };
    const onMessage = (event) => {
      let frame;
      try { frame = JSON.parse(event.data); } catch { return; }
      if (frame?.type !== "session_auth") return;
      cleanup();
      if (frame.ok) resolve();
      else reject(new Error("room session token refused"));
    };
    const onClose = () => { cleanup(); reject(new Error("/live closed before room authentication")); };
    ws.addEventListener("message", onMessage);
    ws.addEventListener("close", onClose);
    timer = setTimeout(() => { cleanup(); reject(new Error("no room authentication answer within 5s")); }, 5000);
    try { ws.send(JSON.stringify({ type: "session_auth", sessionToken: token })); }
    catch (error) { cleanup(); reject(error); }
  });
}
