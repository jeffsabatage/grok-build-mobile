# Launcher for the Grok Remote LAN gateway (used by the Windows task/service).
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root
if (-not $env:GROK_BIN) {
  $env:GROK_BIN = Join-Path $env:USERPROFILE '.grok\bin\grok.exe'
}
$logDir = Join-Path $root 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$node = (Get-Command node -ErrorAction Stop).Source
& $node (Join-Path $root 'server.mjs')
