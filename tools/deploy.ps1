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

# 版本戳：确认"线上是不是这次部署的新版本"时，只要抓一次 index.html 看一眼这行注释，
# 不用再整份拉上万字的 config.js（本会话为此浪费过两次全文抓取）。
# 为什么不用单独的 version.txt：几十字节的纯文本会被抓取工具判为"质量太低"直接拒掉，
# 而 index.html 本来就在抓取白名单里。
# 只记时间戳、不记 commit 短哈希：哈希要等提交后才知道，塞进去就得 --amend，
# 而 amend 又会改掉那个哈希，两者永远对不上（踩过这个坑）。
$stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText((Join-Path $root "version.txt"), "build $stamp`nmsg   $Message`n", $utf8NoBom)

$idx = Join-Path $root "index.html"
$html = [System.IO.File]::ReadAllText($idx, [System.Text.Encoding]::UTF8)
$html = [regex]::Replace($html, '<!-- build: .*? -->', ('<!-- build: ' + $stamp + ' -->'))
[System.IO.File]::WriteAllText($idx, $html, $utf8NoBom)

& git add -A
& git commit -m $Message
if ($LASTEXITCODE -ne 0) { Write-Host "没有改动需要提交。" -ForegroundColor Yellow; exit 0 }
& git push

Write-Host ""
Write-Host ("已推送。线上核对：抓 index.html 看 <!-- build: " + $stamp + " -->") -ForegroundColor Green
