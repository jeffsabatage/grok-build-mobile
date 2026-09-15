$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root
if (-not $env:GROK_BIN) {
  $env:GROK_BIN = Join-Path $env:USERPROFILE '.grok\bin\grok.exe'
}
Write-Host "Starting Grok Remote from $root"
node server.mjs
