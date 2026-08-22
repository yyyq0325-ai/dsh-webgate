// 密码学自检：验证插件内置的纯 JS SHA-256 / HMAC-SHA256 / PBKDF2 实现。
// 这些向量与 Node 内置 crypto 实现逐字节对比。
// 运行：node scripts/crypto-selftest.mjs
import nodeCrypto from 'node:crypto'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const src = fs.readFileSync(path.join(root, 'src', 'index.js'), 'utf8')

// 从源码中切出纯 JS 实现（K256 到 pbkdf2Sha256 结束），在沙箱里执行以获得函数
const start = src.indexOf('const K256 = [')
const end = src.indexOf('// ---------- 编码小工具 ----------')
if (start < 0 || end < 0) throw new Error('未能在 src/index.js 中定位密码学实现段')
const code = src.slice(start, end)

const sandbox = {}
vm.createContext(sandbox)
vm.runInContext(code + '\nthis.__api = { sha256Bytes, hmacSha256, pbkdf2Sha256 }', sandbox)
const { sha256Bytes, hmacSha256, pbkdf2Sha256 } = sandbox.__api

const enc = new TextEncoder()
const hex = (u8) => Array.from(u8).map(x => x.toString(16).padStart(2, '0')).join('')

let failures = 0
function expect(name, got, want) {
  const ok = String(got) === String(want)
  if (!ok) failures++
  console.log((ok ? 'PASS' : 'FAIL') + ' ' + name + (ok ? '' : '\n  got  ' + got + '\n  want ' + want))
}

// 已知标准向量
expect("sha256('abc')", hex(sha256Bytes(enc.encode('abc'))), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
expect("sha256('')", hex(sha256Bytes(enc.encode(''))), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
expect('sha256 448-bit msg', hex(sha256Bytes(enc.encode('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))), '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1')

// 填充边界 vs Node
for (const len of [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000]) {
  const buf = nodeCrypto.randomBytes(len)
  expect('sha256 len=' + len, hex(sha256Bytes(new Uint8Array(buf))), nodeCrypto.createHash('sha256').update(buf).digest('hex'))
}

// HMAC vs Node
for (const klen of [0, 1, 32, 63, 64, 65, 200]) {
  const k = nodeCrypto.randomBytes(klen), m = nodeCrypto.randomBytes(37)
  expect('hmac keylen=' + klen, hex(hmacSha256(new Uint8Array(k), new Uint8Array(m))),
    nodeCrypto.createHmac('sha256', k).update(m).digest('hex'))
}

// PBKDF2 标准向量与交叉验证
expect('pbkdf2 p/s/1', hex(pbkdf2Sha256(enc.encode('password'), enc.encode('salt'), 1, 32)), '120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b')
expect('pbkdf2 p/s/2 dk40', hex(pbkdf2Sha256(enc.encode('password'), enc.encode('salt'), 2, 40)),
  nodeCrypto.pbkdf2Sync('password', 'salt', 2, 40, 'sha256').toString('hex'))
expect('pbkdf2 4096', hex(pbkdf2Sha256(enc.encode('password'), enc.encode('salt'), 4096, 32)),
  nodeCrypto.pbkdf2Sync('password', 'salt', 4096, 32, 'sha256').toString('hex'))

// 长密码（>64 字节触发密钥散列）与中文 UTF-8
expect('pbkdf2 long pass', hex(pbkdf2Sha256(enc.encode('p'.repeat(100)), enc.encode('salt'), 77, 32)),
  nodeCrypto.pbkdf2Sync('p'.repeat(100), 'salt', 77, 32, 'sha256').toString('hex'))
expect('pbkdf2 cjk pass', hex(pbkdf2Sha256(enc.encode('密码测试123'), enc.encode('盐水salty'), 500, 32)),
  nodeCrypto.pbkdf2Sync('密码测试123', '盐水salty', 500, 32, 'sha256').toString('hex'))

// 插件实际使用的迭代次数性能摸底
const t0 = Date.now()
pbkdf2Sha256(enc.encode('admin1234'), enc.encode('0123456789abcdef'), 20000, 32)
console.log('INFO pbkdf2 iter=20000 took', (Date.now() - t0), 'ms')

console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURES')
process.exit(failures === 0 ? 0 : 1)
void pathToFileURL
