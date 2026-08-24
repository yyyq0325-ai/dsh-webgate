# WebGate — Login Gate for DeepSeek Harness Web

[中文说明](README.md)

Add a username/password gate to the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) web GUI: every visit to DSH Web requires a login first. Session tokens last **12 hours**, and when a token expires, **background tasks keep running** — log back in and everything is still there.

📋 Changelog (new features and breaking changes are recorded here): **[CHANGELOG.en.md](CHANGELOG.en.md)**

## Features

- 🔐 **Route-level login gate** — a synchronous guard script injected into every `index.html` via the `webserver/index-inject` event: missing or expired tokens trigger `location.replace('/login')` (a standalone bilingual login page); after sign-in you are redirected back. The guard hides the document synchronously, so app content never flashes
- ⏱ **12-hour session tokens** — absolute expiry; 30-second client watchdog plus server-side re-check when the page becomes visible again
- 🚀 **Zero impact on running tasks** — the gate only guards the browser view; host-side sessions, background jobs, and subagents run unaffected
- 🎨 **DeepSeek-style login page** — deep blue/purple gradient, glassmorphism card, brand-blue gradient button, whale badge SVG; standalone page at `/auth/page`
- 🛠 **User management commands** — `/useradd`, `/passwd`, `/userlist`, `/userdel` (passwords never hit the session log), plus `webgate_user_*` model tools so your agent can manage accounts
- 💾 **Persistent user store** — kept as a grant record inside `$DSH_HOME/.credentials.yaml`, restored automatically on plugin restart
- 🌐 **Bilingual (Chinese default)** — one-click 中文/EN toggle on the login card (remembered locally); English browsers switch automatically; API messages follow the request's `Accept-Language`
- 👥 **Roles & workspace grants (experimental)** — admin/member roles; members only see workspaces granted via `/grant`; mutating commands use an admin-password sudo model
- 🧩 **Zero dependencies** — single-file pure JavaScript; PBKDF2-HMAC-SHA256 (20k iterations) implemented in-repo for sandboxes without `node:crypto`, validated against standard test vectors

## Install

> ✅ Published on npm: **`@yyyq0325/dsh-webgate`** — npm is now the recommended channel (versioned, lockable, no Git dependency).
> ⚠️ The bare name `dsh-webgate` is an unrelated package; don't use it.

### Option A — npm (recommended)

```bash
dsh plugin --profile web add @yyyq0325/dsh-webgate
```

The CLI auto-mounts the plugin via the `dsh.bundle.patch` declaration in `package.json`; restart dsh to activate. Upgrades are the same command (or `npm update @yyyq0325/dsh-webgate` + restart).

### Option B — from GitHub

```bash
dsh plugin --profile web add github:yyyq0325-ai/dsh-webgate
```

Useful for trying the latest branch before an npm release (`#branch` supported).

### Option C — manual mount

Copy the insert row from [`cordis.patch.yml`](cordis.patch.yml) into your profile's patch file:

```yaml
- insert:
    - id: webgate
      name: '@yyyq0325/dsh-webgate'
```

### Option C — dynamic plugin (no install)

Paste the contents of [`dynamic/webgate.host.js`](dynamic/webgate.host.js) as `code.host` into `cordis_define`. The file is generated from `src/index.js` by `npm run build:dynamic`.

## Quick start

An initial admin account is bootstrapped on first activation:

```
username: admin
password: admin1234
```

Change it immediately after logging in:

```
/passwd admin <your-new-password>
```

UI language: use the 中文/EN link at the bottom of the login card; defaults to Chinese, English browsers switch automatically. The standalone `/auth/page` and all API messages are localized too (`Accept-Language`).

User management (**every mutating command requires an admin account's password at the end** — a sudo-passphrase model, so only someone who knows the admin password can change the account system):

| Command | Description |
|---|---|
| `/useradd <name> <pass> <admin-password>` | Add a member user (name: 2–32 chars `[A-Za-z0-9_.-]`; pass: 6–128 chars) |
| `/passwd <name> <new-pass> <admin-password>` | Change password; revokes that user's active sessions |
| `/userlist` | List users with role, workspace grants and active sessions |
| `/userdel <name> <admin-password>` | Delete a user (at least one admin must remain) |
| `/grant <name> <workspace-path\|title\|*> <admin-password>` | Grant a member visibility of one workspace; `*` = all |
| `/revoke <name> <workspace-path\|title\|*\|all> <admin-password>` | Revoke; `*`/`all` clears every grant |

## Roles & workspace permissions (v0.2.0 · experimental)

- **admin**: full access to all workspaces and management (the initial `admin` account).
- **member**: after sign-in only workspaces granted via `/grant` are visible (matched by full path or title, case-insensitive); other entries are filtered out client-side and their actions cannot be initiated from the UI.
- Permission changes immediately revoke that member's active sessions; new permissions apply on next sign-in.
- **UI trimming**: member sessions automatically hide the settings entry (sidebar foot), the workspace search button and the list-header actions (incl. add-workspace); restricted RPCs (`settings.*`, `workspace.create`, `session.search`, `host.createDirectory`) are rejected with a standard error envelope so the UI fails gracefully.
- ⚠️ Strength: all filtering/hiding runs in the browser (the guard script) — it is **mistake-proofing**, not adversarial protection. See [Security notes](#security-notes). Server-side enforcement requires upstream middleware/gateway hooks.

Health probe: `GET /auth/api/health`.

## Enable / disable / uninstall (lockout-safe guide)

> Tip: try the **dynamic-plugin mode** first; install permanently only after you are happy.

### Dynamic plugin mode (nothing persisted)

Paste the contents of [`dynamic/webgate.host.js`](dynamic/webgate.host.js) as `code.host` into `cordis_define`, then `cordis_run`. In this mode:

- **no configuration file is touched** — your profile patch file stays untouched;
- **the gate disappears automatically when the dsh process restarts**;
- the agent can stop it anytime with `cordis_stop <pluginId>` and the page returns to stock instantly (definitions are kept, one command re-enables).

### Disable/uninstall the installed package

```bash
dsh plugin --profile web remove @yyyq0325/dsh-webgate
```

### Disable/uninstall a manual patch row

In `~/.dsh/profiles/web/cordis.patch.yml`, add `disabled: true` to the row (keep config) or delete the row (full uninstall), then restart dsh.

### Forgot the password?

1. Open `$DSH_HOME/.credentials.yaml` (default `~/.dsh/.credentials.yaml`);
2. Delete the whole `webgate/users:` entry under `records:` (touch nothing else);
3. ⚠️ If no entries remain under `records:`, delete the `records:` line too (or rewrite it as `records: {}`). Leaving a valueless `records:` key makes YAML parse it as null, and the plugin will fail to write user records with `Expected YAML collection at records`;
4. Restart dsh — the plugin finds no users and bootstraps `admin / admin1234` again.

> The same file also holds your API keys; only remove the `webgate/users` block.

### Troubleshooting: every page returns 400/404 after installing or removing a plugin

**Symptom**: after adding or removing any plugin, the whole web UI breaks — `/` and `/index.html` answer with an empty-body 400 while every other path 404s; uninstalling the plugin and restarting dsh changes nothing.

**Cause**: some third-party plugins pin their peerDependencies to older `@deepseek-ai/*` versions. Installing inside the profile directory materializes those stale copies into `~/.dsh/profiles/web/node_modules/@deepseek-ai/`, and the cordis Loader resolves route plugins anchored at that directory — so a stale `@deepseek-ai/dsh-host-webserver` shadows the harness's own newer copy. The two versions disagree on API (the current frontend-static calls `renderIndex` on every index render, which does not exist on the old class), so every page throws.

**Fix**:

1. Exit dsh completely;
2. Move the stale shadow directory aside (delete it once things work again):

   ```powershell
   Rename-Item ~/.dsh/profiles/web/node_modules/@deepseek-ai _stale-deepseekai-backup
   ```

3. Start dsh again. Those packages now fall through the `$DSH_HOME/profiles/node_modules` symlinks back to the versions bundled with your dsh installation;
4. Once the pages recover, delete `_stale-deepseekai-backup`.

**Prevention**: install profile plugins only through `dsh plugin --profile web add <pkg>` (pnpm underneath, honoring `autoInstallPeers: false`); never run npm installs manually in the profile directory — npm auto-installs peer dependencies and reintroduces version drift.

## How it works

The plugin registers `/auth/api/*` routes (login / session / logout / health) on the harness web server and pushes a self-contained guard script into every served `index.html`. Passwords are stored as `PBKDF2-HMAC-SHA256` hashes with per-user random salts and compared in constant time. The user database is one credentials grant record (`webgate/users`) whose payload is a JSON *string* — primitives cross the dynamic-plugin sandbox boundary safely, unlike realm-specific plain objects.

All routes, listeners, commands, and tool registrations hang off the plugin fiber and are cleaned up automatically on stop/update.

## Security notes

This is an entry gate for a **local personal tool**, not enterprise security. The current "guard redirect" mode runs in the browser and **can be defeated with DevTools** (disable/delete the guard script) — after bypassing, the shell and the `/api` data channel remain reachable. Why:

1. DSH's `/api` data channel is registered on webServer as a named prefix route by `@deepseek-ai/dsh-client-connection`. Routes cannot be overridden once registered, longer-prefix routing prevents shadowing it, and webServer has no request-middleware seam — so a dynamic plugin **cannot enforce server-side auth on `/api`**. This is a hard limit of current Harness extension points, not a design choice here.
2. The server binds `127.0.0.1` by default. If you rebind to `0.0.0.0`, put an authenticating reverse proxy (Caddy/nginx Basic Auth) in front — that is the real enforcement point.
3. The initial admin password is public — change it first thing.
4. Tokens live in browser localStorage and host memory only; a host restart requires re-login. A `webgate_token` Cookie (SameSite=Lax) is also issued, ready for gateway-level checks if upstream adds such a seam.

## Development

```bash
npm test                 # crypto vectors + host logic (both forms) + browser sandbox smoke tests
npm run build:dynamic    # regenerate dynamic/webgate.host.js from src/index.js
```

No npm dependencies required to develop or test.

## License

[MIT](LICENSE)
