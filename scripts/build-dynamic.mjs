#!/usr/bin/env node
// 将 src/index.js（ESM 模块插件）转换为“动态 Cordis 插件”函数体形态，
// 输出到 dynamic/webgate.host.js。该产物可直接粘贴进 DSH 的 cordis_define
// 作为 code.host 运行，无需安装 npm 包。
//
// 用法：node scripts/build-dynamic.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const srcPath = path.join(root, 'src', 'index.js')
const outPath = path.join(root, 'dynamic', 'webgate.host.js')

const src = fs.readFileSync(srcPath, 'utf8')

const applyMarker = 'export function apply(ctx) {'
const idx = src.indexOf(applyMarker)
if (idx < 0) throw new Error('src/index.js 中未找到 "export function apply(ctx) {"')

let header = src.slice(0, idx)
header = header.replace(/^export const name = .*\n/mg, '')
header = header.replace(/^export const inject = .*\n/mg, '')

let rest = src.slice(idx).replace(applyMarker, "return {\n  inject: ['timer'],\n  apply(ctx) {")
if (!/\}\s*$/.test(rest)) throw new Error('src/index.js 结尾不是 apply 的收尾大括号')
rest = rest.replace(/\}\s*$/, '}\n}')

const banner = '// !! 本文件由 scripts/build-dynamic.mjs 自动生成，请勿直接编辑；源码在 src/index.js !!\n'
const out = banner + header.trimStart() + '\n' + rest.trimEnd() + '\n'

fs.mkdirSync(path.dirname(outPath), { recursive: true })
fs.writeFileSync(outPath, out, 'utf8')
console.log('OK 已生成 ' + outPath + ' (' + out.length + ' 字节)')
