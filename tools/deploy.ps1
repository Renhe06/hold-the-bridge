# 一条命令把改动推上去（GitHub Pages 会自动重新发布，约 40 秒生效）
#
#   pwsh -File tools/deploy.ps1 "加了铁盾兵的破盾特效"
#
# 不带说明的话用时间戳当提交信息。
param([string]$Message = "")

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

# 本机的沙箱里 MSYS 的 sh.exe 起不来，得让 git 改用 Windows 原生 ssh。
# 这个包装脚本只在这台机器上存在；换到别的机器会自动跳过，用默认 ssh。
$wrapper = Join-Path (Split-Path -Parent $root) ".secrets\git-ssh-hbt.cmd"
if (Test-Path $wrapper) { $env:GIT_SSH = $wrapper; $env:GIT_SSH_VARIANT = "ssh" }

if (-not $Message) { $Message = "更新 " + (Get-Date -Format "yyyy-MM-dd HH:mm") }

# 写一个版本戳（纯文本，几十字节）。以前每次确认"线上是不是新版本"都要整份拉
# config.js（上万字），现在只要看一眼 version.txt 就够。
$stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
$versionPath = Join-Path $root "version.txt"
"build pending`nbuilt $stamp`nmsg   $Message`n" | Set-Content -Path $versionPath -Encoding UTF8

& git add -A
& git commit -m $Message
if ($LASTEXITCODE -ne 0) { Write-Host "没有改动需要提交。" -ForegroundColor Yellow; exit 0 }

# 提交完才知道短哈希，补进 version.txt 再修正这次提交（--amend 不改说明）
$hash = (& git rev-parse --short HEAD).Trim()
"build $hash`nbuilt $stamp`nmsg   $Message`n" | Set-Content -Path $versionPath -Encoding UTF8
& git add version.txt
& git commit --amend --no-edit | Out-Null
& git push

Write-Host ""
Write-Host "已推送。发布进度看仓库的 Actions 页签；地址是 GitHub Pages 那个域名。" -ForegroundColor Green
