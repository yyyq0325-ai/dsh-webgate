// 浏览器侧冒烟测试：守卫模式（未认证跳转 /login）+ 登录页模式（表单/双语/next 跳转）。
// 运行：node scripts/browsersim.test.mjs
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { apply } from '../src/index.js'

const root0 = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// ---- 触发 index-inject 监听拿到守卫脚本，并派生登录页脚本 ----
const rows = []
const mockCtx = {
  get(n) {
    if (n === 'credentials') return { async readRecord() { return undefined }, async modifyRecord(k, m) { await m(undefined); return undefined } }
    if (n === 'webServer') return { register() { return () => { } }, tapIndex() { return () => { } } }
    if (n === 'commands') return { register() { return () => { } } }
    if (n === 'tools') return { register() { return () => { } } }
    return undefined
  },
  on(name, fn) { if (name === 'webserver/index-inject') rows.push(fn); return () => { } },
  effect(fn) { const d = fn && fn(); return typeof d === 'function' ? d : () => { } },
  timeout() { return new Promise(() => { }) },
}
apply(mockCtx)
const table = []
rows[0](table)
if (!table.length) { console.error('FAIL no injection row'); process.exit(1) }
const GUARD_ROW = table[0].text
if (!GUARD_ROW.includes('"overlay"') && !GUARD_ROW.includes('"guard"')) { console.error('FAIL unexpected row'); process.exit(1) }
const PAGE_ROW = GUARD_ROW.replace(',"overlay")', ',"page")').replace(',"guard")', ',"page")')
console.log('INFO guard row length:', GUARD_ROW.length)

// ---- 桩 DOM ----
class El {
  constructor(tag) {
    this.tagName = tag; this.children = []; this.parentNode = null
    this.style = {}; this._cls = new Set(); this.listeners = {}
    this.value = ''; this.innerHTML = ''; this.textContent = ''; this.offsetWidth = 0; this.disabled = false
    this._qs = {}; this._html = ''
  }
  get className() { return [...this._cls].join(' ') }
  set className(v) { this._cls = new Set(String(v).split(/\s+/).filter(Boolean)) }
  get classList() {
    const s = this._cls
    return { add: (...a) => a.forEach(x => s.add(x)), remove: (...a) => a.forEach(x => s.delete(x)), contains: x => s.has(x) }
  }
  setAttribute(k, v) { this[k] = v }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c }
  remove() { if (this.parentNode) { const i = this.parentNode.children.indexOf(this); if (i >= 0) this.parentNode.children.splice(i, 1) } }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn) }
  click() { (this.listeners.click || []).forEach(f => f({ key: '' })) }
  key(k) { (this.listeners.keydown || []).forEach(f => f({ key: k })) }
  focus() { }
  querySelector(sel) { return this._qs[sel] || (this._qs[sel] = new El('div')) }
  set innerHTML(v) { this._html = String(v) }
  get innerHTML() { return this._html }
}

process.on('unhandledRejection', r => console.log('[UNHANDLED]', (r && r.stack) || r))

let failures = 0
function expect(name, cond) {
  if (!cond) failures++
  console.log((cond ? 'PASS ' : 'FAIL ') + name)
}

function buildEnv({ storage = {}, responder, row = GUARD_ROW, search = '' }) {
  const st = Object.assign({}, storage)
  const docListeners = {}
  const documentElement = new El('html')
  const head = new El('head')
  const body = new El('body')
  const documentObj = {
    head, documentElement, body, readyState: 'complete',
    createElement: t => new El(t),
    addEventListener(t, fn) { (docListeners[t] = docListeners[t] || []).push(fn) },
    querySelector() { return null },
  }
  let reloads = 0
  const replaces = []
  const locationObj = {
    href: 'http://127.0.0.1:3080/' + (search || ''),
    search,
    reload: () => { reloads++ },
    replace: p => { replaces.push(p); locationObj.href = p },
  }
  const intervals = []
  let iid = 0
  class FakeResponse {
    constructor(body, init) {
      this.status = (init && init.status) || 200
      this.statusText = (init && init.statusText) || ''
      this.headers = (init && init.headers) || {}
      this._body = body
    }
    json() { return Promise.resolve(typeof this._body === 'string' ? JSON.parse(this._body) : this._body) }
    clone() { return this }
  }
  const globalFetch = (url, opts) => {
    const payload = responder(url, opts)
    if (payload && typeof payload.then === 'function') return payload
    return Promise.resolve(new FakeResponse(payload))
  }
  const sandbox = {
    window: { fetch: globalFetch, location: locationObj, localStorage: { getItem: k => (k in st ? st[k] : null), setItem: (k, v) => { st[k] = String(v) }, removeItem: k => { delete st[k] } } },
    document: documentObj,
    location: locationObj,
    URLSearchParams,
    Response: FakeResponse,
    fetch: globalFetch,
    setInterval: (fn, ms) => { intervals.push({ fn, ms, id: ++iid }); return iid },
    clearInterval: id => { const i = intervals.findIndex(x => x.id === id); if (i >= 0) intervals.splice(i, 1) },
    setTimeout: (fn) => Promise.resolve().then(fn),
    console: { log: (...a) => console.log('[vm]', ...a), error: (...a) => console.error('[vm]', ...a) },
    document_cookie: '',
  }
  // document.cookie setter（doLogout/goLogin 会清 cookie）
  Object.defineProperty(documentObj, 'cookie', { get: () => sandbox.document_cookie, set: v => { sandbox.document_cookie = v } })
  sandbox.globalThis = sandbox
  const context = vm.createContext(sandbox)
  vm.runInContext(row, context, { filename: 'webgate-row.js' })
  return { storage: st, documentElement, body, window: sandbox.window, __globalFetch: globalFetch, intervals, docListeners, location: locationObj, reloads: () => reloads, replaces: () => replaces }
}
const tick = () => new Promise(r => setTimeout(r, 20))
const gateRoot = env => env.documentElement.children.find(c => c.id === 'wg-gate')
  || env.body.children.find(c => c.id === 'wg-gate')

;(async () => {
  // ---- A: 守卫 + 无令牌 → 跳转 /login ----
  let env = buildEnv({})
  await tick()
  expect('A1 未认证跳转 /login', env.replaces()[0] === '/login')
  expect('A2 不渲染任何遮罩节点', !gateRoot(env))

  // ---- B: 守卫 + 有效会话 → 放行并显示角标 ----
  env = buildEnv({
    storage: { 'dshWebgate.token': 'TK-live', 'dshWebgate.exp': String(Date.now() + 3600000) },
    responder: (url, opts) => {
      const b = JSON.parse(opts.body)
      if (url.endsWith('/session') && b.token === 'TK-live') return { ok: true, valid: true, username: 'admin', expiresAt: Date.now() + 3600000, perms: { role: 'admin', workspaces: ['*'] } }
      return { ok: false }
    },
  })
  await tick()
  expect('B1 有效会话不跳转', env.replaces().length === 0)
  expect('B2 恢复可见性', env.documentElement.style.visibility === '')
  expect('B3 启动过期看门定时器', env.intervals.length === 1)
  const chip = env.documentElement.children.find(c => c.className === 'wg-chip')
  expect('B4 会话角标显示用户名与退出', !!chip && String(chip.textContent).includes('admin'))
  ;(env.docListeners.visibilitychange || []).forEach(f => f())
  await tick()
  expect('B5 页面可见性复核通过', env.replaces().length === 0)
  expect('B6 会话响应写入本地 perms', (env.storage['dshWebgate.perms'] || '').includes('"role":"admin"'))

  // ---- J: 成员工作区过滤（fetch 包装；模拟真实调用：URL 对象 + 按目录名授予）----
  const wsItems = [
    { workspaceId: 'w1', path: 'D:\\code\\park', title: 'park', sessionIds: [], createdAt: '', updatedAt: '' },
    { workspaceId: 'w2', path: 'D:\\code\\other', title: 'other', sessionIds: [], createdAt: '', updatedAt: '' },
  ]
  const listEnvelope = () => ({ type: 'server-response', rpcId: 'x', result: { ok: true, value: { items: JSON.parse(JSON.stringify(wsItems)), archivedSessionIds: [] } } })
  const memberResponder = (u0, opts) => {
    const url = String(u0)
    const b = JSON.parse(opts.body)
    if (url.endsWith('/api/workspace.list')) return listEnvelope()
    if (url.endsWith('/session') && b.token === 'TK-m') return { ok: true, valid: true, username: 'alice', expiresAt: Date.now() + 3600000, perms: { role: 'member', workspaces: ['park'] } }
    return { ok: false }
  }
  env = buildEnv({
    storage: {
      'dshWebgate.token': 'TK-m', 'dshWebgate.exp': String(Date.now() + 3600000),
      'dshWebgate.perms': JSON.stringify({ role: 'member', workspaces: ['park'] }),
    },
    responder: memberResponder,
  })
  await tick()
  expect('J1 成员会话不跳转', env.replaces().length === 0)
  // 真实传输形态：input 是 new URL(...) 对象
  const listResp = await env.window.fetch(new URL('/api/workspace.list', 'http://127.0.0.1:3080'), { method: 'POST', body: '{}' })
  const lj = await listResp.json()
  const jItems = lj.result.value.items
  expect('J2 URL对象入参也命中过滤（按目录名 park 匹配 D:\\code\\park）', Array.isArray(jItems) && jItems.length === 1 && jItems[0].path === 'D:\\code\\park')
  // 刷新 perms 后（会话复核返回同样权限）仍保持过滤
  ;(env.docListeners.visibilitychange || []).forEach(f => f())
  await tick()
  const listResp2 = await env.window.fetch('/api/workspace.list', { method: 'POST', body: '{}' })
  expect('J3 复核后仍过滤', (await listResp2.json()).result.value.items.length === 1)

  // 成员：html 标记与受限 RPC 拒绝
  expect('J4 html 获得 wg-member 类', env.documentElement.className.includes('wg-member'))
  const deny = async (method) => {
    const r = await env.window.fetch('/api/' + method, {
      method: 'POST',
      body: JSON.stringify({ type: 'client-request', rpcId: 'r-' + method, method, payload: {} })
    })
    return r.json()
  }
  const d1 = await deny('settings.describe')
  expect('J5 settings.describe 被拒', d1.result.ok === false && d1.result.error.code === 'bad-request')
  const d2 = await deny('workspace.create')
  expect('J6 workspace.create 被拒', d2.result.ok === false)
  const d3 = await deny('session.search')
  expect('J7 session.search 被拒', d3.result.ok === false)

  // ---- K: admin 不受过滤 ----
  env = buildEnv({
    storage: {
      'dshWebgate.token': 'TK-a2', 'dshWebgate.exp': String(Date.now() + 3600000),
      'dshWebgate.perms': JSON.stringify({ role: 'admin', workspaces: ['*'] }),
    },
    responder: (u0, opts) => {
      const url = String(u0)
      const b = JSON.parse(opts.body)
      if (url.endsWith('/api/workspace.list')) return listEnvelope()
      if (url.endsWith('/session') && b.token === 'TK-a2') return { ok: true, valid: true, username: 'admin', expiresAt: Date.now() + 3600000, perms: { role: 'admin', workspaces: ['*'] } }
      return { ok: false }
    },
  })
  await tick()
  const r2 = await env.window.fetch('/api/workspace.list', { method: 'POST', body: '{}' })
  expect('K1 admin 看到全部工作区', (await r2.json()).result.value.items.length === 2)
  expect('K2 admin 无 wg-member 类', !env.documentElement.className.includes('wg-member'))
  const ka = await env.window.fetch('/api/settings.describe', {
    method: 'POST',
    body: JSON.stringify({ type: 'client-request', rpcId: 'r-k', method: 'settings.describe', payload: {} })
  })
  const kaj = await ka.json()
  expect('K3 admin 可访问设置域（未被拦截）', !(kaj.result && kaj.result.error && kaj.result.error.code === 'bad-request'))

  // ---- C: 守卫 + 服务端判定失效 → 清令牌并跳转 ----
  env = buildEnv({
    storage: { 'dshWebgate.token': 'TK-dead', 'dshWebgate.exp': String(Date.now() + 3600000) },
    responder: () => ({ ok: true, valid: false }),
  })
  await tick()
  expect('C1 失效会话跳转 /login', env.replaces()[0] === '/login')
  expect('C2 本地令牌已清除', !('dshWebgate.token' in env.storage))

  // ---- D: 本地已过期 → 直接跳转（无需请求）----
  env = buildEnv({ storage: { 'dshWebgate.token': 'TK-x', 'dshWebgate.exp': String(Date.now() - 5000) }, responder: () => ({ ok: false }) })
  await tick()
  expect('D1 过期立即跳转 /login', env.replaces()[0] === '/login')

  // ---- E: 认证服务不可达 → 原地放行（避免死循环）----
  env = buildEnv({
    storage: { 'dshWebgate.token': 'TK-y', 'dshWebgate.exp': String(Date.now() + 3600000) },
    responder: () => Promise.reject(new Error('offline')),
  })
  await tick()
  expect('E1 离线时不误杀会话', env.replaces().length === 0)
  expect('E2 恢复可见性避免白屏', env.documentElement.style.visibility === '')

  // ---- F: 登录页（page 模式）：默认中文、校验、成功后跳回 ----
  const loginResponder = (url, opts) => {
    const b = JSON.parse(opts.body)
    if (url.endsWith('/login')) {
      if (b.username === 'admin' && b.password === 'goodpass')
        return { ok: true, token: 'TK-page', expiresAt: Date.now() + 3600000, username: 'admin' }
      return { ok: false, message: '用户名或密码错误' }
    }
    return { ok: false }
  }
  env = buildEnv({ row: PAGE_ROW, responder: loginResponder })
  await tick()
  let pg = gateRoot(env)
  expect('F1 渲染中文登录卡片', (pg._html || '').includes('账号登录'))
  const goBtn = pg.querySelector('#wg-go')
  goBtn.click(); await tick()
  expect('F2 空提交提示请输入', (pg.querySelector('.wg-err').textContent || '').includes('请输入'))
  pg.querySelector('#wg-user').value = 'admin'
  pg.querySelector('#wg-pass').value = 'badpass'
  goBtn.click(); await tick()
  expect('F3 错误密码显示服务端消息', (pg.querySelector('.wg-err').textContent || '').includes('用户名或密码错误'))
  pg.querySelector('#wg-user').value = 'admin'
  pg.querySelector('#wg-pass').value = 'goodpass'
  goBtn.click(); await tick()
  expect('F4 登录成功保存令牌', env.storage['dshWebgate.token'] === 'TK-page')
  expect('F5 登录后跳回 /', env.location.href === '/')

  // ---- G: 登录页英文环境 ----
  env = buildEnv({ row: PAGE_ROW, storage: { 'dshWebgate.lang': 'en' }, responder: loginResponder })
  await tick()
  pg = gateRoot(env)
  expect('G1 英文登录卡片', (pg._html || '').includes('>Sign in</button>'))
  expect('G2 英文副标题', (pg._html || '').includes('Harness Console · Sign in'))

  // ---- H: ?next= 参数：成功后跳回指定站内路径 ----
  env = buildEnv({ row: PAGE_ROW, search: '?next=%2Fsettings', responder: loginResponder })
  await tick()
  pg = gateRoot(env)
  pg.querySelector('#wg-user').value = 'admin'
  pg.querySelector('#wg-pass').value = 'goodpass'
  pg.querySelector('#wg-go').click(); await tick()
  expect('H1 登录后跳回 next=/settings', env.location.href === '/settings')

  // ---- H2: 开放跳转防护：next 指向外部/协议地址时回退到 / ----
  env = buildEnv({ row: PAGE_ROW, search: '?next=https%3A%2F%2Fevil.example', responder: loginResponder })
  await tick()
  pg = gateRoot(env)
  pg.querySelector('#wg-user').value = 'admin'
  pg.querySelector('#wg-pass').value = 'goodpass'
  pg.querySelector('#wg-go').click(); await tick()
  expect('H2 非站内 next 回退到 /', env.location.href === '/')

  // ---- I: 会话过期看门 → 跳转 /login ----
  env = buildEnv({
    storage: { 'dshWebgate.token': 'TK-live2', 'dshWebgate.exp': String(Date.now() + 3600000) },
    responder: (url, opts) => {
      const b = JSON.parse(opts.body)
      if (url.endsWith('/session') && b.token === 'TK-live2') return { ok: true, valid: true, username: 'admin', expiresAt: Date.now() + 3600000 }
      return { ok: false }
    },
  })
  await tick()
  env.storage['dshWebgate.exp'] = String(Date.now() - 5000)
  env.intervals[0].fn(); await tick()
  expect('I1 看门到期跳转 /login', env.replaces()[0] === '/login')

  console.log(failures === 0 ? 'ALL BROWSER CHECKS PASS' : failures + ' FAILURES')
  process.exit(failures === 0 ? 0 : 1)
})().catch(e => { console.error('FAIL suite error:', e.stack || e); process.exit(1) })
