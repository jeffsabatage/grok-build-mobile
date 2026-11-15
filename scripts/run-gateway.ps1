# Launcher for the Grok Remote LAN gateway. Restarts node if it exits.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root
if (-not $env:GROK_HOME) {
  $env:GROK_HOME = Join-Path $env:USERPROFILE '.grok'
}
if (-not $env:GROK_BIN) {
  $env:GROK_BIN = Join-Path $env:GROK_HOME 'bin\grok.exe'
}
$logDir = Join-Path $root 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$node = (Get-Command node -ErrorAction Stop).Source
$app = Join-Path $root 'server.mjs'
$delay = 2
while ($true) {
  try {
    & $node $app
  } catch {
    $null = $_
  }
  $code = $LASTEXITCODE
  $stamp = Get-Date -Format 'HH:mm:ss'
  Add-Content -LiteralPath (Join-Path $logDir 'watchdog.log') -Value "$stamp node exited $code; restart in ${delay}s"
  Start-Sleep -Seconds $delay
  $delay = [Math]::Min(30, $delay * 2)
}
