# WebGate — Login Gate for DeepSeek Harness Web

[中文说明](README.md)

Add a username/password gate to the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) web GUI: every visit to DSH Web requires a login first. Session tokens last **12 hours**, and when a token expires, **background tasks keep running** — log back in and everything is still there.

## Features

- 🔐 **Full-page login gate** — a synchronous guard script injected into every `index.html` via the `webserver/index-inject` event; an opaque overlay covers the app until you are authenticated (zero content flash)
- ⏱ **12-hour session tokens** — absolute expiry; 30-second client watchdog plus server-side re-check when the page becomes visible again
- 🚀 **Zero impact on running tasks** — the gate only guards the browser view; host-side sessions, background jobs, and subagents run unaffected
- 🎨 **DeepSeek-style login page** — deep blue/purple gradient, glassmorphism card, brand-blue gradient button, whale badge SVG; standalone page at `/auth/page`
- 🛠 **User management commands** — `/useradd`, `/passwd`, `/userlist`, `/userdel` (passwords never hit the session log), plus `webgate_user_*` model tools so your agent can manage accounts
- 💾 **Persistent user store** — kept as a grant record inside `$DSH_HOME/.credentials.yaml`, restored automatically on plugin restart
- 🌐 **Bilingual (Chinese default)** — one-click 中文/EN toggle on the login card (remembered locally); English browsers switch automatically; API messages follow the request's `Accept-Language`
- 🧩 **Zero dependencies** — single-file pure JavaScript; PBKDF2-HMAC-SHA256 (20k iterations) implemented in-repo for sandboxes without `node:crypto`, validated against standard test vectors

## Install

### Option A — official CLI (recommended)

```bash
dsh plugin --profile web add dsh-webgate
```

### Option B — manual mount

Copy the insert row from [`cordis.patch.yml`](cordis.patch.yml) into your profile's patch file:

```yaml
- insert:
    - id: webgate
      name: dsh-webgate
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

| Command | Description |
|---|---|
| `/useradd <name> <pass>` | Add a user (name: 2–32 chars `[A-Za-z0-9_.-]`; pass: 6–128 chars) |
| `/passwd <name> <new-pass>` | Change password; revokes that user's active sessions |
| `/userlist` | List users with creation time and active sessions |
| `/userdel <name>` | Delete a user (at least one must remain) |

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
dsh plugin --profile web remove dsh-webgate
```

### Disable/uninstall a manual patch row

In `~/.dsh/profiles/web/cordis.patch.yml`, add `disabled: true` to the row (keep config) or delete the row (full uninstall), then restart dsh.

### Forgot the password?

1. Open `$DSH_HOME/.credentials.yaml` (default `~/.dsh/.credentials.yaml`);
2. Delete the whole `webgate/users:` entry under `records:` (touch nothing else);
3. Restart dsh — the plugin finds no users and bootstraps `admin / admin1234` again.

> The same file also holds your API keys; only remove the `webgate/users` block.

## How it works

The plugin registers `/auth/api/*` routes (login / session / logout / health) on the harness web server and pushes a self-contained guard script into every served `index.html`. Passwords are stored as `PBKDF2-HMAC-SHA256` hashes with per-user random salts and compared in constant time. The user database is one credentials grant record (`webgate/users`) whose payload is a JSON *string* — primitives cross the dynamic-plugin sandbox boundary safely, unlike realm-specific plain objects.

All routes, listeners, commands, and tool registrations hang off the plugin fiber and are cleaned up automatically on stop/update.

## Security notes

This is an entry gate for a **local personal tool**, not enterprise security:

1. The gate covers the **web page entry point**. DSH's webServer has no general HTTP middleware layer, so local processes calling APIs directly bypass this authentication.
2. The server binds `127.0.0.1` by default. If you rebind to `0.0.0.0`, evaluate the risk and put an authenticating reverse proxy in front.
3. The initial admin password is public — change it first thing.
4. Tokens live in browser localStorage and host memory only; a host restart requires re-login.

## Development

```bash
npm test                 # crypto vectors + host logic (both forms) + browser sandbox smoke tests
npm run build:dynamic    # regenerate dynamic/webgate.host.js from src/index.js
```

No npm dependencies required to develop or test.

## License

[MIT](LICENSE)
