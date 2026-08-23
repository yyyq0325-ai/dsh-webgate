#!/usr/bin/env node
// WebGate 小工具：用与插件完全相同的纯 JS PBKDF2 实现，校验
// $DSH_HOME/.credentials.yaml 中存储的用户哈希是否匹配给定密码。
// 用于确认/排查登录凭据（脚本只读本地文件，不发起任何网络请求）。
//
// 用法：node scripts/check-password.mjs <密码> [用户名]
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const password = process.argv[2]
const username = process.argv[3] || 'admin'
if (!password) {
  console.error('用法：node scripts/check-password.mjs <密码> [用户名]（默认用户名 admin）')
  process.exit(1)
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const src = fs.readFileSync(path.join(root, 'src', 'index.js'), 'utf8')

// 从插件源码切出纯 JS 哈希实现段（K256 → pbkdf2Sha256），保证与运行时逐字节一致
const start = src.indexOf('const K256 = [')
const end = src.indexOf('// ---------- 编码小工具 ----------')
if (start < 0 || end < 0) throw new Error('未能在 src/index.js 中定位密码学实现段')
const code = src.slice(start, end)

const sandbox = { TextEncoder, TextDecoder, btoa: s => Buffer.from(s, 'binary').toString('base64') }
vm.createContext(sandbox)
vm.runInContext(code + `
  const __utf8 = new TextEncoder()
  function hexToBytes(h) { const o = new Uint8Array(h.length / 2); for (let i = 0; i < o.length; i++) o[i] = parseInt(h.substr(i * 2, 2), 16); return o }
  this.__hash = function (pass, saltHex, iter) {
    const d = pbkdf2Sha256(__utf8.encode(String(pass)), hexToBytes(saltHex), iter, 32)
    let s = ''
    for (let i = 0; i < d.length; i++) s += String.fromCharCode(d[i])
    return btoa(s)
  }
`, sandbox)

const credPath = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), '.credentials.yaml')
const yaml = fs.readFileSync(credPath, 'utf8')
const m = yaml.match(/webgate\/users:\s*\r?\n\s*kind: grant\s*\r?\n\s*payload: '(.*)'/)
if (!m) { console.error('未在 ' + credPath + ' 中找到 webgate/users 记录'); process.exit(1) }

let users
try { users = JSON.parse(m[1]).users } catch (e) { console.error('payload 解析失败:', e.message); process.exit(1) }
const rec = users[username]
if (!rec) { console.log('用户不存在:', username, '| 现有用户:', Object.keys(users).join(', ')); process.exit(1) }

const ok = sandbox.__hash(password, rec.salt, rec.iter || 20000) === rec.hash
console.log('用户 ' + username + ' 密码匹配: ' + ok + '（记录创建于 ' + (rec.createdAt || '?') + '）')
process.exit(ok ? 0 : 2)
