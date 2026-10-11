# 一条命令把改动推上去（GitHub Pages 会自动重新发布，约 40 秒生效）
#
#   pwsh -File tools/deploy.ps1 "加了铁盾兵的破盾特效"
#
# 不带说明的话用时间戳当提交信息。
#
# NOTE (keep this block in ASCII, do not translate or delete):
# 本文件必须保留 UTF-8 BOM —— PowerShell 5.1 读没有 BOM 的 UTF-8 会按 ANSI 解码，
# 中文注释被打乱后会报 Missing closing '}' in statement block or type definition.
# 用 edit/write 工具改过本文件后，一定要用 Node 补回 BOM：
#   fs.writeFileSync(p, Buffer.concat([Buffer.from([0xEF,0xBB,0xBF]), fs.readFileSync(p)]))
param([string]$Message = "")

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

# 本机的沙箱里 MSYS 的 sh.exe 起不来，得让 git 改用 Windows 原生 ssh。
# 这个包装脚本只在这台机器上存在；换到别的机器会自动跳过，用默认 ssh。
$wrapper = Join-Path (Split-Path -Parent $root) ".secrets\git-ssh-hbt.cmd"
if (Test-Path $wrapper) { $env:GIT_SSH = $wrapper; $env:GIT_SSH_VARIANT = "ssh" }

if (-not $Message) { $Message = "更新 " + (Get-Date -Format "yyyy-MM-dd HH:mm") }

# 版本戳 + 版本号：
#  - 版本号（主界面右下角那个 vX.Y.Z，用户 m02534 要的"能区分更新"）每次部署自动 +1。
#    它是唯一真相，写在 index.html 的 <div class="build" id="buildLabel">vX.Y.Z</div> 里；
#    想手动跳个大版本（比如做完第三关发 v1.1.0），直接改 index.html 里那个数字即可，
#    脚本永远从那里读当前值再 +0.0.1。
#  - 同一份 build 时间戳另外写进 index.html 的 <!-- build: ... --> 注释。
#  - sw.js 的缓存名也跟着版本号走，省得每次部署都忘了升 CACHE 导致手机上还跑旧代码。
# 为什么不用单独的 version.txt 当唯一真相：几十字节的纯文本会被抓取工具判为"质量太低"
# 直接拒掉，而 index.html 本来就在抓取白名单里。version.txt 仍然照写一份，方便本地看。
# 只记时间戳、不记 commit 短哈希：哈希要等提交后才知道，塞进去就得 --amend，
# 而 amend 又会改掉那个哈希，两者永远对不上（踩过这个坑）。
$stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

$idx = Join-Path $root "index.html"
$html = [System.IO.File]::ReadAllText($idx, [System.Text.Encoding]::UTF8)

$m = [regex]::Match($html, 'id="buildLabel">v(\d+)\.(\d+)\.(\d+)<')
if (-not $m.Success) { throw "index.html 里找不到 <div class=`"build`" id=`"buildLabel`">vX.Y.Z</div>，无法自动升版本号" }
$major = [int]$m.Groups[1].Value
$minor = [int]$m.Groups[2].Value
$patch = [int]$m.Groups[3].Value + 1
$version = "$major.$minor.$patch"
Write-Host ("版本号：v" + $version) -ForegroundColor Cyan

$html = [regex]::Replace($html, 'id="buildLabel">v\d+\.\d+\.\d+<', ('id="buildLabel">v' + $version + '<'))
$html = [regex]::Replace($html, '<!-- build: .*? -->', ('<!-- build: ' + $stamp + ' -->'))
[System.IO.File]::WriteAllText($idx, $html, $utf8NoBom)

$sw = Join-Path $root "sw.js"
$swText = [System.IO.File]::ReadAllText($sw, [System.Text.Encoding]::UTF8)
$swText = [regex]::Replace($swText, "const CACHE = 'hold-the-bridge-v[^']*';", ("const CACHE = 'hold-the-bridge-v" + $version + "';"))
[System.IO.File]::WriteAllText($sw, $swText, $utf8NoBom)

[System.IO.File]::WriteAllText(
  (Join-Path $root "version.txt"),
  ("version v$version`nbuild   $stamp`nmsg     $Message`n"),
  $utf8NoBom
)

& git add -A
& git commit -m $Message
if ($LASTEXITCODE -ne 0) { Write-Host "没有改动需要提交。" -ForegroundColor Yellow; exit 0 }
& git push

Write-Host ""
Write-Host ("已推送 v" + $version + "。线上核对：抓 index.html 看 <!-- build: " + $stamp + " --> 或右下角的 v" + $version) -ForegroundColor Green
