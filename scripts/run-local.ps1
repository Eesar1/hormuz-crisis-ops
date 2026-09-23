$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Server = Join-Path $Root "apps/server"
$Web = Join-Path $Root "apps/web"

Start-Process powershell -ArgumentList "-NoExit", "-Command", "Set-Location '$Server'; npm run dev"
Start-Sleep -Seconds 1
Start-Process powershell -ArgumentList "-NoExit", "-Command", "Set-Location '$Web'; npm run dev"
Start-Sleep -Seconds 3
Start-Process "http://localhost:3000/command"
