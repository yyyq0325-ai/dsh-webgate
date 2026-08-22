$ErrorActionPreference = 'Continue'
$base = 'http://127.0.0.1:3080'

# 1) index 注入门禁脚本
$idx = curl.exe --noproxy '*' -s "$base/"
"1) index 含门禁脚本: $($null -ne $idx -and $idx.Contains('dshWebgate') -and $idx.Contains('wg-gate')) | 长度=$($idx.Length)"

# 2) 错误密码（含 900ms 防爆破延迟）
$b1 = (curl.exe --noproxy '*' -s -X POST "$base/auth/api/login" -H 'Content-Type: application/json' --data-raw '{"username":"admin","password":"wrong-pass"}') | ConvertFrom-Json
"2) 错误密码: ok=$($b1.ok) msg=$($b1.message)"

# 3) 正确密码登录
$l = (curl.exe --noproxy '*' -s -X POST "$base/auth/api/login" -H 'Content-Type: application/json' --data-raw '{"username":"admin","password":"admin1234"}') | ConvertFrom-Json
$hours = [math]::Round(($l.expiresAt - [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()) / 3600000, 1)
"3) 正确登录: ok=$($l.ok) user=$($l.username) tokenLen=$($l.token.Length) 有效期=$hours小时"

# 4) 会话校验
$tokJson = '{"token":"' + $l.token + '"}'
$s1 = (curl.exe --noproxy '*' -s -X POST "$base/auth/api/session" -H 'Content-Type: application/json' --data-raw $tokJson) | ConvertFrom-Json
"4) 令牌会话: valid=$($s1.valid) user=$($s1.username)"

# 5) 登出后失效
curl.exe --noproxy '*' -s -X POST "$base/auth/api/logout" -H 'Content-Type: application/json' --data-raw $tokJson | Out-Null
$s2 = (curl.exe --noproxy '*' -s -X POST "$base/auth/api/session" -H 'Content-Type: application/json' --data-raw $tokJson) | ConvertFrom-Json
"5) 登出后 valid=$($s2.valid)（应为 False）"

# 6) 独立登录页
$code = curl.exe --noproxy '*' -s -o NUL -w '%{http_code}' "$base/auth/page"
$page = curl.exe --noproxy '*' -s "$base/auth/page"
"6) /auth/page: HTTP $code, 含Harness=$($page.Contains('Harness')), 含登录卡片=$($page.Contains('wg-card'))"

# 7) credentials 持久化检查
$credPath = Join-Path $env:USERPROFILE '.dsh\.credentials.yaml'
$cred = Get-Content $credPath -Raw -ErrorAction SilentlyContinue
"7) $credPath 含 webgate/users 记录: $($null -ne $cred -and $cred.Contains('webgate/users'))"
