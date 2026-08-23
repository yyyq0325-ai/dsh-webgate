// 浏览器侧冒烟测试：把注入脚本放进 vm 沙箱，配桩 DOM/localStorage/fetch，
// 覆盖登录、错误、成功、会话恢复、过期登出、离线重试六条路径。
// 运行：node scripts/browsersim.test.mjs
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { apply } from '../src/index.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// ---- 触发 index-inject 监听拿到注入脚本 ----
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
const ROW = table[0].text
console.log('INFO injection row length:', ROW.length)

// ---- 桩 DOM ----
class El {
  constructor(tag) {
    this.tagName = tag; this.children = []; this.parentNode = null
    this.style = {}; this._cls = new Set(); this.listeners = {}
    this.value = ''; this.innerHTML = ''; this.textContent = ''; this.offsetWidth = 0; this.disabled = false
    this._qs = {}
  }
  set innerHTML(v) { this._html = String(v) }
  get innerHTML() { return this._html || '' }
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
}

let failures = 0
function expect(name, cond) {
  if (!cond) failures++
  console.log((cond ? 'PASS ' : 'FAIL ') + name)
}

function buildEnv(initialStorage, responder) {
  const storage = Object.assign({}, initialStorage || {})
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
  const locationObj = { href: 'http://127.0.0.1:3080/', reload: () => { reloads++ } }
  const intervals = []
  let iid = 0
  const sandbox = {
    window: { localStorage: { getItem: k => (k in storage ? storage[k] : null), setItem: (k, v) => { storage[k] = String(v) }, removeItem: k => { delete storage[k] } } },
    document: documentObj,
    location: locationObj,
    fetch: (url, opts) => {
      const payload = responder(url, opts)
      if (payload && typeof payload.then === 'function') return payload // rejected promises pass through
      return Promise.resolve({ json: () => Promise.resolve(payload) })
    },
    setInterval: (fn, ms) => { intervals.push({ fn, ms, id: ++iid }); return iid },
    clearInterval: id => { const i = intervals.findIndex(x => x.id === id); if (i >= 0) intervals.splice(i, 1) },
    setTimeout: (fn) => Promise.resolve().then(fn),
    console: { log: (...a) => console.log('[vm]', ...a), error: (...a) => console.error('[vm]', ...a) },
  }
  sandbox.globalThis = sandbox
  const context = vm.createContext(sandbox)
  process.on('unhandledRejection', r => console.log('[UNHANDLED]', (r && r.stack) || r))
  vm.runInContext(ROW, context, { filename: 'webgate-row.js' })
  return { storage, documentElement, intervals, docListeners, reloads: () => reloads }
}
const tick = () => new Promise(r => setTimeout(r, 20))
const gateRoot = env => env.documentElement.children.find(c => c.id === 'wg-gate')

;(async () => {
  // A: 无令牌 → 登录表单
  buildEnv(null, () => ({ ok: true, valid: false }))
  let env = buildEnv(null, () => ({ ok: false }))
  await tick()
  let root = gateRoot(env)
  expect('A1 overlay 根节点已创建', !!root)
  expect('A2 html overflow 已锁', env.documentElement.style.overflow === 'hidden')
  expect('A5 空提交显示错误', (() => { root.querySelector('#wg-go').click(); return true })())
  await tick()
  expect('A5b 错误文案出现', (root.querySelector('.wg-err').textContent || '').includes('请输入'))

  // 国际化：默认中文（桩 DOM 不解析 innerHTML，改查渲染源码）
  expect('A6 默认中文副标题', (root._html || '').includes('账号登录'))
  expect('A7 默认中文按钮', (root._html || '').includes('>登 录</button>'))
  const langLink = root.querySelector('.wg-lang')
  expect('A8 语言切换链接显示 EN', !!langLink && langLink.textContent === 'EN')

  // 点击切换 → 记忆偏好并重渲染为英文（输入值保留）
  root.querySelector('#wg-user').value = 'someone'
  langLink.click(); await tick()
  expect('A9 切换后写入语言偏好', env.storage['dshWebgate.lang'] === 'en')
  expect('A10 切换后按钮变英文', (root._html || '').includes('>Sign in</button>'))
  expect('A11 重渲染保留已输入用户名', root.querySelector('#wg-user').value === 'someone')
  expect('A12 切换链接显示 中文', root.querySelector('.wg-lang').textContent === '中文')

  // B: 登录失败 → 成功
  env = buildEnv(null, (url, opts) => {
    const b = JSON.parse(opts.body)
    if (url.endsWith('/login') && b.username === 'admin' && b.password === 'goodpass')
      return { ok: true, token: 'TK-good', expiresAt: Date.now() + 3600000, username: 'admin' }
    return { ok: false, message: '用户名或密码错误' }
  })
  await tick()
  root = gateRoot(env)
  const goBtn = root.querySelector('#wg-go')
  root.querySelector('#wg-user').value = 'admin'
  root.querySelector('#wg-pass').value = 'badpass'
  goBtn.click(); await tick()
  expect('B1 失败登录显示服务端消息', (root.querySelector('.wg-err').textContent || '').includes('用户名或密码错误'))
  expect('B2 按钮恢复可用', goBtn.disabled === false)

  root.querySelector('#wg-user').value = 'admin'
  root.querySelector('#wg-pass').value = 'goodpass'
  goBtn.click(); await tick()
  expect('B3 成功保存 token', env.storage['dshWebgate.token'] === 'TK-good')
  expect('B4 成功保存 exp', Number(env.storage['dshWebgate.exp']) > Date.now())
  expect('B5 登录后刷新页面', env.reloads() === 1)

  // C: 有效会话直接进入
  env = buildEnv({ 'dshWebgate.token': 'TK-live', 'dshWebgate.exp': String(Date.now() + 3600000) },
    (url, opts) => {
      const b = JSON.parse(opts.body)
      if (url.endsWith('/session') && b.token === 'TK-live') return { ok: true, valid: true, username: 'admin', expiresAt: Date.now() + 3600000 }
      return { ok: false }
    })
  await tick()
  root = gateRoot(env)
  expect('C1 会话有效则遮罩隐藏', root.style.display === 'none')
  expect('C2 overflow 已恢复', env.documentElement.style.overflow === '')
  expect('C3 启动过期看门定时器', env.intervals.length === 1)
  const chip = env.documentElement.children.find(c => c.className === 'wg-chip')
  expect('C4 会话角标显示用户名', !!chip && String(chip.textContent).includes('admin'))
  ;(env.docListeners.visibilitychange || []).forEach(f => f())
  await tick()
  expect('C5 页面可见性复核正常', root.style.display === 'none')

  // D: 本地过期 → 自动登出
  env.storage['dshWebgate.exp'] = String(Date.now() - 5000)
  env.intervals[0].fn(); await tick()
  expect('D1 过期触发登出并刷新', env.reloads() === 1)
  expect('D2 令牌已清除', !('dshWebgate.token' in env.storage))

  // E: 服务端会话失效 → 回登录页
  env = buildEnv({ 'dshWebgate.token': 'TK-dead', 'dshWebgate.exp': String(Date.now() + 3600000) },
    () => ({ ok: true, valid: false }))
  await tick()
  root = gateRoot(env)
  expect('E1 失效会话回登录页', !!root.querySelector('#wg-go'))
  expect('E2 存储令牌已移除', !('dshWebgate.token' in env.storage))

  // F: 断网 → 重试恢复
  let failFetch = true
  env = buildEnv({ 'dshWebgate.token': 'TK-x', 'dshWebgate.exp': String(Date.now() + 3600000) },
    (url, opts) => {
      if (failFetch) return Promise.reject(new Error('offline'))
      const b = JSON.parse(opts.body)
      if (url.endsWith('/session')) return { ok: true, valid: true, username: 'admin', expiresAt: Date.now() + 3600000 }
      return { ok: false }
    })
  await tick()
  root = gateRoot(env)
  expect('F1 离线态显示重试按钮', !!root.querySelector('.wg-retry'))
  failFetch = false
  root.querySelector('.wg-retry').click(); await tick()
  expect('F2 重试后会话恢复', root.style.display === 'none')

  // G: 英文浏览器环境（localStorage 预设 lang=en）
  env = buildEnv({ 'dshWebgate.lang': 'en' }, () => ({ ok: true, valid: false }))
  await tick()
  root = gateRoot(env)
  expect('G1 英文界面按钮', (root._html || '').includes('>Sign in</button>'))
  expect('G2 英文副标题', (root._html || '').includes('Harness Console · Sign in'))
  expect('G3 切换链接显示 中文', root.querySelector('.wg-lang').textContent === '中文')

  console.log(failures === 0 ? 'ALL BROWSER CHECKS PASS' : failures + ' FAILURES')
  process.exit(failures === 0 ? 0 : 1)
})().catch(e => { console.error('FAIL suite error:', e.stack || e); process.exit(1) })
