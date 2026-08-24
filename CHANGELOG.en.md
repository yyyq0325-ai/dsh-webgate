# Changelog

English | [中文](CHANGELOG.zh.md)

Every notable feature and fix lands here, **newest first**. See the [README](README_EN.md) for install and usage.

## 0.2.2 · 2026-08-24

Server-side enforcement: reverse-proxy config templates + a session verify endpoint.

### Added

- **`GET /auth/api/verify`**: reads the `webgate_token` Cookie planted at login and validates the session — `204` when valid, `401` when missing/invalid/expired. This matches nginx `auth_request` semantics exactly, so server-side enforcement works without a Basic Auth prompt
- **`deploy/nginx/` reverse-proxy templates**:
  - Option A `basic-auth.conf` — site-wide nginx Basic Auth gate + full reverse proxy (WebSocket / SSE tuned)
  - Option B `auth-request.conf` — `auth_request` wired to WebGate sessions; unauthenticated visitors are 302'd to `/login?next=…`
- README "Security notes" now points to both templates

### Notes

- WebGate sessions live in dsh process memory — restarting dsh invalidates every session; just sign in again via `/login`
- Config templates are not shipped in the npm package; grab them from this repository

## 0.2.1 · 2026-08-24

Fixes for "member still sees every workspace" on real installs.

### Fixed

- **URL-object inputs**: the app transport calls the guard as `doFetch(new URL(path, base))` — a `URL` instance has `.href` but no `.url`, so the request probe extracted an empty string and the `workspace.list` filter never fired. The probe now resolves `href`/`url` and matches pathnames via pure string parsing, without relying on the URL constructor
- **Basename grants**: grants are commonly written as a bare folder name (`park`) while `WorkspaceView.path` is absolute (`D:\code\park`); exact equality never matched. Matchers now also hit when the path ends with `<sep><matcher>`, in addition to full-path and title equality
- browsersim J-suite mirrors the real transport shape (URL-object input + basename grant) to lock both fixes in

## 0.2.0 · 2026-08-24 (experimental)

Account roles and workspace grants.

### Added

- **Two roles**: `admin` / `member`. The initial `admin` account is an administrator with full workspace and management powers; newly added users default to `member`
- **Member workspace grants**: `/grant <user> <workspace-path|title|*> <admin-password>` grants a member visibility of one workspace (matched by full path or title, case-insensitive); `*` means all. `/revoke <user> <path|title|*|all> <admin-password>` revokes; `*` / `all` clears every grant
- **Member UI trimming**: member sessions hide the settings entry, the workspace search button and list-header actions (including add-workspace); RPCs such as `settings.*`, `workspace.create`, `session.search` and `host.createDirectory` are rejected with a standard error envelope the UI surfaces gracefully
- **Permissions in auth responses**: `/auth/api/login` and `/auth/api/session` now return `perms` (role + workspace matchers) for client-side rendering

### Changed (breaking ⚠️)

- **Sudo-passphrase mode**: `/useradd`, `/passwd`, `/userdel`, `/grant` and `/revoke` all require an **admin account's password appended to the command**, otherwise they refuse to run. Adjust any scripts that automated these commands
- `/userlist` output now includes role and workspace-grant columns
- Grant changes immediately revoke that member's active sessions; new permissions apply after they sign in again

### Upgrade notes

- The user store auto-migrates to record v2: legacy records get their `role` / `workspaces` fields filled on first read
- ⚠️ Migration rule: the initial `admin` account keeps its role, while **every other existing user becomes a `member` with no workspace grants** — re-run `/grant` for them as needed
- Strength note: workspace filtering runs browser-side (the guard script wraps fetch). It prevents accidents, not deliberate circumvention; server-side enforcement still awaits an upstream gateway seam (see Security notes in the README)

## 0.1.2 · 2026-08-24

### Fixed

- 🔴 **Four "service unavailable" warnings on every boot**: `inject` declared only `timer`, so cordis executed `apply` before webServer/credentials/commands/tools activated and no route ever registered. All dependencies are now declared (`timer` / `webServer` / `credentials` / `commands` / `tools`); cordis parks the plugin until they are up. Note this cordis version only supports the flat-array form; on profiles without `webServer` (headless/tui) staying parked is expected
- The dynamic artifact (`dynamic/webgate.host.js`) hardcoded the old inject declaration; the build script now extracts it from source so both forms never drift

### Docs

- Forgot-password guide now warns: after emptying the `records:` section you must remove the `records:` line too (or write `records: {}`), otherwise writes fail with `Expected YAML collection at records`
- New troubleshooting section for all-pages 400/404 after installing/removing plugins (stale `@deepseek-ai/*` shadow copies inside the profile tree)

## 0.1.1 · 2026-08-24

### Changed

- Package scope moved from the non-existent `@yyyq0325-ai` org to the npm-account-backed **`@yyyq0325`**; uninstall command updated accordingly. The bare name `dsh-webgate` on the registry is an unrelated package — do not use it
- Added `publishConfig.access: public` and `prepublishOnly: npm test`

## 0.1.0 · 2026-08-24

First public release.

- Route-level login gate: a synchronous guard script injected into every `index.html`; unauthenticated visits redirect to a standalone login page at `/login` (plus `/auth/page`)
- 12-hour session tokens; 30-second client watchdog plus server re-check on visibility; sign-out/expiry never touches background tasks
- User management via `/useradd` `/passwd` `/userlist` `/userdel` and the `webgate_user_*` model tools
- User store persisted as a grant record in `$DSH_HOME/.credentials.yaml`; pure-JS PBKDF2-HMAC-SHA256 (20k iterations), zero dependencies
- Bilingual UI (Chinese default; API messages follow `Accept-Language`)
