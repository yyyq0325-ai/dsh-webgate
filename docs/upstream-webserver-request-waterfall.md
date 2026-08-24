# Upstream proposal — draft

> Intended for: [deepseek-harness/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) · **Type**: Feature request
> Suggested title: **`webServer`: request-level waterfall hook (enables transport middleware such as per-user auth gates)**
>
> 本文为中文使用者的英文提案草稿；提交时可整篇复制，或只取 Summary + Proposal。

---

## Summary

`@deepseek-ai/dsh-host-webserver` currently exposes three composition seams: named routes (`register`), a single fallback seat (`registerFallback`), and index transforms (`tapIndex`). All three are *registration-time* extension points. There is **no request-time seam** — once the dispatch loop picks a winner (exact table → longest prefix → fallback), the winning owner unconditionally handles the request.

This proposes one small, opt-in waterfall:

```ts
declare module '@deepseek-ai/cordis' {
  interface Events {
    /** Gate every HTTP request before routing. Fully respond and skip next()
     *  to short-circuit (auth redirects, maintenance pages, rate limits…).
     *  @mode waterfall */
    'webserver/request': (
      ctx: { req: IncomingMessage; res: ServerResponse; pathname: string },
      next: () => Promise<boolean>,   // resolves true once the normal router answered
    ) => Promise<boolean>
  }
}
```

Dispatch order becomes: fire the waterfall → any middleware that does **not** call `next()` owns the response; otherwise control falls through to the existing exact/prefix/fallback machinery, unchanged.

## Motivation (a concrete use case)

Sharing one harness instance with a small trusted group over a LAN/tunnel. A community plugin ([WebGate](https://github.com/yyyq0325-ai/dsh-webgate)) adds an account/password gate: login page, 12h session tokens, per-member workspace visibility, admin-password sudo for account management.

Everything works **except server-side enforcement**, because:

1. **`/api` is already claimed.** The data channel is registered by `@deepseek-ai/dsh-client-connection` as a named prefix route (`webServer.register({ kind: 'prefix', path: '/api', … })`, plus a sibling `registerUpgrade`). Route registration refuses duplicates by design, and longest-prefix-wins means shorter routes cannot shadow it — correctly so; two owners for one prefix cannot compose.
2. **No middleware seam.** The dispatch loop (`match()` → handler) consults no event, and there is no way for a third party to wrap another owner's handler. `tapIndex` runs at render time with no `IncomingMessage` context, so it cannot even tell who is asking.
3. **The wire has no identity.** `ClientRequest` is `{ type, rpcId, method, payload }` (`rpc.schema.js`) — no user/session field exists to key policy on, so even a hypothetical data-layer filter has nothing to filter *by*.

Net effect: an auth plugin can gate the *document* (redirect to `/login`) but any user with DevTools can delete the guard script — the shell boots and every `/api/*` RPC answers in full. For a local personal tool that is acceptable; the moment the instance faces a network, it is not.

## Why an event (and why this fits the framework)

The framework documentation positions waterfall events as the intended shape for interception/gateway logic (“用于实现拦截/网关逻辑”). What is missing is merely the **declaration at the transport layer**. The same survey found 112 declared Cordis events across the shipped `@deepseek-ai/*` packages; the closest candidates all fail:

| Candidate | Actual meaning | Why insufficient |
|---|---|---|
| `agent/request` / `-error` | waterfall over LLM call configuration | model requests, not HTTP/RPC |
| `tools/pre-execute` | deny/wrap model tool calls | agent tools, not browser RPC |
| `approval/request` | composed answerers for approvals | no HTTP context |
| `session/event` | post-commit log feed | append-only; enforcement impossible |
| `webserver/index-inject` | collect injection rows during render | fires without request context |
| `connection/reset` | browser-half reconnect notice | client-side only |

A `webserver/request` waterfall is the missing declaration, and matches how the codebase already models interception elsewhere (`tools/pre-execute`, `llm/stream`, `fs/write-intent`).

## Reference implementation sketch

In `WebServer`'s request dispatch (before `match()`):

```ts
const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
const listeners = ctx.listenerCount('webserver/request');   // fast path
let handled: boolean;
if (listeners === 0) {
  handled = await this.dispatch(req, res, pathname);        // today's code, untouched
} else {
  handled = await ctx.waterfall(
    'webserver/request',
    { req, res, pathname },
    async () => this.dispatch(req, res, pathname),
  );
}
```

Contract notes:

* Middleware receives the live `IncomingMessage`/`ServerResponse` pair (so cookies/headers are available for identity resolution) and **owns the response** if it skips `next()` — identical ownership rules to route handlers today, including SSE/long-lived responses.
* The seed `next()` is the existing router; returning its result keeps `handled` honest for diagnostics.
* Upgrade requests (`registerUpgrade`) are intentionally out of scope for this event — they negotiate separately and would warrant a symmetric `webserver/upgrade` waterfall later.
* Zero-cost fast path when no listener is registered, so single-user deployments pay nothing.

## What a plugin can build on it (already implemented, waiting for the seam)

[WebGate](https://github.com/yyyq0325-ai/dsh-webgate) ships today with everything except the enforcement point:

* Login page (`/login`) + PBKDF2-hashed accounts persisted in `$DSH_HOME/.credentials.yaml` grant records;
* 12h tokens issued at login and delivered both as `localStorage` state and a `webgate_token` cookie (`SameSite=Lax`);
* Per-user permission sets (`role`, workspace allow-list) returned by `/auth/api/login|session`;
* A browser guard that hides non-granted workspaces and rejects restricted RPCs client-side (explicitly documented as mistake-proofing, not security).

With the waterfall, the plugin's entire enforcement moves server-side in ~30 lines: resolve the cookie → look up token → member ⇒ filter `workspace.list` results and reject `settings.*` / `workspace.create` / `session.search` / `host.createDirectory` with a standard `{ ok:false, error:{ code:'bad-request', … } }` envelope (the error union already carries everything needed). Admins pass through untouched.

## Alternatives considered

| Option | Why it falls short |
|---|---|
| Reverse proxy (nginx/Caddy Basic Auth) | One coarse credential for the whole origin; cannot express per-user workspace visibility or app-aware denial. Fine as defense-in-depth, orthogonal to this proposal. |
| One harness instance per user | Clean isolation, but loses the shared-machine convenience that motivates multi-account use; operationally heavy at family/team scale. |
| Add identity fields to the RPC wire | Much larger blast radius (protocol + every carrier/client); also unnecessary if headers/cookies reach a middleware, which is precisely what this proposal enables. |
| Monkey-patching the running `webServer` instance from a plugin | Violates composition contracts, fragile across builds, and unavailable to npm-installed plugins. Rejected outright. |

## Open questions

1. Should the event also cover **404/no-owner** requests (proposal: yes — middleware sees them, `next()` runs today's fallback)?
2. Should a symmetric **`webserver/upgrade`** waterfall land together, or follow later once HTTP gating proves the shape?
3. Naming: `webserver/request` mirrors the package's existing `webserver/index-inject`; alternatives (`http/gate`, `gateway/dispatch`) welcome.

---

*Drafted in the context of the WebGate plugin (v0.2.0, branch `feat/workspace-permissions`): bilingual login page, role/workspace grants, sudo-passphrase account management — all currently enforced client-side solely because this seam is missing.*
