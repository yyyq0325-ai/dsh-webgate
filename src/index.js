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
// inject 必须声明全部依赖：cordis 的 Fiber 在每个注入服务激活之前会把插件
// 挂起（park），全部就绪才调用 apply。只声明 timer 会让本插件在其他服务
// 尚未启动时提前执行，ctx.get() 全部返回 undefined（服务"不可用"假象）。
// 注意：本版本 cordis 只支持扁平数组形式；数组内每一项都是硬依赖——
// 不含 webServer 的 profile（headless/tui）里本插件会保持挂起，属预期行为。
export const inject = ['timer', 'webServer', 'credentials', 'commands', 'tools']

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
  function sendJson(res, status, obj, extraHeaders) {
    try {
      const h = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
      if (extraHeaders) Object.assign(h, extraHeaders)
      res.writeHead(status, h)
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

  // ---------- API 文案（按 Accept-Language 协商，缺省中文） ----------
  const MSG = {
    zh: {
      needBoth: '请输入用户名和密码',
      starting: '认证服务初始化中，请稍后再试',
      badCreds: '用户名或密码错误'
    },
    en: {
      needBoth: 'Please enter your username and password',
      starting: 'Authentication is initializing, please try again shortly',
      badCreds: 'Incorrect username or password'
    }
  }
  function localeOf(req) {
    const al = String((req && req.headers && req.headers['accept-language']) || '')
    return /\ben\b/i.test(al) ? 'en' : 'zh'
  }

  // ---------- 用户管理核心（命令与模型工具共用；输出双语行内文案） ----------
  function validateUsername(u) {
    if (!/^[A-Za-z0-9_.-]{2,32}$/.test(u)) return '用户名需为 2-32 位字母、数字、点、下划线或短横线 | Username must be 2-32 chars: letters, digits, dot, underscore or dash'
    return null
  }
  function validatePassword(p) {
    if (typeof p !== 'string' || p.length < 6 || p.length > 128) return '密码长度需为 6-128 位 | Password length must be 6-128 characters'
    return null
  }
  function addUserCore(username, password) {
    const u = String(username || '').trim()
    const err = validateUsername(u) || validatePassword(password)
    if (err) return Promise.resolve({ ok: false, message: err })
    if (!usersCache) return Promise.resolve({ ok: false, message: '用户库尚未初始化，请稍后再试 | User store is not initialized yet, please retry' })
    if (usersCache[u]) return Promise.resolve({ ok: false, message: '用户「' + u + '」已存在 | User "' + u + '" already exists' })
    const salt = randomHex(16)
    usersCache[u] = { hash: hashPassword(password, salt, PBKDF2_ITER), salt, iter: PBKDF2_ITER, createdAt: new Date().toISOString() }
    return persistUsers().then(function () {
      console.log('[webgate] 已添加用户: ' + u)
      return { ok: true, message: '用户「' + u + '」添加成功 | User "' + u + '" added' }
    }).catch(function (e) {
      delete usersCache[u]
      console.error('[webgate] 写入用户失败：' + ((e && e.message) || e))
      return { ok: false, message: '写入用户库失败，详见 Host 日志 | Failed to write user store, see host logs' }
    })
  }
  function passwdCore(username, password) {
    const u = String(username || '').trim()
    const err = validateUsername(u) || validatePassword(password)
    if (err) return Promise.resolve({ ok: false, message: err })
    if (!usersCache || !usersCache[u]) return Promise.resolve({ ok: false, message: '用户「' + u + '」不存在 | User "' + u + '" does not exist' })
    const salt = randomHex(16)
    const prev = usersCache[u]
    usersCache[u] = { hash: hashPassword(password, salt, PBKDF2_ITER), salt, iter: PBKDF2_ITER, createdAt: prev.createdAt }
    return persistUsers().then(function () {
      revokeUserTokens(u)
      console.log('[webgate] 已修改用户密码: ' + u)
      return { ok: true, message: '用户「' + u + '」密码已修改，其现有登录会话已全部失效 | Password updated for "' + u + '", all their sessions were revoked' }
    }).catch(function (e) {
      usersCache[u] = prev
      console.error('[webgate] 密码写入失败：' + ((e && e.message) || e))
      return { ok: false, message: '写入用户库失败，详见 Host 日志 | Failed to write user store, see host logs' }
    })
  }
  function delUserCore(username) {
    const u = String(username || '').trim()
    if (!usersCache || !usersCache[u]) return Promise.resolve({ ok: false, message: '用户「' + u + '」不存在 | User "' + u + '" does not exist' })
    if (Object.keys(usersCache).length <= 1) return Promise.resolve({ ok: false, message: '至少需要保留一个用户 | At least one user must remain' })
    const prev = usersCache[u]
    delete usersCache[u]
    return persistUsers().then(function () {
      revokeUserTokens(u)
      return { ok: true, message: '用户「' + u + '」已删除 | User "' + u + '" deleted' }
    }).catch(function (e) {
      usersCache[u] = prev
      console.error('[webgate] 删除用户写入失败：' + ((e && e.message) || e))
      return { ok: false, message: '写入用户库失败，详见 Host 日志 | Failed to write user store, see host logs' }
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
  // MODE = 'guard'：注入每个 index.html，未认证 → location.replace('/login')；
  // MODE = 'page'：/login 独立登录页，登录成功写令牌后跳回 next（默认 '/'）。
  const gateFactory = function (GATE_CSS, LOGO_SVG, MODE) {
    'use strict'
    const K = 'dshWebgate'
    function lg(k) { try { return window.localStorage.getItem(K + '.' + k) } catch (e) { return null } }
    function sv(k, v) { try { window.localStorage.setItem(K + '.' + k, String(v)) } catch (e) { } }
    function rmv(k) { try { window.localStorage.removeItem(K + '.' + k) } catch (e) { } }

    // ---------- 双语文案（默认中文；英文浏览器自动切换，可手动覆盖并记忆） ----------
    const LS = {
      zh: {
        sub: 'Harness 控制台 · 账号登录',
        user: '用户名', pass: '密码',
        login: '登 录', loggingIn: '登录中…',
        needBoth: '请输入用户名和密码',
        netErr: '网络错误，请重试', loginFailed: '登录失败',
        verifying: '正在验证登录会话…',
        offline: '无法连接认证服务', retry: '重试',
        foot1: '登录会话有效期 12 小时', foot2: '后台任务持续运行，不受登出影响',
        hoursLeft: '剩余约 {n} 小时', signout: '退出',
        toggle: 'EN'
      },
      en: {
        sub: 'Harness Console · Sign in',
        user: 'Username', pass: 'Password',
        login: 'Sign in', loggingIn: 'Signing in…',
        needBoth: 'Please enter your username and password',
        netErr: 'Network error, please retry', loginFailed: 'Sign-in failed',
        verifying: 'Verifying your session…',
        offline: 'Cannot reach the auth service', retry: 'Retry',
        foot1: 'Sessions last 12 hours', foot2: 'Background tasks keep running while signed out',
        hoursLeft: '~{n} h left', signout: 'Sign out',
        toggle: '中文'
      }
    }
    function detectLang() {
      try {
        const saved = window.localStorage.getItem(K + '.lang')
        if (saved === 'en' || saved === 'zh') return saved
      } catch (e) { }
      const nav = (typeof navigator !== 'undefined' && navigator.language) || 'zh'
      return /^en/i.test(String(nav)) ? 'en' : 'zh'
    }
    let LANG = detectLang()
    function t(k, n) {
      const s = ((LS[LANG] && LS[LANG][k]) || LS.zh[k] || k)
      return n === undefined ? s : String(s).replace('{n}', String(n))
    }
    // 切换语言：保存偏好 → 重新渲染当前卡片（尽量保留已输入内容）
    function setLang(lang, rerender) {
      LANG = lang === 'en' ? 'en' : 'zh'
      sv('lang', LANG)
      if (typeof rerender === 'function') rerender()
    }
    // 绑定语言切换链接；返回当前输入值以便重渲染后恢复
    function bindLangToggle(container, rerender) {
      const el = container.querySelector('.wg-lang')
      if (!el) return
      el.textContent = t('toggle')
      el.addEventListener('click', function () {
        container.__wgSaved = {
          u: (container.querySelector('#wg-user') || {}).value || '',
          p: (container.querySelector('#wg-pass') || {}).value || ''
        }
        setLang(LANG === 'zh' ? 'en' : 'zh', rerender)
      })
    }

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
    // 背景装饰层：三层模糊蓝光晕球 + 点阵网格（还原 harness 官网 hero 视觉）
    function decorHtml() {
      return '<div class="wg-orb wg-o1"></div><div class="wg-orb wg-o2"></div><div class="wg-orb wg-o3"></div><div class="wg-grid"></div>'
    }
    function cardHtml(state) {
      if (state === 'verify') {
        return decorHtml() + '<div class="wg-frame"><div class="wg-card wg-center"><span class="wg-spin wg-spin-lg"></span><div class="wg-wait">' + t('verifying') + '</div></div></div>'
      }
      if (state === 'offline') {
        return decorHtml() + '<div class="wg-frame"><div class="wg-card wg-center"><div class="wg-wait">' + t('offline') + '</div><button type="button" class="wg-retry">' + t('retry') + '</button></div></div>'
      }
      return decorHtml() + '<div class="wg-frame"><div class="wg-card">'
        + '<div class="wg-logo">' + LOGO_SVG + '<span class="wg-title">DeepSeek</span></div>'
        + '<div class="wg-sub">' + t('sub') + '</div>'
        + '<label class="wg-label" for="wg-user">' + t('user') + '</label>'
        + '<input id="wg-user" class="wg-input" autocomplete="username" spellcheck="false" />'
        + '<label class="wg-label" for="wg-pass">' + t('pass') + '</label>'
        + '<input id="wg-pass" class="wg-input" type="password" autocomplete="current-password" />'
        + '<button type="button" class="wg-btn" id="wg-go">' + t('login') + '</button>'
        + '<div class="wg-err"></div>'
        + '<div class="wg-foot">' + t('foot1') + '<br />' + t('foot2') + '</div>'
        + '<div class="wg-langbar"><a href="javascript:void(0)" class="wg-lang"></a></div>'
        + '</div></div>'
    }
    function bindLoginForm(container, onSuccess) {
      const btn = container.querySelector('#wg-go')
      const u = container.querySelector('#wg-user')
      const p = container.querySelector('#wg-pass')
      function setErr(msg) {
        const e = container.querySelector('.wg-err')
        if (e) e.textContent = msg || ''
        const c = container.querySelector('.wg-card')
        if (c && msg) { c.classList.remove('wg-shake'); void c.offsetWidth; c.classList.add('wg-shake') }
      }
      function go() {
        const uv = (u.value || '').trim(), pv = p.value || ''
        if (!uv || !pv) { setErr(t('needBoth')); return }
        btn.disabled = true
        btn.innerHTML = '<span class="wg-spin"></span> ' + t('loggingIn')
        api('login', { username: uv, password: pv }).then(function (d) {
          if (d && d.ok && d.token) onSuccess(d)
          else { btn.disabled = false; btn.textContent = t('login'); setErr((d && d.message) || t('loginFailed')) }
        }).catch(function () {
          btn.disabled = false; btn.textContent = t('login'); setErr(t('netErr'))
        })
      }
      btn.addEventListener('click', go)
      p.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') go() })
      u.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') p.focus() })
      setTimeout(function () { try { u.focus() } catch (e) { } }, 60)
      return setErr
    }

    if (MODE === 'page') {
      document.body.setAttribute('style', 'margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#1f2126')
      let next = '/'
      try {
        const q = new URLSearchParams(window.location.search).get('next')
        if (q && /^\/[^/]/.test(q)) next = q // 只允许站内路径，防开放跳转
      } catch (e) { }
      const pg = document.createElement('div')
      pg.id = 'wg-gate'
      document.body.appendChild(pg)
      function initPage() {
        pg.innerHTML = cardHtml()
        const saved = pg.__wgSaved || {}
        bindLoginForm(pg, function (d) {
          sv('token', d.token); sv('exp', d.expiresAt)
          location.href = next
        })
        bindLangToggle(pg, initPage)
        const iu = pg.querySelector('#wg-user'), ip = pg.querySelector('#wg-pass')
        if (iu && saved.u) iu.value = saved.u
        if (ip && saved.p) ip.value = saved.p
      }
      initPage()
      return
    }

    // ---- guard 模式：不渲染遮罩；未认证直接跳转 /login，登录页负责发令牌 ----
    let watchTimer = null
    function stopWatch() { if (watchTimer) { clearInterval(watchTimer); watchTimer = null } }
    function hideChip() { const old = document.querySelector('.wg-chip'); if (old) old.remove() }
    function showChip(user, exp) {
      hideChip()
      const c = document.createElement('button')
      c.className = 'wg-chip'
      c.type = 'button'
      c.setAttribute('title', 'WebGate')
      c.textContent = '🔒 ' + user + ' · ' + t('hoursLeft', Math.max(0, Math.round((exp - Date.now()) / 3600000))) + ' · ' + t('signout')
      c.addEventListener('click', function () { doLogout(false) })
      document.documentElement.appendChild(c)
    }
    function doLogout(local) {
      stopWatch(); hideChip()
      const tok = lg('token')
      rmv('token'); rmv('exp')
      try { document.cookie = 'webgate_token=; Path=/; Max-Age=0; SameSite=Lax' } catch (e) { }
      if (!local && tok) {
        fetch('/auth/api/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: tok }) })
      }
      location.replace('/login')
    }
    function startWatch(user, exp) {
      stopWatch()
      watchTimer = setInterval(function () {
        const e = parseInt(lg('exp'), 10)
        if (!e || Date.now() > e - 2000) doLogout(true)
      }, 30000)
      showChip(user, exp)
    }
    function verified(d) {
      if (d && d.expiresAt) sv('exp', d.expiresAt)
      document.documentElement.style.visibility = ''
      startWatch(d.username, d.expiresAt || parseInt(lg('exp'), 10) || Date.now())
    }
    function goLogin() {
      rmv('token'); rmv('exp')
      try { document.cookie = 'webgate_token=; Path=/; Max-Age=0; SameSite=Lax' } catch (e) { }
      location.replace('/login')
    }
    function verifySession(tok) {
      return api('session', { token: tok }).then(function (d) {
        if (d && d.ok && d.valid && d.username) verified(d)
        else goLogin()
      }).catch(function () {
        // 认证服务暂时不可达：恢复显示留在原地（避免跳转死循环），下次页面重新可见时重试
        document.documentElement.style.visibility = ''
      })
    }
    const tok0 = lg('token')
    const exp0 = parseInt(lg('exp'), 10)
    document.documentElement.style.visibility = 'hidden' // 同步隐藏，防止应用内容闪现
    if (!tok0 || !exp0 || Date.now() > exp0 - 2000) {
      goLogin()
    } else {
      verifySession(tok0)
      document.addEventListener('visibilitychange', function () {
        if (!document.hidden && lg('token')) verifySession(lg('token'))
      })
    }
  }

  // ---------- 注册路由与页面注入 ----------
  if (web) {
    // 视觉基调取自 deepseek.com/harness：炭黑底 + 三层模糊蓝光晕（screen 混合）
    // + 点阵网格遮罩 + 玻璃拟态卡片 + 品牌蓝 #4d6bfe + 旋转渐变描边
    const GATE_CSS = [
      '#wg-gate{position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;font-family:"Segoe UI",system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;background:#1f2126;color:#e8ecf8;overflow:hidden}',
      '#wg-gate::before{content:"";position:absolute;inset:0;z-index:0;background:linear-gradient(180deg,#17181d 0%,#1f2126 45%,#181a1f 100%)}',
      '#wg-gate .wg-orb{position:absolute;z-index:0;border-radius:50%;mix-blend-mode:screen;pointer-events:none}',
      '#wg-gate .wg-o1{width:min(64vw,780px);height:min(64vw,780px);top:-24%;left:-15%;background:radial-gradient(circle,#1A3870 0%,transparent 70%);filter:blur(80px);animation:wgDrift1 21s ease-in-out infinite alternate}',
      '#wg-gate .wg-o2{width:min(58vw,720px);height:min(58vw,720px);bottom:-30%;right:-17%;background:radial-gradient(ellipse at center,#2D5F9E 0%,#1A3870 42%,transparent 72%);filter:blur(95px);animation:wgDrift2 17s ease-in-out infinite alternate}',
      '#wg-gate .wg-o3{width:min(36vw,460px);height:min(36vw,460px);top:9%;right:13%;background:radial-gradient(circle,#4A8AC4 0%,#2D5F9E 32%,transparent 70%);filter:blur(65px);opacity:.85;animation:wgDrift3 13s ease-in-out infinite alternate}',
      '#wg-gate .wg-grid{position:absolute;inset:0;z-index:0;background-image:radial-gradient(rgba(255,255,255,.055) 1px,transparent 1.4px);background-size:26px 26px;-webkit-mask-image:radial-gradient(ellipse 74% 70% at 50% 44%,#000 22%,transparent 78%);mask-image:radial-gradient(ellipse 74% 70% at 50% 44%,#000 22%,transparent 78%);pointer-events:none}',
      '#wg-gate .wg-frame{position:relative;z-index:2;width:372px;max-width:calc(100vw - 40px);padding:1px;border-radius:22px;overflow:hidden}',
      '#wg-gate .wg-frame::before{content:"";position:absolute;inset:-60%;background:conic-gradient(from 0deg,rgba(77,107,254,0) 0deg,rgba(77,107,254,.55) 55deg,rgba(103,158,254,.32) 115deg,rgba(26,56,112,0) 175deg,rgba(77,107,254,0) 360deg);animation:wgSpin 5.5s linear infinite}',
      '#wg-gate .wg-card{position:relative;z-index:1;border-radius:21px;padding:38px 36px 26px;background:rgba(24,26,31,.82);backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);border:1px solid rgba(255,255,255,.07);box-shadow:0 30px 90px rgba(0,0,0,.5),inset 0 1px 0 rgba(255,255,255,.05);animation:wgRise .55s cubic-bezier(.22,.9,.32,1) both}',
      '#wg-gate .wg-logo{display:flex;align-items:center;justify-content:center;gap:11px;margin-bottom:4px}',
      '#wg-gate .wg-title{font-size:23px;font-weight:700;color:#fff;letter-spacing:.2px}',
      '#wg-gate .wg-sub{text-align:center;font-size:13px;color:rgba(158,170,196,.85);margin:6px 0 24px}',
      '#wg-gate .wg-label{display:block;font-size:12px;color:rgba(170,180,212,.75);margin:14px 0 6px}',
      '#wg-gate .wg-input{box-sizing:border-box;width:100%;height:44px;padding:0 14px;border-radius:10px;border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.045);color:#fff;font-size:14px;outline:none;transition:border-color .18s,box-shadow .18s,background .18s;font-family:inherit}',
      '#wg-gate .wg-input:focus{border-color:#4d6bfe;background:rgba(77,107,254,.08);box-shadow:0 0 0 3px rgba(77,107,254,.22)}',
      '#wg-gate .wg-btn{margin-top:24px;width:100%;height:44px;border:none;border-radius:10px;background:linear-gradient(135deg,#4d6bfe,#3a65c2);color:#fff;font-size:15px;font-weight:600;cursor:pointer;transition:transform .16s,box-shadow .16s,filter .16s;display:flex;align-items:center;justify-content:center;gap:8px;font-family:inherit}',
      '#wg-gate .wg-btn:hover{transform:translateY(-1px);filter:brightness(1.08);box-shadow:0 10px 26px rgba(77,107,254,.38)}',
      '#wg-gate .wg-btn:disabled{opacity:.65;cursor:not-allowed;transform:none;filter:none}',
      '#wg-gate .wg-err{min-height:18px;margin-top:12px;text-align:center;font-size:12.5px;color:#ff8585}',
      '#wg-gate .wg-foot{margin-top:14px;text-align:center;font-size:11.5px;color:rgba(148,160,186,.6);line-height:1.8}',
      '#wg-gate .wg-langbar{display:flex;justify-content:flex-end;margin-top:6px}',
      '#wg-gate .wg-lang{font-size:11px;color:#679efe;cursor:pointer;opacity:.85;font-family:inherit}',
      '#wg-gate .wg-lang:hover{opacity:1;text-decoration:underline}',
      '#wg-gate .wg-langbar{display:flex;justify-content:flex-end;margin-top:6px}',
      '#wg-gate .wg-lang{font-size:11px;color:#679efe;cursor:pointer;opacity:.85;font-family:inherit}',
      '#wg-gate .wg-lang:hover{opacity:1;text-decoration:underline}',
      '#wg-gate .wg-wait{margin-top:18px;text-align:center;font-size:13px;color:rgba(158,170,196,.85)}',
      '#wg-gate .wg-spin{width:15px;height:15px;border-radius:50%;border:2px solid rgba(255,255,255,.28);border-top-color:#fff;animation:wgRot .8s linear infinite;display:inline-block}',
      '#wg-gate .wg-spin-lg{width:34px;height:34px;border-width:3px}',
      '#wg-gate .wg-center{display:flex;flex-direction:column;align-items:center;padding:46px 52px}',
      '#wg-gate .wg-retry{margin-top:18px;padding:8px 26px;border-radius:9px;border:1px solid rgba(77,107,254,.6);background:transparent;color:#9db1ff;font-size:13px;cursor:pointer;font-family:inherit;transition:background .15s}',
      '#wg-gate .wg-retry:hover{background:rgba(77,107,254,.15)}',
      '.wg-chip{position:fixed;right:14px;bottom:14px;z-index:2147483647;display:flex;align-items:center;height:30px;padding:0 13px;border-radius:15px;background:rgba(24,26,31,.88);border:1px solid rgba(255,255,255,.1);color:#aab4d4;font-size:12px;cursor:pointer;opacity:.4;transition:opacity .15s;font-family:inherit;backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px)}',
      '.wg-chip:hover{opacity:1}',
      '@keyframes wgSpin{to{transform:rotate(360deg)}}',
      '@keyframes wgDrift1{from{transform:translate(0,0) scale(1)}to{transform:translate(64px,44px) scale(1.12)}}',
      '@keyframes wgDrift2{from{transform:translate(0,0) scale(1)}to{transform:translate(-56px,-46px) scale(1.08)}}',
      '@keyframes wgDrift3{from{transform:translate(0,0) scale(1)}to{transform:translate(-38px,32px) scale(.9)}}',
      '@keyframes wgRise{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}',
      '@keyframes wgShake{0%,100%{transform:translateX(0)}20%{transform:translateX(-7px)}40%{transform:translateX(7px)}60%{transform:translateX(-4px)}80%{transform:translateX(4px)}}',
      '@keyframes wgRot{to{transform:rotate(360deg)}}',
      '.wg-shake{animation:wgShake .38s ease}',
      '@media (prefers-reduced-motion:reduce){#wg-gate *,#wg-gate *::before{animation:none!important}}'
    ].join('\n')

    const LOGO_SVG = '<svg width="34" height="34" viewBox="0 0 48 48" aria-hidden="true"><defs><linearGradient id="wgg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4d6bfe"/><stop offset="1" stop-color="#679efe"/></linearGradient></defs><path fill="url(#wgg)" d="M5 27C5 17.6 12.8 11 23 11c7.6 0 13.9 4 16.4 10.2l4.1-1.9-1.8 9.3c.2 1 .3 2 .3 3.1h-6.6c-2.3 3.9-7 6.3-12.4 6.3C13.6 38 5 33.6 5 27z"/><circle cx="32.2" cy="22.5" r="1.9" fill="#0b1023"/></svg>'

    // 结构化 index 注入：守卫脚本（未认证 → location.replace('/login')）
    ctx.on('webserver/index-inject', function (table) {
      table.push({
        kind: 'script',
        placement: 'head',
        text: '(' + gateFactory.toString() + ')(' + JSON.stringify(GATE_CSS) + ',' + JSON.stringify(LOGO_SVG) + ',"guard");'
      })
    })

    // 登录页：/login 与 /auth/page 共用同一处理函数
    const serveLoginPage = async function (req, res) {
      try {
        const pl = localeOf(req)
        const html = '<!doctype html><html lang="' + (pl === 'en' ? 'en' : 'zh-CN') + '"><head><meta charset="utf-8"/>'
          + '<meta name="viewport" content="width=device-width,initial-scale=1"/>'
          + '<title>DeepSeek Harness · ' + (pl === 'en' ? 'Sign in' : '登录') + '</title></head><body>'
          + '<scr' + 'ipt>(' + gateFactory.toString() + ')(' + JSON.stringify(GATE_CSS) + ',' + JSON.stringify(LOGO_SVG) + ',"page");</scr' + 'ipt>'
          + '</body></html>'
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(html)
      } catch (e) { sendJson(res, 500, { ok: false, message: 'render failed' }) }
    }
    ctx.effect(function () {
      return web.register({ kind: 'exact', path: '/login', handler: serveLoginPage })
    })
    ctx.effect(function () {
      return web.register({ kind: 'exact', path: '/auth/page', handler: serveLoginPage })
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
          const L = localeOf(req)
          const b = await readJsonBody(req)
          const u = String(b.username || '').trim(), p = typeof b.password === 'string' ? b.password : ''
          if (!u || !p) return sendJson(res, 200, { ok: false, message: MSG[L].needBoth })
          if (!usersCache || Object.keys(usersCache).length === 0) return sendJson(res, 200, { ok: false, message: MSG[L].starting })
          const rec = usersCache[u]
          let ok = false
          if (rec && rec.salt && rec.hash) ok = constantTimeEqual(hashPassword(p, rec.salt, rec.iter || PBKDF2_ITER), rec.hash)
          if (!ok) { await delay(900); return sendJson(res, 200, { ok: false, message: MSG[L].badCreds }) }
          const tok = issueToken(u)
          console.log('[webgate] 用户登录成功: ' + u)
          // 同时种下 Cookie：为未来服务端网关级校验留好通道
          sendJson(res, 200, { ok: true, token: tok, expiresAt: tokens[tok].exp, username: u }, {
            'Set-Cookie': 'webgate_token=' + tok + '; Path=/; Max-Age=' + Math.floor(TOKEN_TTL_MS / 1000) + '; SameSite=Lax'
          })
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
          sendJson(res, 200, { ok: true }, {
            'Set-Cookie': 'webgate_token=; Path=/; Max-Age=0; SameSite=Lax'
          })
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
        description: 'WebGate：添加 Web 登录用户 · Add a web login user',
        input: { hint: '<用户名 username> <密码 password>' },
        recordInput: false,
        handler: function (inv) {
          const parts = String(inv.rawInput || '').trim().split(/\s+/).filter(Boolean)
          if (parts.length !== 2) return Promise.resolve(errRes('用法 Usage：/useradd <用户名 username> <密码 password>（密码至少 6 位 / password ≥ 6 chars）'))
          return addUserCore(parts[0], parts[1]).then(function (r) { return r.ok ? okRes(r.message) : errRes(r.message) })
        }
      })
    })
    ctx.effect(function () {
      return commandsSvc.register({
        name: 'passwd',
        description: 'WebGate：修改用户登录密码 · Change a web login password',
        input: { hint: '<用户名 username> <新密码 new-password>' },
        recordInput: false,
        handler: function (inv) {
          const parts = String(inv.rawInput || '').trim().split(/\s+/).filter(Boolean)
          if (parts.length !== 2) return Promise.resolve(errRes('用法 Usage：/passwd <用户名 username> <新密码 new-password>（新密码至少 6 位 / ≥ 6 chars）'))
          return passwdCore(parts[0], parts[1]).then(function (r) { return r.ok ? okRes(r.message) : errRes(r.message) })
        }
      })
    })
    ctx.effect(function () {
      return commandsSvc.register({
        name: 'userlist',
        description: 'WebGate：列出所有 Web 登录用户 · List all web login users',
        handler: function () {
          const users = listUsersCore()
          if (!users.length) return Promise.resolve(okRes('暂无用户 | No users yet'))
          const lines = users.map(function (u) {
            return '- ' + u.username + ' · created 创建于 ' + (u.createdAt || '?') + ' · active sessions 活跃会话: ' + u.activeSessions
          })
          return Promise.resolve(okRes('共 ' + users.length + ' 个用户 | ' + users.length + ' user(s):\n' + lines.join('\n')))
        }
      })
    })
    ctx.effect(function () {
      return commandsSvc.register({
        name: 'userdel',
        description: 'WebGate：删除 Web 登录用户 · Delete a web login user',
        input: { hint: '<用户名 username>' },
        handler: function (inv) {
          const parts = String(inv.rawInput || '').trim().split(/\s+/).filter(Boolean)
          if (parts.length !== 1) return Promise.resolve(errRes('用法 Usage：/userdel <用户名 username>'))
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
    description: 'List WebGate web-login users (name, created time, active sessions; no passwords). 列出 WebGate 登录用户（不含密码）。',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async function () {
      return { users: listUsersCore() }
    },
    output: {
      schema: { type: 'object', properties: { users: { type: 'array' } } },
      render: function (args, value) {
        const users = (value && value.users) || []
        if (!users.length) return [{ type: 'text', text: '无用户 | no users' }]
        return [{
          type: 'text',
          text: users.map(function (u) {
            return '- ' + u.username + ' (created 创建于 ' + (u.createdAt || '?') + ', sessions 会话 ' + u.activeSessions + ')'
          }).join('\n')
        }]
      }
    }
  })
  regTool({
    name: 'webgate_user_add',
    description: 'Add a WebGate web-login user. 添加一个 WebGate Web 登录用户。Username 用户名: 2-32 chars [A-Za-z0-9_.-]; password 密码: 6-128 chars.',
    parameters: {
      type: 'object',
      properties: { username: { type: 'string', description: '用户名 / username' }, password: { type: 'string', description: '密码 / password (min 6 chars)' } },
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
    description: "Change a WebGate user's password; revokes their active sessions. 修改 WebGate 用户登录密码，并撤销其现有会话。",
    parameters: {
      type: 'object',
      properties: { username: { type: 'string', description: '用户名 / username' }, password: { type: 'string', description: '新密码 / new password (min 6 chars)' } },
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
