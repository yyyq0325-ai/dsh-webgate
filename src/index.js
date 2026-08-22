/**
 * WebGate — DeepSeek Harness (DSH) Web 登录门禁插件（Host half）
 *
 * 每次打开 DSH Web 必须先账号密码登录；登录令牌有效期 12 小时。
 * 令牌过期只影响浏览器会话：Host 端正在运行的会话、后台任务与子代理
 * 完全不受影响，重新登录后一切仍在。
 *
 * 工作原理：
 *  - 通过 `webserver/index-inject` 事件向每个 index.html 注入同步门禁脚本
 *    （自包含工厂函数序列化后注入，未认证时全屏遮罩，零闪现）；
 *  - 注册 `/auth/api/*` 路由提供登录 / 会话校验 / 登出接口；
 *  - 用户库持久化在 `$DSH_HOME/.credentials.yaml` 的 grant record 中
 *    （payload 为 JSON 字符串，跨 realm 安全）；
 *  - 注册 `/useradd`、`/passwd`、`/userlist`、`/userdel` 斜杠命令与
 *    `webgate_user_*` 模型工具管理用户。
 *
 * 零依赖：动态沙箱内没有 node:crypto，密码哈希使用内置纯 JS
 * PBKDF2-HMAC-SHA256 实现（已通过标准测试向量验证）。
 *
 * @module dsh-webgate
 */

export const name = 'webgate'
export const inject = ['timer']

const STORE_KEY = 'webgate/users' // credentials grant record：<scope>/<id>
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000 // 12 小时绝对有效期
const PBKDF2_ITER = 20000
const INITIAL_USER = 'admin'
const INITIAL_PASS = 'admin1234'

export function apply(ctx) {
  const creds = ctx.get('credentials')
  const web = ctx.get('webServer')
  const commandsSvc = ctx.get('commands')
  const toolsSvc = ctx.get('tools')

  if (!creds) console.error('[webgate] credentials 服务不可用：将退化为内存模式（重启后需重新创建用户）')
  if (!web) console.error('[webgate] webServer 服务不可用：登录门禁不会生效')
  if (!commandsSvc) console.error('[webgate] commands 服务不可用：/useradd 等命令不可用')
  if (!toolsSvc) console.error('[webgate] tools 服务不可用：模型工具不会注册')

  // ---------- 纯 JS SHA-256 / HMAC-SHA256 / PBKDF2（动态沙箱无 node:crypto） ----------
  const K256 = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ]
  function rotr(x, n) { return ((x >>> n) | (x << (32 - n))) >>> 0 }
  function sha256Bytes(data) {
    const l = data.length
    const bitLenHi = Math.floor(l / 536870912)
    const bitLenLo = (l << 3) >>> 0
    const total = Math.ceil((l + 9) / 64) * 64
    const m = new Uint8Array(total)
    m.set(data)
    m[l] = 0x80
    m[total - 8] = (bitLenHi >>> 24) & 255
    m[total - 7] = (bitLenHi >>> 16) & 255
    m[total - 6] = (bitLenHi >>> 8) & 255
    m[total - 5] = bitLenHi & 255
    m[total - 4] = (bitLenLo >>> 24) & 255
    m[total - 3] = (bitLenLo >>> 16) & 255
    m[total - 2] = (bitLenLo >>> 8) & 255
    m[total - 1] = bitLenLo & 255
    const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
    const w = new Array(64)
    for (let off = 0; off < total; off += 64) {
      for (let i = 0; i < 16; i++) {
        const j = off + i * 4
        w[i] = ((m[j] << 24) | (m[j + 1] << 16) | (m[j + 2] << 8) | m[j + 3]) | 0
      }
      for (let i = 16; i < 64; i++) {
        const a = w[i - 15], b = w[i - 2]
        const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3)
        const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10)
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0
      }
      let h0 = H[0], h1 = H[1], h2 = H[2], h3 = H[3], h4 = H[4], h5 = H[5], h6 = H[6], h7 = H[7]
      for (let i = 0; i < 64; i++) {
        const S1 = rotr(h4, 6) ^ rotr(h4, 11) ^ rotr(h4, 25)
        const ch = (h4 & h5) ^ (~h4 & h6)
        const t1 = (h7 + S1 + ch + K256[i] + w[i]) | 0
        const S0 = rotr(h0, 2) ^ rotr(h0, 13) ^ rotr(h0, 22)
        const maj = (h0 & h1) ^ (h0 & h2) ^ (h1 & h2)
        const t2 = (S0 + maj) | 0
        h7 = h6; h6 = h5; h5 = h4; h4 = (h3 + t1) | 0
        h3 = h2; h2 = h1; h1 = h0; h0 = (t1 + t2) | 0
      }
      H[0] = (H[0] + h0) | 0; H[1] = (H[1] + h1) | 0; H[2] = (H[2] + h2) | 0; H[3] = (H[3] + h3) | 0
      H[4] = (H[4] + h4) | 0; H[5] = (H[5] + h5) | 0; H[6] = (H[6] + h6) | 0; H[7] = (H[7] + h7) | 0
    }
    const out = new Uint8Array(32)
    for (let i = 0; i < 8; i++) {
      out[i * 4] = (H[i] >>> 24) & 255
      out[i * 4 + 1] = (H[i] >>> 16) & 255
      out[i * 4 + 2] = (H[i] >>> 8) & 255
      out[i * 4 + 3] = H[i] & 255
    }
    return out
  }
  function concatBytes(a, b) {
    const o = new Uint8Array(a.length + b.length)
    o.set(a); o.set(b, a.length)
    return o
  }
  function hmacSha256(key, msg) {
    const k = key.length > 64 ? sha256Bytes(key) : key
    const pad = new Uint8Array(64)
    pad.set(k)
    const inner = new Uint8Array(64), outer = new Uint8Array(64)
    for (let i = 0; i < 64; i++) { inner[i] = pad[i] ^ 0x36; outer[i] = pad[i] ^ 0x5c }
    return sha256Bytes(concatBytes(outer, sha256Bytes(concatBytes(inner, msg))))
  }
  function pbkdf2Sha256(password, salt, iterations, dkLen) {
    const blocks = Math.ceil(dkLen / 32)
    const out = new Uint8Array(blocks * 32)
    for (let b = 1; b <= blocks; b++) {
      const ib = [(b >>> 24) & 255, (b >>> 16) & 255, (b >>> 8) & 255, b & 255]
      let u = hmacSha256(password, concatBytes(salt, new Uint8Array(ib)))
      const acc = Uint8Array.from(u)
      for (let i = 1; i < iterations; i++) {
        u = hmacSha256(password, u)
        for (let j = 0; j < 32; j++) acc[j] ^= u[j]
      }
      out.set(acc, (b - 1) * 32)
    }
    return out.subarray(0, dkLen)
  }

  // ---------- 编码小工具 ----------
  const utf8 = new TextEncoder()
  function bytesToB64(u8) { let s = ''; for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]); return btoa(s) }
  function randomHex(nBytes) {
    let s = ''
    for (let i = 0; i < nBytes; i++) { const v = Math.floor(Math.random() * 256); s += (v < 16 ? '0' : '') + v.toString(16) }
    return s
  }
  function hexToBytes(hexStr) {
    const o = new Uint8Array(hexStr.length / 2)
    for (let i = 0; i < o.length; i++) o[i] = parseInt(hexStr.substr(i * 2, 2), 16)
    return o
  }
  function sha256Hex(str) {
    const d = sha256Bytes(utf8.encode(str)); let s = ''
    for (let i = 0; i < d.length; i++) s += (d[i] < 16 ? '0' : '') + d[i].toString(16)
    return s
  }
  function hashPassword(pass, saltHex, iter) {
    return bytesToB64(pbkdf2Sha256(utf8.encode(String(pass)), hexToBytes(saltHex), iter, 32))
  }
  function constantTimeEqual(a, b) {
    a = String(a); b = String(b)
    let diff = a.length === b.length ? 0 : 1
    const n = Math.max(a.length, b.length)
    for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0)
    return diff === 0
  }

  // ---------- 用户存储（credentials grant record，持久化于 $DSH_HOME/.credentials.yaml） ----------
  let usersCache = null // { username: {hash, salt, iter, createdAt} }
  const diag = { credsFound: !!creds, webFound: !!web, commandsFound: !!commandsSvc, lastPersistError: '', persistCount: 0 }
  function parseUsersRecord(rec) {
    // payload 存的是 JSON 字符串（跨 realm 安全）；兼容旧的直接对象形态
    if (!rec || rec.kind !== 'grant') return null
    let p = rec.payload
    if (typeof p === 'string') {
      try { p = JSON.parse(p) } catch (e) { return null }
    }
    if (p && typeof p === 'object' && p.users && typeof p.users === 'object' && !Array.isArray(p.users)) {
      return p.users
    }
    return null
  }
  function loadUsers() {
    if (!creds) { if (!usersCache) usersCache = {}; return Promise.resolve() }
    return creds.readRecord(STORE_KEY).then(function (rec) {
      const u = parseUsersRecord(rec)
      if (u) usersCache = u
      else if (!usersCache) usersCache = {}
    }).catch(function (e) {
      console.error('[webgate] 读取用户记录失败：' + ((e && e.message) || e))
      if (!usersCache) usersCache = {}
    })
  }
  function persistUsers() {
    if (!creds) return Promise.resolve()
    // 关键：payload 必须是纯字符串。动态沙箱内创建的对象原型与宿主不同，
    // 宿主侧 assertJsonValue 会拒绝；字符串是原始值，可安全跨越边界。
    return creds.modifyRecord(STORE_KEY, function () {
      return { kind: 'grant', payload: JSON.stringify({ version: 1, users: usersCache }) }
    }).then(function () {
      diag.persistCount++
      diag.lastPersistError = ''
    }).catch(function (e) {
      diag.lastPersistError = String((e && e.message) || e)
      throw e
    })
  }
  ctx.on('credentials/record-updated', function (key) {
    if (String(key) === STORE_KEY) loadUsers()
  })

  // ---------- 会话令牌（内存态；12 小时绝对有效期，过期即失效） ----------
  const tokens = Object.create(null) // token -> {user, exp}
  let seq = 0
  function issueToken(user) {
    sweepTokens()
    const t = sha256Hex('webgate:' + Date.now() + ':' + (++seq) + ':' + Math.random() + ':' + Math.random() + ':' + randomHex(16))
    tokens[t] = { user, exp: Date.now() + TOKEN_TTL_MS }
    return t
  }
  function sweepTokens() {
    const keys = Object.keys(tokens)
    if (keys.length < 512) return
    const now = Date.now()
    for (const k of keys) { if (tokens[k].exp <= now) delete tokens[k] }
  }
  function revokeUserTokens(user) {
    for (const k of Object.keys(tokens)) { if (tokens[k].user === user) delete tokens[k] }
  }

  // ---------- HTTP 小工具 ----------
  function sendJson(res, status, obj) {
    try {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify(obj))
    } catch (e) { /* 连接可能已断开 */ }
  }
  function readJsonBody(req) {
    return new Promise(function (resolve) {
      const dec = new TextDecoder()
      let s = ''
      req.on('data', function (c) { try { s += dec.decode(c, { stream: true }) } catch (e) { } })
      req.on('end', function () {
        try { s += dec.decode() } catch (e) { }
        let o = {}
        try { o = JSON.parse(s || '{}') } catch (e) { }
        resolve(o && typeof o === 'object' ? o : {})
      })
      req.on('error', function () { resolve({}) })
    })
  }
  function delay(ms) { return ctx.timeout(ms) }

  // ---------- 用户管理核心（命令与模型工具共用） ----------
  function validateUsername(u) {
    if (!/^[A-Za-z0-9_.-]{2,32}$/.test(u)) return '用户名需为 2-32 位字母、数字、点、下划线或短横线'
    return null
  }
  function validatePassword(p) {
    if (typeof p !== 'string' || p.length < 6 || p.length > 128) return '密码长度需为 6-128 位'
    return null
  }
  function addUserCore(username, password) {
    const u = String(username || '').trim()
    const err = validateUsername(u) || validatePassword(password)
    if (err) return Promise.resolve({ ok: false, message: err })
    if (!usersCache) return Promise.resolve({ ok: false, message: '用户库尚未初始化，请稍后再试' })
    if (usersCache[u]) return Promise.resolve({ ok: false, message: '用户「' + u + '」已存在' })
    const salt = randomHex(16)
    usersCache[u] = { hash: hashPassword(password, salt, PBKDF2_ITER), salt, iter: PBKDF2_ITER, createdAt: new Date().toISOString() }
    return persistUsers().then(function () {
      console.log('[webgate] 已添加用户: ' + u)
      return { ok: true, message: '用户「' + u + '」添加成功' }
    }).catch(function (e) {
      delete usersCache[u]
      console.error('[webgate] 写入用户失败：' + ((e && e.message) || e))
      return { ok: false, message: '写入用户库失败（详见 Host 日志）' }
    })
  }
  function passwdCore(username, password) {
    const u = String(username || '').trim()
    const err = validateUsername(u) || validatePassword(password)
    if (err) return Promise.resolve({ ok: false, message: err })
    if (!usersCache || !usersCache[u]) return Promise.resolve({ ok: false, message: '用户「' + u + '」不存在' })
    const salt = randomHex(16)
    const prev = usersCache[u]
    usersCache[u] = { hash: hashPassword(password, salt, PBKDF2_ITER), salt, iter: PBKDF2_ITER, createdAt: prev.createdAt }
    return persistUsers().then(function () {
      revokeUserTokens(u)
      console.log('[webgate] 已修改用户密码: ' + u)
      return { ok: true, message: '用户「' + u + '」密码已修改，该用户现有登录会话已全部失效' }
    }).catch(function (e) {
      usersCache[u] = prev
      console.error('[webgate] 密码写入失败：' + ((e && e.message) || e))
      return { ok: false, message: '写入用户库失败（详见 Host 日志）' }
    })
  }
  function delUserCore(username) {
    const u = String(username || '').trim()
    if (!usersCache || !usersCache[u]) return Promise.resolve({ ok: false, message: '用户「' + u + '」不存在' })
    if (Object.keys(usersCache).length <= 1) return Promise.resolve({ ok: false, message: '至少需要保留一个用户' })
    const prev = usersCache[u]
    delete usersCache[u]
    return persistUsers().then(function () {
      revokeUserTokens(u)
      return { ok: true, message: '用户「' + u + '」已删除' }
    }).catch(function (e) {
      usersCache[u] = prev
      console.error('[webgate] 删除用户写入失败：' + ((e && e.message) || e))
      return { ok: false, message: '写入用户库失败（详见 Host 日志）' }
    })
  }
  function listUsersCore() {
    if (!usersCache) return []
    const activeByUser = {}
    Object.keys(tokens).forEach(function (t) {
      const u = tokens[t].user
      activeByUser[u] = (activeByUser[u] || 0) + 1
    })
    return Object.keys(usersCache).map(function (u) {
      return { username: u, createdAt: usersCache[u].createdAt || '', activeSessions: activeByUser[u] || 0 }
    })
  }

  // ---------- 门禁前端（自包含工厂函数，序列化后注入浏览器；不得引用外层闭包） ----------
  // MODE = 'overlay'：注入每个 index.html，未认证时全屏遮罩；MODE = 'page'：独立登录页。
  const gateFactory = function (GATE_CSS, LOGO_SVG, MODE) {
    'use strict'
    const K = 'dshWebgate'
    function lg(k) { try { return window.localStorage.getItem(K + '.' + k) } catch (e) { return null } }
    function sv(k, v) { try { window.localStorage.setItem(K + '.' + k, String(v)) } catch (e) { } }
    function rmv(k) { try { window.localStorage.removeItem(K + '.' + k) } catch (e) { } }

    const st = document.createElement('style')
    st.textContent = GATE_CSS
    ;(document.head || document.documentElement).appendChild(st)

    function api(path, body) {
      return fetch('/auth/api/' + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {})
      }).then(function (r) { return r.json() })
    }
    function cardHtml(state) {
      if (state === 'verify') {
        return '<div class="wg-card wg-center"><span class="wg-spin wg-spin-lg"></span><div class="wg-wait">正在验证登录会话…</div></div>'
      }
      if (state === 'offline') {
        return '<div class="wg-card wg-center"><div class="wg-wait">无法连接认证服务</div><button type="button" class="wg-retry">重试</button></div>'
      }
      return '<div class="wg-card">'
        + '<div class="wg-logo">' + LOGO_SVG + '<span class="wg-title">DeepSeek</span></div>'
        + '<div class="wg-sub">Harness 控制台 · 账号登录</div>'
        + '<label class="wg-label" for="wg-user">用户名</label>'
        + '<input id="wg-user" class="wg-input" autocomplete="username" spellcheck="false" />'
        + '<label class="wg-label" for="wg-pass">密码</label>'
        + '<input id="wg-pass" class="wg-input" type="password" autocomplete="current-password" />'
        + '<button type="button" class="wg-btn" id="wg-go">登 录</button>'
        + '<div class="wg-err"></div>'
        + '<div class="wg-foot">登录会话有效期 12 小时<br />后台任务持续运行，不受登出影响</div>'
        + '</div>'
    }
    function bindLoginForm(container, onSuccess) {
      const btn = container.querySelector('#wg-go')
      const u = container.querySelector('#wg-user')
      const p = container.querySelector('#wg-pass')
      function setErr(t) {
        const e = container.querySelector('.wg-err')
        if (e) e.textContent = t || ''
        const c = container.querySelector('.wg-card')
        if (c && t) { c.classList.remove('wg-shake'); void c.offsetWidth; c.classList.add('wg-shake') }
      }
      function go() {
        const uv = (u.value || '').trim(), pv = p.value || ''
        if (!uv || !pv) { setErr('请输入用户名和密码'); return }
        btn.disabled = true
        btn.innerHTML = '<span class="wg-spin"></span> 登录中…'
        api('login', { username: uv, password: pv }).then(function (d) {
          if (d && d.ok && d.token) onSuccess(d)
          else { btn.disabled = false; btn.textContent = '登 录'; setErr((d && d.message) || '登录失败') }
        }).catch(function () {
          btn.disabled = false; btn.textContent = '登 录'; setErr('网络错误，请重试')
        })
      }
      btn.addEventListener('click', go)
      p.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') go() })
      u.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') p.focus() })
      setTimeout(function () { try { u.focus() } catch (e) { } }, 60)
      return setErr
    }

    if (MODE === 'page') {
      document.body.setAttribute('style', 'margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0b1023')
      const pg = document.createElement('div')
      pg.id = 'wg-gate'
      pg.innerHTML = cardHtml()
      document.body.appendChild(pg)
      bindLoginForm(pg, function (d) {
        sv('token', d.token); sv('exp', d.expiresAt)
        location.href = '/'
      })
      return
    }

    // ---- overlay 模式 ----
    const root = document.createElement('div')
    root.id = 'wg-gate'
    document.documentElement.appendChild(root)
    document.documentElement.style.overflow = 'hidden'

    let watchTimer = null
    function stopWatch() { if (watchTimer) { clearInterval(watchTimer); watchTimer = null } }
    function hideChip() { const old = document.querySelector('.wg-chip'); if (old) old.remove() }
    function showChip(user, exp) {
      hideChip()
      const c = document.createElement('button')
      c.className = 'wg-chip'
      c.type = 'button'
      c.setAttribute('title', 'WebGate 会话')
      c.textContent = '🔒 ' + user + ' · 剩余约 ' + Math.max(0, Math.round((exp - Date.now()) / 3600000)) + ' 小时 · 退出'
      c.addEventListener('click', function () { doLogout(false) })
      document.documentElement.appendChild(c)
    }
    function doLogout(local) {
      stopWatch(); hideChip()
      const t = lg('token')
      rmv('token'); rmv('exp')
      if (!local && t) {
        try {
          fetch('/auth/api/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: t }) })
        } catch (e) { }
      }
      location.reload()
    }
    function startWatch(user, exp) {
      stopWatch()
      watchTimer = setInterval(function () {
        const e = parseInt(lg('exp'), 10)
        if (!e || Date.now() > e - 2000) doLogout(true)
      }, 30000)
      showChip(user, exp)
    }
    function showLogin(msg) {
      root.innerHTML = cardHtml()
      const setErr = bindLoginForm(root, function (d) { sv('token', d.token); sv('exp', d.expiresAt); location.reload() })
      if (msg) setErr(msg)
    }
    function start() {
      const t = lg('token')
      if (!t) { showLogin(); return }
      root.innerHTML = cardHtml('verify')
      api('session', { token: t }).then(function (d) {
        if (d && d.ok && d.valid && d.username) {
          root.style.display = 'none'
          document.documentElement.style.overflow = ''
          startWatch(d.username, d.expiresAt)
        } else {
          rmv('token'); rmv('exp')
          showLogin('')
        }
      }).catch(function () {
        root.innerHTML = cardHtml('offline')
        const r = root.querySelector('.wg-retry')
        if (r) r.addEventListener('click', start)
      })
    }
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && lg('token')) start()
    })
    start()
  }

  // ---------- 注册路由与页面注入 ----------
  if (web) {
    const GATE_CSS = [
      '#wg-gate{position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;font-family:"Segoe UI",system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;background:radial-gradient(1100px 700px at 75% -10%,rgba(77,107,254,.30),transparent 60%),radial-gradient(900px 650px at -10% 110%,rgba(122,92,255,.20),transparent 55%),linear-gradient(160deg,#0b1023 0%,#111a3d 55%,#0c1230 100%);color:#e8ecf8}',
      '#wg-gate .wg-card{width:370px;max-width:calc(100vw - 40px);padding:38px 36px 26px;border-radius:20px;background:rgba(255,255,255,.055);border:1px solid rgba(255,255,255,.09);box-shadow:0 24px 80px rgba(0,0,0,.45);backdrop-filter:blur(14px)}',
      '#wg-gate .wg-logo{display:flex;align-items:center;justify-content:center;gap:11px;margin-bottom:4px}',
      '#wg-gate .wg-title{font-size:23px;font-weight:700;color:#fff;letter-spacing:.2px}',
      '#wg-gate .wg-sub{text-align:center;font-size:13px;color:#93a0c4;margin:6px 0 24px}',
      '#wg-gate .wg-label{display:block;font-size:12px;color:#aab4d4;margin:14px 0 6px}',
      '#wg-gate .wg-input{box-sizing:border-box;width:100%;height:44px;padding:0 14px;border-radius:10px;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.06);color:#fff;font-size:14px;outline:none;transition:border-color .15s,box-shadow .15s,background .15s;font-family:inherit}',
      '#wg-gate .wg-input:focus{border-color:#4d6bfe;background:rgba(255,255,255,.09);box-shadow:0 0 0 3px rgba(77,107,254,.25)}',
      '#wg-gate .wg-btn{margin-top:24px;width:100%;height:44px;border:none;border-radius:10px;background:linear-gradient(135deg,#4d6bfe,#7a5cff);color:#fff;font-size:15px;font-weight:600;cursor:pointer;transition:transform .15s,box-shadow .15s,opacity .15s;display:flex;align-items:center;justify-content:center;gap:8px;font-family:inherit}',
      '#wg-gate .wg-btn:hover{transform:translateY(-1px);box-shadow:0 10px 24px rgba(77,107,254,.35)}',
      '#wg-gate .wg-btn:disabled{opacity:.65;cursor:not-allowed;transform:none}',
      '#wg-gate .wg-err{min-height:18px;margin-top:12px;text-align:center;font-size:12.5px;color:#ff8080}',
      '#wg-gate .wg-foot{margin-top:14px;text-align:center;font-size:11.5px;color:#6c7899;line-height:1.8}',
      '#wg-gate .wg-wait{margin-top:18px;text-align:center;font-size:13px;color:#93a0c4}',
      '#wg-gate .wg-spin{width:15px;height:15px;border-radius:50%;border:2px solid rgba(255,255,255,.3);border-top-color:#fff;animation:wgRot .8s linear infinite;display:inline-block}',
      '#wg-gate .wg-spin-lg{width:34px;height:34px;border-width:3px}',
      '#wg-gate .wg-center{display:flex;flex-direction:column;align-items:center;padding:46px 52px}',
      '#wg-gate .wg-retry{margin-top:18px;padding:8px 26px;border-radius:9px;border:1px solid rgba(77,107,254,.6);background:transparent;color:#9db1ff;font-size:13px;cursor:pointer;font-family:inherit}',
      '#wg-gate .wg-retry:hover{background:rgba(77,107,254,.15)}',
      '.wg-chip{position:fixed;right:14px;bottom:14px;z-index:2147483647;display:flex;align-items:center;height:30px;padding:0 13px;border-radius:15px;background:rgba(13,19,48,.88);border:1px solid rgba(255,255,255,.12);color:#aab4d4;font-size:12px;cursor:pointer;opacity:.4;transition:opacity .15s;font-family:inherit}',
      '.wg-chip:hover{opacity:1}',
      '@keyframes wgShake{0%,100%{transform:translateX(0)}20%{transform:translateX(-7px)}40%{transform:translateX(7px)}60%{transform:translateX(-4px)}80%{transform:translateX(4px)}}',
      '@keyframes wgRot{to{transform:rotate(360deg)}}',
      '.wg-shake{animation:wgShake .38s ease}'
    ].join('\n')

    const LOGO_SVG = '<svg width="34" height="34" viewBox="0 0 48 48" aria-hidden="true"><defs><linearGradient id="wgg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4d6bfe"/><stop offset="1" stop-color="#7a5cff"/></linearGradient></defs><path fill="url(#wgg)" d="M5 27C5 17.6 12.8 11 23 11c7.6 0 13.9 4 16.4 10.2l4.1-1.9-1.8 9.3c.2 1 .3 2 .3 3.1h-6.6c-2.3 3.9-7 6.3-12.4 6.3C13.6 38 5 33.6 5 27z"/><circle cx="32.2" cy="22.5" r="1.9" fill="#0b1023"/></svg>'

    // 结构化 index 注入：每次渲染 index.html 时都会触发本监听并读取当前行
    ctx.on('webserver/index-inject', function (table) {
      table.push({
        kind: 'script',
        placement: 'head',
        text: '(' + gateFactory.toString() + ')(' + JSON.stringify(GATE_CSS) + ',' + JSON.stringify(LOGO_SVG) + ',"overlay");'
      })
    })

    // 独立登录页（直接访问 /auth/page 时使用）
    ctx.effect(function () {
      return web.register({
        kind: 'exact', path: '/auth/page',
        handler: async function (req, res) {
          try {
            const html = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"/>'
              + '<meta name="viewport" content="width=device-width,initial-scale=1"/>'
              + '<title>DeepSeek Harness · 登录</title></head><body>'
              + '<scr' + 'ipt>(' + gateFactory.toString() + ')(' + JSON.stringify(GATE_CSS) + ',' + JSON.stringify(LOGO_SVG) + ',"page");</scr' + 'ipt>'
              + '</body></html>'
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
            res.end(html)
          } catch (e) { sendJson(res, 500, { ok: false, message: 'render failed' }) }
        }
      })
    })

    // 运行诊断
    ctx.effect(function () {
      return web.register({
        kind: 'exact', path: '/auth/api/health',
        handler: async function (req, res) {
          sendJson(res, 200, {
            ok: true,
            credsFound: diag.credsFound,
            webFound: diag.webFound,
            commandsFound: diag.commandsFound,
            userCount: usersCache ? Object.keys(usersCache).length : -1,
            persistCount: diag.persistCount,
            lastPersistError: diag.lastPersistError
          })
        }
      })
    })

    // 认证 API
    ctx.effect(function () {
      return web.register({
        kind: 'exact', path: '/auth/api/login',
        handler: async function (req, res) {
          if (req.method !== 'POST') return sendJson(res, 405, { ok: false, message: 'method not allowed' })
          const b = await readJsonBody(req)
          const u = String(b.username || '').trim(), p = typeof b.password === 'string' ? b.password : ''
          if (!u || !p) return sendJson(res, 200, { ok: false, message: '请输入用户名和密码' })
          if (!usersCache || Object.keys(usersCache).length === 0) return sendJson(res, 200, { ok: false, message: '认证服务初始化中，请稍后再试' })
          const rec = usersCache[u]
          let ok = false
          if (rec && rec.salt && rec.hash) ok = constantTimeEqual(hashPassword(p, rec.salt, rec.iter || PBKDF2_ITER), rec.hash)
          if (!ok) { await delay(900); return sendJson(res, 200, { ok: false, message: '用户名或密码错误' }) }
          const tok = issueToken(u)
          console.log('[webgate] 用户登录成功: ' + u)
          sendJson(res, 200, { ok: true, token: tok, expiresAt: tokens[tok].exp, username: u })
        }
      })
    })
    ctx.effect(function () {
      return web.register({
        kind: 'exact', path: '/auth/api/session',
        handler: async function (req, res) {
          if (req.method !== 'POST') return sendJson(res, 405, { ok: false, message: 'method not allowed' })
          const b = await readJsonBody(req)
          const t = String(b.token || '')
          const e = tokens[t]
          if (e && e.exp > Date.now()) return sendJson(res, 200, { ok: true, valid: true, username: e.user, expiresAt: e.exp })
          if (e) delete tokens[t]
          sendJson(res, 200, { ok: true, valid: false })
        }
      })
    })
    ctx.effect(function () {
      return web.register({
        kind: 'exact', path: '/auth/api/logout',
        handler: async function (req, res) {
          if (req.method !== 'POST') return sendJson(res, 405, { ok: false, message: 'method not allowed' })
          const b = await readJsonBody(req)
          delete tokens[String(b.token || '')]
          sendJson(res, 200, { ok: true })
        }
      })
    })
  }

  // ---------- 斜杠命令（输入框里的“终端命令”） ----------
  function okRes(text) { return { kind: 'success', text } }
  function errRes(text) { return { kind: 'error', text } }
  if (commandsSvc) {
    ctx.effect(function () {
      return commandsSvc.register({
        name: 'useradd',
        description: 'WebGate：添加 Web 登录用户。用法：/useradd <用户名> <密码>',
        input: { hint: '<用户名> <密码>' },
        recordInput: false,
        handler: function (inv) {
          const parts = String(inv.rawInput || '').trim().split(/\s+/).filter(Boolean)
          if (parts.length !== 2) return Promise.resolve(errRes('用法：/useradd <用户名> <密码>（密码至少 6 位）'))
          return addUserCore(parts[0], parts[1]).then(function (r) { return r.ok ? okRes(r.message) : errRes(r.message) })
        }
      })
    })
    ctx.effect(function () {
      return commandsSvc.register({
        name: 'passwd',
        description: 'WebGate：修改用户登录密码（该用户现有会话立即失效）。用法：/passwd <用户名> <新密码>',
        input: { hint: '<用户名> <新密码>' },
        recordInput: false,
        handler: function (inv) {
          const parts = String(inv.rawInput || '').trim().split(/\s+/).filter(Boolean)
          if (parts.length !== 2) return Promise.resolve(errRes('用法：/passwd <用户名> <新密码>（新密码至少 6 位）'))
          return passwdCore(parts[0], parts[1]).then(function (r) { return r.ok ? okRes(r.message) : errRes(r.message) })
        }
      })
    })
    ctx.effect(function () {
      return commandsSvc.register({
        name: 'userlist',
        description: 'WebGate：列出所有 Web 登录用户',
        handler: function () {
          const users = listUsersCore()
          if (!users.length) return Promise.resolve(okRes('暂无用户'))
          const lines = users.map(function (u) {
            return u.username + '　创建于 ' + (u.createdAt || '?') + '　活跃会话 ' + u.activeSessions
          })
          return Promise.resolve(okRes('共 ' + users.length + ' 个用户：\n' + lines.join('\n')))
        }
      })
    })
    ctx.effect(function () {
      return commandsSvc.register({
        name: 'userdel',
        description: 'WebGate：删除 Web 登录用户。用法：/userdel <用户名>',
        input: { hint: '<用户名>' },
        handler: function (inv) {
          const parts = String(inv.rawInput || '').trim().split(/\s+/).filter(Boolean)
          if (parts.length !== 1) return Promise.resolve(errRes('用法：/userdel <用户名>'))
          return delUserCore(parts[0]).then(function (r) { return r.ok ? okRes(r.message) : errRes(r.message) })
        }
      })
    })
  }

  // ---------- 模型工具（Agent 可代为管理用户） ----------
  function regTool(def) {
    if (!toolsSvc) return
    try {
      ctx.effect(function () { return toolsSvc.register(def) })
    } catch (e) {
      console.error('[webgate] 注册工具失败: ' + def.name + ' ' + ((e && e.message) || e))
    }
  }
  regTool({
    name: 'webgate_user_list',
    description: '列出 WebGate Web 登录用户：用户名、创建时间、活跃会话数。不包含密码。',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async function () {
      return { users: listUsersCore() }
    },
    output: {
      schema: { type: 'object', properties: { users: { type: 'array' } } },
      render: function (args, value) {
        const users = (value && value.users) || []
        if (!users.length) return [{ type: 'text', text: '（无用户）' }]
        return [{
          type: 'text',
          text: users.map(function (u) {
            return '- ' + u.username + '（创建于 ' + (u.createdAt || '?') + '，活跃会话 ' + u.activeSessions + '）'
          }).join('\n')
        }]
      }
    }
  })
  regTool({
    name: 'webgate_user_add',
    description: '添加一个 WebGate Web 登录用户。用户名 2-32 位字母/数字/点/下划线/短横线；密码 6-128 位。',
    parameters: {
      type: 'object',
      properties: { username: { type: 'string', description: '用户名' }, password: { type: 'string', description: '密码（至少 6 位）' } },
      required: ['username', 'password']
    },
    execute: async function (args) {
      return addUserCore(args.username, args.password)
    },
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' }, message: { type: 'string' } } },
      render: function (args, value) { return [{ type: 'text', text: (value && value.message) || '' }] }
    }
  })
  regTool({
    name: 'webgate_user_passwd',
    description: '修改一个 WebGate 用户的登录密码；该用户现有的登录会话会立即失效。',
    parameters: {
      type: 'object',
      properties: { username: { type: 'string', description: '用户名' }, password: { type: 'string', description: '新密码（至少 6 位）' } },
      required: ['username', 'password']
    },
    execute: async function (args) {
      return passwdCore(args.username, args.password)
    },
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' }, message: { type: 'string' } } },
      render: function (args, value) { return [{ type: 'text', text: (value && value.message) || '' }] }
    }
  })

  // ---------- 异步初始化：加载用户库，必要时引导初始管理员 ----------
  Promise.resolve().then(async function () {
    await loadUsers()
    if (!usersCache || Object.keys(usersCache).length === 0) {
      const salt = randomHex(16)
      usersCache = {}
      usersCache[INITIAL_USER] = {
        hash: hashPassword(INITIAL_PASS, salt, PBKDF2_ITER),
        salt,
        iter: PBKDF2_ITER,
        createdAt: new Date().toISOString()
      }
      try {
        await persistUsers()
        console.log('[webgate] 已创建初始管理员账号: ' + INITIAL_USER + ' / ' + INITIAL_PASS + '（请尽快用 /passwd 修改）')
      } catch (e) {
        console.error('[webgate] 初始管理员写入失败：' + ((e && e.message) || e))
      }
    } else {
      console.log('[webgate] 用户库已加载：' + Object.keys(usersCache).length + ' 个用户')
    }
  }).catch(function (e) {
    console.error('[webgate] 初始化失败：' + ((e && e.message) || e))
  })
}
