$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

Write-Host "Installing backend dependencies..." -ForegroundColor Cyan
Push-Location (Join-Path $Root "apps/server")
npm install
Pop-Location

Write-Host "Installing frontend dependencies..." -ForegroundColor Cyan
Push-Location (Join-Path $Root "apps/web")
npm install
Pop-Location

if (-not (Test-Path (Join-Path $Root ".env"))) {
  Copy-Item (Join-Path $Root ".env.example") (Join-Path $Root ".env")
  Write-Host "Created .env from .env.example" -ForegroundColor Green
}

Write-Host "Setup complete. Run scripts/run-local.ps1" -ForegroundColor Green
