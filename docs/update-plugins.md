# 如何更新 DSH profile 里的插件（Windows / phpEnv 环境实录）

> 本文件记录**你下次手动更新插件**的正确姿势与踩过的坑。以 `@linxin666/dsh-web-all` 从 0.3.19 → 0.3.20 的实操为例。

## TL;DR（照抄即可）

```powershell
# 1) 停掉正在跑的 dsh (到终端 Ctrl+C)

# 2) 进入 profile 目录
cd $HOME\.dsh\profiles\web

# 3) 升级指定插件到最新版
npx --yes pnpm@10.15.1 add @linxin666/dsh-web-all@latest

# 4) 安全检查：确认没有旧版 @deepseek-ai 影子包（有内容 = 危险，见下）
Get-ChildItem .\node_modules\@deepseek-ai -ErrorAction SilentlyContinue

# 5) 重启 dsh
cd D:\code\deepseek-harness
pnpm dsh web
```

## 为什么用 `npx pnpm@10.15.1`,而不是 `dsh plugin add`

| 方式 | 结论 |
|---|---|
| `dsh plugin --profile web add <pkg>`（**npm 上的 dsh CLI**） | ❌ 版本可能与你实际运行的 dsh 不一致 |
| `pnpm dsh plugin --profile web add <pkg>`（**alpha5 仓库内 CLI**） | ❌ 本机报 pnpm store 版本冲突：<br>`pnpm now wants to use the store at ...\pnpm\store\v11` |
| `npx --yes pnpm@10.15.1 add <pkg>@latest`（**profile 目录下**） | ✅ 与 profile 现有 `node_modules` 同版本 pnpm,实测成功 |

关键点是**版本要与 profile 当初的安装方式一致**。profile 的 `pnpm-workspace.yaml` 就是 pnpm 建的,所以直接用 pnpm。

## 绝对不要做的事：在 profile 目录用 npm

```powershell
# ❌ 千万不要
cd $HOME\.dsh\profiles\web
npm install @linxin666/dsh-web-all
```

npm 会**自动安装 peerDependencies**,把 `@linxin666/dsh-web-all` 声明的旧版 `@deepseek-ai/*@0.1.0-rc.8` 整套拉进 `profiles\web\node_modules\@deepseek-ai\`。

后果：cordis Loader 以 profile 目录为解析锚点，旧版 `dsh-host-webserver` 会**遮蔽** Harness 自带的新版 → 两版 API 不匹配（新版 frontend-static 调用旧版不存在的 `renderIndex`）→ **所有页面返回空 body 400 / 其余 404**,且卸载插件也无法恢复。这就是 README「排查：装卸插件后全站 400/404」那一节的成因。

pnpm 遵守 profile `pnpm-workspace.yaml` 里的 `autoInstallPeers: false`,所以安全。

## 升级后必查的一项：影子包

```powershell
Get-ChildItem $HOME\.dsh\profiles\web\node_modules\@deepseek-ai -ErrorAction SilentlyContinue
```

- **没有输出**（目录不存在或为空）→ 安全。空目录可直接删掉。
- **有子目录** → 说明旧版包又混进来了，重启 dsh 前务必移走：
  ```powershell
  Rename-Item $HOME\.dsh\profiles\web\node_modules\@deepseek-ai _stale-deepseekai-backup
  ```
  重启 dsh 确认页面正常后，再把 `_stale-deepseekai-backup` 删除。

本次 0.3.19→0.3.20 实测：pnpm 只建了**空**的 `@deepseek-ai` 目录（无旧包），已清理，属正常现象。

## 查看当前装了哪些版本

```powershell
cd $HOME\.dsh\profiles\web
# profile 声明的 bundles（激活顺序）
(Get-Content .\package.json -Raw | ConvertFrom-Json).dsh.profile.bundles
# 某个包的实际版本
(Get-Content .\node_modules\@linxin666\dsh-web-all\package.json -Raw | ConvertFrom-Json).version
# 手动补丁层（正常应为 []）
Get-Content .\cordis.patch.yml
```

如果 `cordis.patch.yml` 里出现一堆 `disabled: true`,那是当初为排查兼容性关掉的插件，确认无问题后可清理（保留空数组 `[]` 即可）。

## 只想更新某一个包 / 全部更新

```powershell
cd $HOME\.dsh\profiles\web

# 指定包升到最新
npx --yes pnpm@10.15.1 add @linxin666/dsh-web-all@latest

# 指定具体版本
npx --yes pnpm@10.15.1 add @linxin666/dsh-web-all@0.3.20

# 全部依赖按 semver 范围升级（谨慎，一次升太多不好定位问题）
npx --yes pnpm@10.15.1 update
```

一次只升一个、升完重启验证，是最省时间的节奏。

## 更新 WebGate 自身

WebGate 已发布在 npm 后，标准路径就是一条命令：

```powershell
cd $HOME\.dsh\profiles\web
npx --yes pnpm@10.15.1 add @yyyq0325/dsh-webgate@latest
```

**本地开发验证**（源码改完但还没发 npm 时）用 tarball，别用裸路径：

```powershell
cd D:\code\dsh-auth
npm pack                                          # 生成 yyyq0325-dsh-webgate-x.y.z.tgz
npx --yes pnpm@10.15.1 --dir $HOME\.dsh\profiles\web add "$PWD\yyyq0325-dsh-webgate-x.y.z.tgz"
```

> ⚠️ 不要用 `dsh plugin add D:\code\dsh-auth` 这种**裸盘符绝对路径**：pnpm 会把它拼成非法 junction（目标变成 `...\profiles\web\D:\code\dsh-auth`），CLI 误报 "declares no dsh.bundle" 且不激活插件。tarball 路径没有这个问题。
