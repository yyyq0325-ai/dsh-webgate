// 宿主侧逻辑检查：用 mock 服务跑 apply()，覆盖路由注册、index 注入安全、
// 引导管理员持久化、登录/会话/注销全链路。同时验证 dynamic/ 产物可加载。
// 运行：node scripts/check.mjs
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { apply } from '../src/index.js'

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

let failures = 0
function expect(name, cond) {
  if (!cond) failures++
  console.log((cond ? 'PASS ' : 'FAIL ') + name)
}

// ---------- mock 服务 ----------
function makeMocks() {
  const registeredRoutes = new Map()
  const listeners = {}
  const effectsRan = []
  const fakeCredentials = {
    store: new Map(),
    async readRecord(key) { return this.store.get(key) },
    async modifyRecord(key, mutate) {
      const next = await mutate(this.store.get(key))
      if (next === undefined) this.store.delete(key)
      else this.store.set(key, next)
      return next
    },
  }
  const fakeWebServer = {
    register(route) {
      registeredRoutes.set(route.kind + ' ' + route.path, route.handler)
      return () => registeredRoutes.delete(route.kind + ' ' + route.path)
    },
    tapIndex() { return () => { } },
  }
  const registeredTools = []
  const registeredCommands = []
  const commandDefs = {}
  const fakeCommands = { register(def) { registeredCommands.push(def.name); commandDefs[def.name] = def; return () => { } } }
  const fakeTools = { register(def) { registeredTools.push(def.name); return () => { } } }
  const ctx = {
    get(name) {
      if (name === 'credentials') return fakeCredentials
      if (name === 'webServer') return fakeWebServer
      if (name === 'commands') return fakeCommands
      if (name === 'tools') return fakeTools
      return undefined
    },
    on(name, fn) { (listeners[name] = listeners[name] || []).push(fn); return () => { } },
    effect(fn) { effectsRan.push(fn); const d = fn && fn(); return typeof d === 'function' ? d : () => { } },
    timeout(ms) { return new Promise(r => setTimeout(r, ms)) },
  }
  return { ctx, registeredRoutes, listeners, fakeCredentials, registeredTools, commandDefs }
}

// ---------- 对一个插件对象执行完整断言 ----------
async function runSuite(tag, plugin) {
  const m = makeMocks()
  expect(`[${tag}] apply 存在`, typeof plugin.apply === 'function')
  plugin.apply(m.ctx)

  const routes = m.registeredRoutes
  expect(`[${tag}] 注册 6 条路由（含 /login）`,
    ['exact /login', 'exact /auth/page', 'exact /auth/api/health', 'exact /auth/api/login', 'exact /auth/api/session', 'exact /auth/api/logout']
      .every(k => routes.has(k)))
  expect(`[${tag}] index-inject 监听就位`, (m.listeners['webserver/index-inject'] || []).length === 1)

  // 注入行安全与语法
  const rows = []
  m.listeners['webserver/index-inject'][0](rows)
  expect(`[${tag}] 推送一行注入`, rows.length === 1)
  const rowText = rows[0].text
  expect(`[${tag}] 注入文本不含 </script`, !rowText.toLowerCase().includes('</script'))
  new Function(rowText) // 必须是合法 JS
  console.log(`[${tag}] PASS 注入脚本可解析，长度=${rowText.length}`)

  // 等待异步引导完成（写入初始管理员）
  await new Promise(r => setTimeout(r, 250))
  let stored = m.fakeCredentials.store.get('webgate/users')
  let payload = stored && stored.payload
  if (typeof payload === 'string') { try { payload = JSON.parse(payload) } catch { payload = null } }
  expect(`[${tag}] 初始管理员已持久化（字符串 payload）`, !!payload && !!payload.users && !!payload.users.admin)
  expect(`[${tag}] 初始管理员角色为 admin`, !!payload && !!payload.users.admin && payload.users.admin.role === 'admin')

  function makeRes() {
    return {
      statusCode: null, headers: null, body: '',
      writeHead(s, h) { this.statusCode = s; this.headers = h },
      end(b) { this.body = b || '' },
    }
  }
  function makeReq(obj, headers) {
    return {
      method: 'POST',
      headers: headers || {},
      on(ev, cb) {
        if (ev === 'data') setTimeout(() => cb(Buffer.from(JSON.stringify(obj || {}))), 0)
        if (ev === 'end') setTimeout(cb, 8)
      },
    }
  }

  // 错误密码（默认中文）
  let res = makeRes()
  await routes.get('exact /auth/api/login')(makeReq({ username: 'admin', password: 'definitely-wrong' }), res)
  const bad = JSON.parse(res.body)
  expect(`[${tag}] 错误密码被拒绝（默认中文）`, bad.ok === false && bad.message === '用户名或密码错误')

  // 错误密码（Accept-Language: en → 英文文案）
  res = makeRes()
  await routes.get('exact /auth/api/login')(makeReq({ username: 'admin', password: 'definitely-wrong' }, { 'accept-language': 'en-US,en;q=0.9' }), res)
  const badEn = JSON.parse(res.body)
  expect(`[${tag}] 错误提示跟随 Accept-Language`, badEn.ok === false && badEn.message === 'Incorrect username or password')

  // 独立登录页标题本地化
  res = makeRes()
  await routes.get('exact /auth/page')({ method: 'GET', headers: {}, on() { } }, res)
  expect(`[${tag}] /auth/page zh 标题`, res.body.includes('登录</title>'))
  res = makeRes()
  await routes.get('exact /auth/page')({ method: 'GET', headers: { accept: 'text/html', 'accept-language': 'en' }, on() { } }, res)
  expect(`[${tag}] /auth/page en 标题`, res.body.includes('Sign in</title>'))

  // 正确密码 → 12h 令牌 + Cookie
  res = makeRes()
  await routes.get('exact /auth/api/login')(makeReq({ username: 'admin', password: 'admin1234' }), res)
  const good = JSON.parse(res.body)
  expect(`[${tag}] 正确登录签发令牌`, !!(good.ok && good.token && good.username === 'admin'))
  expect(`[${tag}] 有效期约 12 小时`, Math.abs(good.expiresAt - Date.now() - 12 * 3600 * 1000) < 60000)
  expect(`[${tag}] 响应种下 webgate_token Cookie`, String((res.headers && res.headers['Set-Cookie']) || '').includes('webgate_token='))

  // /login 路由返回登录页
  res = makeRes()
  await routes.get('exact /login')({ method: 'GET', headers: {}, on() { } }, res)
  expect(`[${tag}] /login 返回登录页`, (res.body || '').includes('登录</title>'))

  // 会话校验
  res = makeRes()
  await routes.get('exact /auth/api/session')(makeReq({ token: good.token }), res)
  const sess = JSON.parse(res.body)
  expect(`[${tag}] 会话有效`, sess.ok && sess.valid && sess.username === 'admin')
  expect(`[${tag}] 会话响应携带 perms(admin)`, !!sess.perms && sess.perms.role === 'admin')

  // ---------- 角色与工作区授权（经命令处理器驱动 cores） ----------
  const inv = (rawInput) => ({ rawInput, agent: {}, attachments: [], signal: undefined })
  const run = async (name, line) => {
    const def = m.commandDefs[name]
    if (!def) return { kind: 'error', text: 'no command ' + name }
    return await def.handler(inv(line))
  }

  let r = await run('useradd', 'alice secret1 wrong-admin-pwd')
  expect(`[${tag}] 错误管理员密码拒绝添加`, r.kind === 'error' && r.text.includes('管理员密码错误'))
  r = await run('useradd', 'alice secret1')
  expect(`[${tag}] 缺少管理员密码拒绝添加`, r.kind === 'error' && r.text.includes('Usage'))
  r = await run('useradd', 'alice secret1 admin1234')
  expect(`[${tag}] 正确管理员密码添加成功`, r.kind === 'success')
  stored = m.fakeCredentials.store.get('webgate/users')
  payload = typeof stored.payload === 'string' ? JSON.parse(stored.payload) : stored.payload
  expect(`[${tag}] alice 为 member 且无工作区`,
    payload.users.alice.role === 'member' && Array.isArray(payload.users.alice.workspaces) && payload.users.alice.workspaces.length === 0)

  r = await run('grant', 'alice D:\\proj-a admin1234')
  expect(`[${tag}] grant 授权成功`, r.kind === 'success')
  r = await run('grant', 'alice * admin1234'.replace('* ', '') + 'x') // 非法占位，不应破坏状态
  expect(`[${tag}] grant 参数不足报错`, r.kind === 'error')
  r = await run('revoke', 'alice D:\\proj-a admin1234')
  expect(`[${tag}] revoke 撤销成功`, r.kind === 'success')

  // member 登录后 perms 只含被授予的工作区
  r = await run('grant', 'alice D:\\proj-a admin1234')
  expect(`[${tag}] 再次授权成功`, r.kind === 'success')
  res = makeRes()
  await routes.get('exact /auth/api/login')(makeReq({ username: 'alice', password: 'secret1' }), res)
  const aliceLogin = JSON.parse(res.body)
  if (aliceLogin.ok) {
    expect(`[${tag}] alice 登录携带 member perms`, aliceLogin.perms.role === 'member'
      && aliceLogin.perms.workspaces.includes('d:\\proj-a'))
  } else {
    expect(`[${tag}] alice 登录（校验点）`, false)
  }

  // 注销后失效
  res = makeRes()
  await routes.get('exact /auth/api/logout')(makeReq({ token: good.token }), res)
  res = makeRes()
  await routes.get('exact /auth/api/session')(makeReq({ token: good.token }), res)
  expect(`[${tag}] 注销后令牌失效`, JSON.parse(res.body).valid === false)
}

// ---------- 形态 A：ESM 模块（npm 包形态） ----------
await runSuite('src', { inject: ['timer', 'webServer', 'credentials', 'commands', 'tools'], apply })

// ---------- 形态 B：动态插件函数体产物 ----------
const dynPath = path.join(root, 'dynamic', 'webgate.host.js')
if (fs.existsSync(dynPath)) {
  const body = fs.readFileSync(dynPath, 'utf8')
  const wrappedFile = path.join(root, '.check-dynamic.wrapped.cjs')
  fs.writeFileSync(wrappedFile, 'module.exports = function (ctx, harness) {\n' + body + '\n}\n')
  const mod = require(wrappedFile)
  const plugin = mod({}, {})
  expect('dynamic 产物返回插件对象', !!plugin && typeof plugin.apply === 'function')
  const expectedInject = ['timer', 'webServer', 'credentials', 'commands', 'tools']
  expect('dynamic 产物声明完整 inject 依赖（与 src 一致）', JSON.stringify(plugin.inject) === JSON.stringify(expectedInject))
  await runSuite('dynamic', plugin)
  fs.rmSync(wrappedFile, { force: true })
} else {
  console.log('SKIP dynamic/webgate.host.js 不存在（先运行 node scripts/build-dynamic.mjs）')
}

console.log(failures === 0 ? 'ALL HOST CHECKS PASS' : failures + ' FAILURES')
process.exit(failures === 0 ? 0 : 1)
