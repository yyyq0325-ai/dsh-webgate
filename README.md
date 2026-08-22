# WebGate — DeepSeek Harness Web 登录门禁

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 Web GUI 加一道账号密码门：每次打开 DSH Web 都必须先登录；登录令牌有效期 **12 小时**；令牌过期被登出时，**后台正在运行的任务完全不受影响**，重新登录后一切还在。

![login](docs/login-preview.png)

## 特性

- 🔐 **全页登录门禁** — 通过 `webserver/index-inject` 向每个 `index.html` 注入同步门禁脚本，未认证时全屏遮罩，应用内容零闪现
- ⏱ **12 小时会话令牌** — 绝对有效期；前端 30 秒巡检 + 页面重新可见时向服务端复核；过期自动回到登录页
- 🚀 **后台任务零打扰** — 门禁只作用于浏览器视图层，Host 端的会话、后台任务、子代理照常运行
- 🎨 **DeepSeek 官网风格登录页** — 深蓝紫渐变 + 毛玻璃卡片 + 品牌蓝渐变按钮 + 鲸鱼徽标 SVG，另有独立登录页 `/auth/page`
- 🛠 **用户管理命令** — `/useradd` `/passwd` `/userlist` `/userdel`（密码不写入会话日志），另有 `webgate_user_*` 模型工具可让 Agent 代管
- 💾 **持久化** — 用户库存放在 `$DSH_HOME/.credentials.yaml` 的 grant record 中，随 Harness 自身凭据文件一起管理，插件重启自动恢复
- 🧩 **零依赖** — 纯 JavaScript 单文件实现；动态沙箱里没有 node:crypto，密码哈希使用内置 PBKDF2-HMAC-SHA256（20000 次迭代，已通过标准测试向量验证）

## 安装

### 方式 A：官方 CLI（推荐）

```bash
dsh plugin --profile web add dsh-webgate
```

安装命令会依据 `package.json` 的 `dsh.bundle.patch` 声明自动挂载本插件，重启 dsh 后生效。

### 方式 B：手动挂载

把 [`cordis.patch.yml`](cordis.patch.yml) 中的 insert 行复制进 profile 的补丁文件 `~/.dsh/profiles/web/cordis.patch.yml`：

```yaml
- insert:
    - id: webgate
      name: dsh-webgate
```

并确保本包已安装到 profile 可解析的位置（如 profile 目录下 `npm i <本包路径>`）。

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

添加更多用户 / 管理：

| 命令 | 说明 |
|---|---|
| `/useradd <用户名> <密码>` | 添加用户（用户名 2-32 位字母数字点下划线短横线；密码 6-128 位） |
| `/passwd <用户名> <新密码>` | 修改密码，该用户现有会话立即全部失效 |
| `/userlist` | 列出用户、创建时间与活跃会话数 |
| `/userdel <用户名>` | 删除用户（至少保留一个） |

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
dsh plugin --profile web remove dsh-webgate
```

### 手动 patch 行的停用与卸载

编辑 `~/.dsh/profiles/web/cordis.patch.yml`，将插件行加上 `disabled: true`（保留配置停用）或整行删除（彻底卸载），重启 dsh 生效：

```yaml
- insert:
    - id: webgate
      name: dsh-webgate
      disabled: true   # 停用；或删除整个条目卸载
```

### 忘记密码怎么办

1. 打开 `$DSH_HOME/.credentials.yaml`（默认 `~/.dsh/.credentials.yaml`）；
2. 删除 `records:` 段下 `webgate/users:` 的整段记录（**其他内容一律不动**）；
3. 重启 dsh —— 插件启动时发现没有用户，会重新引导初始账号 `admin / admin1234`。

> 该文件里同时保存着 API Key 等其他凭据，只删 `webgate/users` 那一段即可，其余行请保持原样。

### 兜底原则

本插件只注册自己的路由/监听/命令，除上述一条凭据记录外不修改任何 Harness 数据。无论出现何种异常，按上面任一方式停用插件并重启 dsh，即可完全恢复到安装前状态。

## 工作原理

```
浏览器 ── GET / ──▶ webServer(fallback=静态 dist)
                     │ renderIndex()
                     │ ├─ 结构化注入表（webserver/index-inject 事件）
                     │ │   └─ WebGate：<script>门禁脚本</script>
                     ▼
        未认证 → 全屏登录遮罩 ── POST /auth/api/login ──▶ 校验 PBKDF2 哈希
                     │                                      │ 签发 12h 令牌
                     ◀── localStorage 保存 token/exp ───────┘
        已认证 → 放行应用（30s 巡检 + visibilitychange 服务端复核）
```

- **密码存储**：`PBKDF2-HMAC-SHA256(20000 iter, 16B random salt)`，常数时间比较；命令参数带密码时不写入会话日志（`recordInput: false`）
- **用户库**：一条 credentials grant record（key `webgate/users`），payload 为 JSON 字符串——字符串是原始值，可安全跨越动态插件沙箱与宿主之间的 realm 边界
- **生命周期**：所有路由、监听、命令、工具注册均挂在插件 Fiber 上，停止/更新插件自动清理

## 安全边界（请务必阅读）

这是一个面向**本地个人工具**的入口门禁，不是企业级安全方案：

1. 门禁覆盖 **Web 页面入口**（index.html 注入）。DSH 的 webServer 没有通用 HTTP 中间件层，因此本机进程绕过页面直接调用 API 不经过此认证。
2. 默认只监听 `127.0.0.1`；若改为 `0.0.0.0` 暴露到局域网，请自行评估风险并配合反代加认证。
3. 初始管理员密码是公开的默认值，部署后第一件事就是改密码。
4. 登录令牌保存在浏览器 localStorage，且为内存态（Host 重启后需重新登录）。

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
