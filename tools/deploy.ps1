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

& git add -A
& git commit -m $Message
if ($LASTEXITCODE -ne 0) { Write-Host "没有改动需要提交。" -ForegroundColor Yellow; exit 0 }
& git push

Write-Host ""
Write-Host "已推送。发布进度看仓库的 Actions 页签；地址是 GitHub Pages 那个域名。" -ForegroundColor Green
