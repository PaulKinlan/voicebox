// Reviewer instrumentation: forward native WebSocket construction to owned loopback.
// Preserve URL authentication/model parameters and header options; do not replace
// frames, native events, fetch, provider code, or process error handling.
const NativeSocket = globalThis.WebSocket;
globalThis.WebSocket = new Proxy(NativeSocket, {
  construct(target, args) {
    const upstream = new URL(args[0]);
    const provider = upstream.hostname === 'generativelanguage.googleapis.com' ? 'gemini'
      : upstream.hostname === 'api.openai.com' ? 'openai' : null;
    if (!provider) throw new Error('review fixture refuses an unowned vendor destination');
    const destination = new URL(process.env.FIXTURE_VENDOR);
    destination.pathname = `/vendor/${provider}`;
    destination.search = upstream.search;
    return Reflect.construct(target, [destination.href, ...args.slice(1)]);
  },
});
