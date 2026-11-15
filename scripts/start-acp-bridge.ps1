# Start (or keep) the user-session ACP bridge on 127.0.0.1:2421 and inject :2422.
$ErrorActionPreference = 'SilentlyContinue'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
function Test-BridgeHealth {
  try {
    $r = Invoke-WebRequest -Uri 'http://127.0.0.1:2422/health' -UseBasicParsing -TimeoutSec 1
    return $r.StatusCode -eq 200
  } catch {
    return $false
  }
}
function Test-UsageImplemented {
  try {
    $r = Invoke-WebRequest -Uri 'http://127.0.0.1:2422/usage' -UseBasicParsing -TimeoutSec 2
    return $true
  } catch {
    $code = 0
    try { $code = [int]$_.Exception.Response.StatusCode } catch { }
    if ($code -eq 404) { return $false }
    return $true
  }
}
function Test-Port([int]$Port) {
  try {
    $c = New-Object System.Net.Sockets.TcpClient
    $iar = $c.BeginConnect('127.0.0.1', $Port, $null, $null)
    $ok = $iar.AsyncWaitHandle.WaitOne(400, $false)
    if ($ok -and $c.Connected) { $c.Close(); return $true }
    $c.Close()
  } catch { }
  return $false
}
if (Test-BridgeHealth) {
  if (Test-UsageImplemented) { Write-Host 'acp-bridge already up'; exit 0 }
  Write-Host 'acp-bridge missing /usage — recycling'
} elseif (Test-Port 2421 -or Test-Port 2422) {
  # /health missed its 1s budget, but the process is still listening. Do not kill it.
  Write-Host 'acp-bridge busy — leaving it up'
  exit 0
}
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'acp-bridge' } | ForEach-Object {
  Stop-Process -Id $_.ProcessId -Force
}
Start-Sleep -Milliseconds 300
$node = (Get-Command node).Source
Start-Process -FilePath $node -WindowStyle Hidden -WorkingDirectory $root -ArgumentList @(
  (Join-Path $root 'lib\acp-bridge.mjs')
) | Out-Null
Start-Sleep -Milliseconds 900
if (Test-BridgeHealth) { Write-Host 'acp-bridge started'; exit 0 }
Write-Host 'acp-bridge failed to listen'
exit 1
