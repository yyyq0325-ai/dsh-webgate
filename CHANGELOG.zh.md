# 更新日志

[English](CHANGELOG.en.md) | 中文

所有值得关注的新功能与修复都记录在本文件里，**新版本在最上面**。安装与使用说明见 [README](README.md)。

## 0.2.2 · 2026-08-24

服务端强制鉴权落地：反向代理配置模板 + 会话校验端点。

### 新增

- **`GET /auth/api/verify`**：读取登录时种下的 `webgate_token` Cookie 并校验会话——有效返回 `204`，缺失/无效/过期返回 `401`。恰好匹配 nginx `auth_request` 的判定语义，使「服务端强制鉴权」无需 Basic Auth 弹窗也能落地
- **`deploy/nginx/` 反代配置模板**：
  - 方案 A `basic-auth.conf` —— nginx Basic Auth 总闸 + 全站反代（WebSocket / SSE 参数已调好）
  - 方案 B `auth-request.conf` —— `auth_request` 对接 WebGate 会话，未登录访问直接 302 到 `/login?next=…`
- README「安全边界」补充两份模板的指引

### 说明

- WebGate 会话保存在 dsh 进程内存中，dsh 重启后所有会话失效，重新走一遍 `/login` 即可
- 配置模板不随 npm 包分发，请从 GitHub 仓库获取

## 0.2.1 · 2026-08-24

修复真实安装中「member 仍能看到全部工作区」的两个根因。

### 修复

- **URL 对象输入**：应用传输层以 `doFetch(new URL(path, base))` 调用守卫，而 `URL` 实例只有 `.href` 没有 `.url`，请求探针取到空串，`workspace.list` 过滤从未生效；现在同时兼容 `href` / `url` 并用纯字符串解析 pathname，不再依赖 URL 构造器
- **basename 授权**：授权常写成裸目录名（如 `park`），而 `WorkspaceView.path` 是绝对路径（`D:\code\park`），精确相等永远不命中；现在路径以 `<分隔符><matcher>` 结尾时同样命中（完整路径与标题相等仍然有效）
- browsersim J 套件同步真实传输形态（URL 对象输入 + basename 授权），锁定两个修复

## 0.2.0 · 2026-08-24（实验性）

账号角色与工作区授权。

### 新增

- **两级角色**：`admin` / `member`。初始 `admin` 账号即为管理员，拥有全部工作区与管理能力；新增用户默认为 `member`
- **成员工作区授权**：`/grant <用户名> <工作区路径|标题|*> <管理员密码>` 授予成员某个工作区的可见性（按完整路径或标题匹配、大小写不敏感），`*` 表示全部；`/revoke <用户名> <路径|标题|*|all> <管理员密码>` 撤销，`*` / `all` 清空全部授权
- **成员界面裁剪**：member 会话自动隐藏设置入口、工作区搜索按钮与列表头操作区（含添加工作区）；同时拒绝 `settings.*`、`workspace.create`、`session.search`、`host.createDirectory` 等 RPC（返回标准错误信封，界面优雅报错）
- **登录响应携带权限**：`/auth/api/login` 与 `/auth/api/session` 的响应附带 `perms`（角色 + 工作区匹配器），客户端据此渲染

### 变更（含破坏性变更 ⚠️）

- **「sudo 口令」模式**：`/useradd`、`/passwd`、`/userdel`、`/grant`、`/revoke` 全部要求在命令末尾附带**任意管理员账号的密码**，否则拒绝执行。此前写过脚本自动化这些命令的话需要相应调整
- `/userlist` 输出增加角色与工作区授权列
- 授权变更会立即撤销该成员的现有会话，重新登录后按新权限生效

### 升级说明

- 用户库记录自动迁移到 v2：旧记录首次读取时自动补全 `role` / `workspaces` 字段
- ⚠️ 迁移规则：初始 `admin` 账号保持 `admin` 角色，**其余既有用户一律变为无任何工作区授权的 `member`**——升级后请按需为他们重新 `/grant`
- 强度定位：工作区过滤运行在浏览器端（守卫脚本包装 fetch 实现），是"防误触"而非对抗有意绕过；服务端级强制仍需上游提供网关鉴权点（见 README 安全边界）

## 0.1.2 · 2026-08-24

### 修复

- 🔴 **插件加载即报四个"服务不可用"**：`inject` 此前只声明了 `timer`，cordis 会在其余服务激活前就执行 `apply`，导致路由全部注册失败。现声明全部依赖（`timer` / `webServer` / `credentials` / `commands` / `tools`），cordis 会挂起插件直至服务就绪。注意本版本 cordis 只支持扁平数组写法；不含 `webServer` 的 profile（headless/tui）中插件保持挂起属预期行为
- 动态插件产物（`dynamic/webgate.host.js`）此前硬编码旧的 inject 声明，现由构建脚本从源码自动提取，两种形态永不漂移

### 文档

- 「忘记密码」补充警告：删空 `records:` 段后必须连 `records:` 行一起删除（或写成 `records: {}`），否则凭据写入报 `Expected YAML collection at records`
- 新增「装卸插件后全站 400/404」排查指南（profile 内旧版 `@deepseek-ai/*` 影子包遮蔽 Harness 自带版本所致）

## 0.1.1 · 2026-08-24

### 变更

- 包名 scope 由不存在的 `@yyyq0325-ai` 改为 npm 账号对应的 **`@yyyq0325`**，卸载命令同步更正；npm 注册表上的裸名 `dsh-webgate` 是无关包，请勿使用
- 补齐 `publishConfig.access: public` 与 `prepublishOnly: npm test`，具备发布条件

## 0.1.0 · 2026-08-24

首个公开版本。

- 路由级登录门禁：向每个 `index.html` 注入同步守卫脚本，未认证跳转独立登录页 `/login`（另有 `/auth/page`）
- 12 小时会话令牌；前端 30 秒巡检 + 页面可见时服务端复核；登出/过期不影响后台任务
- 用户管理命令 `/useradd` `/passwd` `/userlist` `/userdel` 与 `webgate_user_*` 模型工具
- 用户库持久化于 `$DSH_HOME/.credentials.yaml` grant record；纯 JS PBKDF2-HMAC-SHA256（20000 迭代），零依赖
- 中英双语界面（默认中文，按 `Accept-Language` 协商 API 文案）
