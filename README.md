# WebGate — DeepSeek Harness Web 登录门禁

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 Web GUI 加一道账号密码门：每次打开 DSH Web 都必须先登录；登录令牌有效期 **12 小时**；令牌过期被登出时，**后台正在运行的任务完全不受影响**，重新登录后一切还在。

📋 更新日志（新功能与破坏性变更都记录在这里）：**[CHANGELOG.zh.md](CHANGELOG.zh.md)**

![login](docs/login-preview.png)

## 特性

- 🔐 **路由级登录门禁** — 通过 `webserver/index-inject` 向每个 `index.html` 注入守卫脚本：无令牌或过期立即 `location.replace('/login')` 跳转到独立登录页，登录后跳回原地址；守卫同步执行并临时隐藏文档，应用内容零闪现
- ⏱ **12 小时会话令牌** — 绝对有效期；前端 30 秒巡检 + 页面重新可见时向服务端复核；过期自动回到登录页
- 🚀 **后台任务零打扰** — 门禁只作用于浏览器视图层，Host 端的会话、后台任务、子代理照常运行
- 🎨 **DeepSeek 官网风格登录页** — 深蓝紫渐变 + 毛玻璃卡片 + 品牌蓝渐变按钮 + 鲸鱼徽标 SVG，另有独立登录页 `/auth/page`
- 🛠 **用户管理命令** — `/useradd` `/passwd` `/userlist` `/userdel`（密码不写入会话日志），另有 `webgate_user_*` 模型工具可让 Agent 代管
- 💾 **持久化** — 用户库存放在 `$DSH_HOME/.credentials.yaml` 的 grant record 中，随 Harness 自身凭据文件一起管理，插件重启自动恢复
- 🌐 **中英双语，默认中文** — 登录卡片右下角可一键切换「EN / 中文」（偏好记忆在本地）；英文浏览器自动切换；API 错误消息跟随请求的 `Accept-Language`
- 👥 **账号角色与工作区授权（实验性）** — admin / member 两级角色；成员仅能看到被 `/grant` 授予的工作区；所有变更命令采用「管理员密码 sudo」模式
- 🧩 **零依赖** — 纯 JavaScript 单文件实现；动态沙箱里没有 node:crypto，密码哈希使用内置 PBKDF2-HMAC-SHA256（20000 次迭代，已通过标准测试向量验证）

## 安装

> ✅ 本包已发布到 npm：**`@yyyq0325/dsh-webgate`**。npm 安装是现在的推荐方式（版本化、可锁定、无 Git 依赖）。
> ⚠️ 裸名 `dsh-webgate` 是另一个无关包，请勿使用。

### 方式 A：npm（推荐）

```bash
dsh plugin --profile web add @yyyq0325/dsh-webgate
```

安装命令会依据 `package.json` 的 `dsh.bundle.patch` 声明自动挂载本插件，重启 dsh 后生效。升级同样一条命令（或 `npm update @yyyq0325/dsh-webgate` 后重启）。

### 方式 B：从 GitHub 安装

```bash
dsh plugin --profile web add github:yyyq0325-ai/dsh-webgate
```

适合在官方 npm 版发布前体验最新分支（默认取仓库默认分支；可用 `#分支名` 指定）。

### 方式 C：手动挂载

把 [`cordis.patch.yml`](cordis.patch.yml) 中的 insert 行复制进 profile 的补丁文件 `~/.dsh/profiles/web/cordis.patch.yml`：

```yaml
- insert:
    - id: webgate
      name: '@yyyq0325/dsh-webgate'
```

并确保本包已安装到 profile 可解析的位置（如 profile 目录下 `npm i @yyyq0325/dsh-webgate`）。

### 方式 C：临时动态插件（免安装）

不修改任何配置，直接在支持动态插件的会话中用 `cordis_define` 运行 [`dynamic/webgate.host.js`](dynamic/webgate.host.js) 的内容作为 `code.host`。该文件由 `npm run build:dynamic` 从 `src/index.js` 自动生成。

## 快速开始

首次激活时自动创建初始管理员：

```
用户名：admin
密码：admin1234
```

**登录后请立即修改密码：**

```
/passwd admin 你的新密码
```

界面语言：登录卡片右下角点击「EN / 中文」即可切换并记住偏好；默认中文，英文浏览器自动切换为英文。`/auth/page` 独立页与全部 API 提示同样双语（接口按 `Accept-Language` 协商）。

添加用户 / 管理（**所有变更命令都要求在末尾附带任意管理员账号的密码**，即"sudo 口令"模式——只有知道管理员密码的人才能改动账号体系）：

| 命令 | 说明 |
|---|---|
| `/useradd <用户名> <密码> <管理员密码>` | 添加 member 用户（用户名 2-32 位字母数字点下划线短横线；密码 6-128 位） |
| `/passwd <用户名> <新密码> <管理员密码>` | 修改密码，该用户现有会话立即全部失效 |
| `/userlist` | 列出用户、角色、工作区授权与活跃会话数 |
| `/userdel <用户名> <管理员密码>` | 删除用户（至少保留一个管理员） |
| `/grant <用户名> <工作区路径\|标题\|*> <管理员密码>` | 授予成员一个工作区的可见性；`*` 表示全部 |
| `/revoke <用户名> <工作区路径\|标题\|*\|all> <管理员密码>` | 撤销成员的工作区可见性；`*`/`all` 清空全部授权 |

## 角色与工作区权限（v0.2.0 · 实验性）

- **admin**：拥有全部工作区与管理能力（初始 `admin` 账号即为 admin）。
- **member**：登录后只能看到被 `/grant` 授予的工作区（按完整路径或标题匹配，大小写不敏感），未被授予的条目会在客户端被过滤隐藏，对其余工作区的操作无从发起。
- 授权变更会立即撤销该成员的现有会话，重新登录后生效新权限。
- **界面裁剪**：member 会话自动隐藏左下角设置入口、工作区搜索按钮与列表头操作区（含添加工作区）；同时拒绝 `settings.*`、`workspace.create`、`session.search`、`host.createDirectory` 等 RPC（返回标准错误信封，界面优雅报错）。
- ⚠️ 强度说明：工作区过滤运行在浏览器端（守卫脚本包装 fetch 实现），定位是"防误触"而非对抗有意绕过——详见下方[安全边界](#安全边界请务必阅读)。服务端级强制需要上游提供中间件/网关鉴权点。

诊断接口：`GET /auth/api/health` 返回服务可用性与用户库状态。

## 启用 / 停用 / 卸载（防锁死指南）

> 建议：先用**动态插件模式**试用，确认满意后再考虑持久安装。

### 动态插件模式（不落盘，随时可撤）

在支持动态插件的 DSH 会话中，把 [`dynamic/webgate.host.js`](dynamic/webgate.host.js) 的内容作为 `code.host` 交给 `cordis_define`，再 `cordis_run` 即可。此模式：

- **不写入任何配置文件**，`~/.dsh/profiles/<profile>/cordis.patch.yml` 保持原样；
- **dsh 进程重启后门禁自动消失**，无需任何清理操作；
- 随时让 Agent 执行 `cordis_stop <pluginId>` 立即停用，页面立刻恢复原样（插件定义保留，一条命令可再次启用）。

### npm 安装版的停用与卸载

```bash
dsh plugin --profile web remove @yyyq0325/dsh-webgate
```

### 手动 patch 行的停用与卸载

编辑 `~/.dsh/profiles/web/cordis.patch.yml`，将插件行加上 `disabled: true`（保留配置停用）或整行删除（彻底卸载），重启 dsh 生效：

```yaml
- insert:
    - id: webgate
      name: '@yyyq0325/dsh-webgate'
      disabled: true   # 停用；或删除整个条目卸载
```

### 忘记密码怎么办

1. 打开 `$DSH_HOME/.credentials.yaml`（默认 `~/.dsh/.credentials.yaml`）；
2. 删除 `records:` 段下 `webgate/users:` 的整段记录（**其他内容一律不动**）；
3. ⚠️ 如果删除后 `records:` 下面已经没有任何条目，必须把 `records:` 这一行也一并删除（或改写成 `records: {}`）。留一个空值的 `records:` 键会让 YAML 把它解析成 null，插件写入用户记录时会报 `Expected YAML collection at records`；
4. 重启 dsh —— 插件启动时发现没有用户，会重新引导初始账号 `admin / admin1234`。

> 该文件里同时保存着 API Key 等其他凭据，只删 `webgate/users` 那一段即可，其余行请保持原样。

### 兜底原则

本插件只注册自己的路由/监听/命令，除上述一条凭据记录外不修改任何 Harness 数据。无论出现何种异常，按上面任一方式停用插件并重启 dsh，即可完全恢复到安装前状态。

### 排查：装卸插件后全站 400/404

**症状**：安装或卸载任意插件后 Web 全挂——`/` 与 `/index.html` 返回空 body 的 400，其余路径 404；卸载插件、重启 dsh 均无效。

**原因**：部分第三方插件把 peerDependencies 钉在旧版 `@deepseek-ai/*` 上。在 profile 目录里执行安装时，这些旧版包会被物化到 `~/.dsh/profiles/web/node_modules/@deepseek-ai/`，而 cordis Loader 以 profile 目录为锚解析路由插件，旧版 `@deepseek-ai/dsh-host-webserver` 就会遮蔽 Harness 自带的新版；两个版本的 API 不匹配（新版 frontend-static 每次渲染 index 都要调用旧版上不存在的 `renderIndex`），于是所有页面都抛异常。

**修复**：

1. 完全退出 dsh；
2. 把旧版影子目录改名移走（确认恢复后可删除备份）：

   ```powershell
   Rename-Item ~/.dsh/profiles/web/node_modules/@deepseek-ai _stale-deepseekai-backup
   ```

3. 重启 dsh。这些包会经由 `$DSH_HOME/profiles/node_modules` 的软链接回退解析到 Harness 自带版本；
4. 页面恢复正常后删除 `_stale-deepseekai-backup`。

**预防**：往 profile 安装插件一律走 `dsh plugin --profile web add <pkg>`（底层 pnpm，遵守 `autoInstallPeers: false`）；不要在 profile 目录手动跑 npm 安装——npm 会自动安装 peer 依赖，容易再次引入版本漂移。

## 工作原理

```
浏览器 ── GET / ──▶ webServer(fallback=静态 dist)
                     │ renderIndex()
                     │ ├─ 结构化注入表（webserver/index-inject 事件）
                     │ │   └─ WebGate：<script>守卫脚本</script>
                     ▼
   无令牌/过期 → location.replace('/login') ──▶ 独立登录页（双语）
                                                  │ POST /auth/api/login
                                                  ▼ 校验 PBKDF2 哈希，签发 12h 令牌
   登录成功 ◀── Cookie + localStorage 写入 token/exp ─┘ → 跳回 next（默认 /）
   已认证 → 正常使用（30s 巡检 + visibilitychange 服务端复核 + 会话角标）
```

- **密码存储**：`PBKDF2-HMAC-SHA256(20000 iter, 16B random salt)`，常数时间比较；命令参数带密码时不写入会话日志（`recordInput: false`）
- **用户库**：一条 credentials grant record（key `webgate/users`），payload 为 JSON 字符串——字符串是原始值，可安全跨越动态插件沙箱与宿主之间的 realm 边界
- **生命周期**：所有路由、监听、命令、工具注册均挂在插件 Fiber 上，停止/更新插件自动清理

## 安全边界（请务必阅读）

这是一个面向**本地个人工具**的入口门禁，不是企业级安全方案。当前为「守卫跳转」模式：守卫脚本运行在浏览器里，**理论上可以被 DevTools 禁用或删除**——绕过后页面外壳与 `/api` 数据通道仍然可达。原因与边界：

1. DSH 的 `/api` 数据通道由 `@deepseek-ai/dsh-client-connection` 以命名前缀路由注册在 webServer 上：路由一经注册不可覆盖、最长前缀优先使其他路由无法遮蔽它，而 webServer 本身没有请求中间件缝隙。因此动态插件**无法在服务端对 `/api` 强制鉴权**，这是当前 Harness 扩展点的硬限制，不是本插件的选择。
2. 默认只监听 `127.0.0.1`；若改为 `0.0.0.0` 暴露到局域网，**务必**在前面加反向代理（Caddy/nginx Basic Auth 等）做真正的服务端鉴权。现成 nginx 配置模板见 [`deploy/nginx/`](deploy/nginx/)：方案 A `basic-auth.conf`（Basic Auth 总闸）、方案 B `auth-request.conf`（auth_request 对接 WebGate 会话，需本插件 ≥ 0.2.2）。两份模板默认**纯 HTTP、无域名无证书**即可使用（可信局域网内；出公网请按文末注释启用 HTTPS）。方案 A 的口令文件是**一次性动作**、通常一个共享账号就够（Windows 下生成方法见模板注释）；方案 B 完全不需要口令文件。
3. 初始管理员密码是公开的默认值，部署后第一件事就是改密码。
4. 登录令牌保存在浏览器 localStorage 与内存中；同时下发 `webgate_token` Cookie（SameSite=Lax）——配合 [`deploy/nginx/auth-request.conf`](deploy/nginx/auth-request.conf) 反代方案，这个 Cookie 就是服务端强制鉴权的校验凭据（`auth_request` → `/auth/api/verify`）。

> 🔒 **强烈建议：任何离开本机的访问场景都套用 nginx 反代方案。**
> 只要工作台会被内网穿透（cloudflared/frp 等）或部署到服务器上，守卫脚本就是唯一防线——它跑在浏览器里，可被 DevTools 禁用或删除；而反代方案把会话校验搬到服务端，绕过守卫也触达不了页面外壳与 `/api`。这不是"多一层保险"，而是安全性质从软变硬。仅 `127.0.0.1` 本机自用时不配 nginx，插件功能完整可用。
>
> 🛡 **对「伪造 `Host` 头绕过信任围栏」类漏洞同样有效**：这类漏洞的利用链是攻击者与 dsh 端口直接对话，构造 `Host: 127.0.0.1` 冒充回环受信来源，进而调用高权限 RPC、以服务进程权限驱动 Agent 工具。反代架构把这条链从源头掐断——dsh 只绑回环且端口不对外放行，外界只能面对 nginx；未通过鉴权（口令 / WebGate 会话）的请求在到达 dsh 之前就被拦下，已放行的流量由 nginx 以**固定的 `Host: 127.0.0.1:3080`** 转发上游，客户端伪造什么头都无意义。
>
> ⚠️ 生效前提：dsh 保持默认 `127.0.0.1:3080` 绑定，且防火墙/隧道**不得**把 3080 直接暴露出去——否则攻击者可绕过 nginx 直连上游。

### 五步配置 nginx 反代

前提：dsh 保持默认绑定（`127.0.0.1:3080`，别改 `0.0.0.0`）；有一个解析到这台机器的域名。

1. **选模板**：推荐 [`deploy/nginx/auth-request.conf`](deploy/nginx/auth-request.conf)（复用 WebGate 登录，无第二层弹窗）；想要一道独立的静态总闸就选 [`deploy/nginx/basic-auth.conf`](deploy/nginx/basic-auth.conf)。
2. **改三处**：把模板里的 `server_name`、`ssl_certificate`、`ssl_certificate_key` 换成你的域名和证书路径。没有证书先签一个：`sudo certbot --nginx -d dsh.example.com`（免费）。
3. **方案 A 专属**：生成口令文件 `sudo htpasswd -cB /etc/nginx/dsh.htpasswd alice`；方案 B 跳过这步。
4. **安装启用**：
   ```bash
   sudo cp auth-request.conf /etc/nginx/conf.d/dsh.conf
   sudo nginx -t && sudo systemctl reload nginx
   ```
5. **封后门**：防火墙/安全组只放行 80 和 443，**绝不放行 3080**；用 cloudflared 的话，把隧道 ingress 改指 `https://localhost:443`（配 `noTLSVerify: true`）。

验证是否生效：`curl -I https://你的域名/` —— 方案 A 应返回 `401`，方案 B 应返回 `302` 跳向 `/login`。之后浏览器打开就是正常的 WebGate 登录页。

## 开发与测试

```bash
npm test                 # 密码学自检 + 宿主逻辑检查（双形态）+ 浏览器沙箱冒烟
npm run build:dynamic    # 从 src/index.js 生成 dynamic/webgate.host.js
npm run verify:live      # 对运行中的 DSH (127.0.0.1:3080) 做端到端验证
```

无任何 npm 依赖，测试开箱即跑（需要 Node ≥ 22 与 PowerShell 7 仅用于 `verify:live`）。

源码结构：

```
src/index.js              # 唯一源码：ESM 插件模块（name/inject/apply）
dynamic/webgate.host.js   # 自动生成的动态插件形态（勿手改）
scripts/                  # 测试与构建脚本
cordis.patch.yml          # 组合插入行
```

## License

[MIT](LICENSE)
