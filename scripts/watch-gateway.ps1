# Health watchdog: if :2420 is down, start the Windows service or the logon task.
$ErrorActionPreference = 'SilentlyContinue'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$logDir = Join-Path $root 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir 'watchdog.log'

function Write-Watch([string]$msg) {
  $line = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ' + $msg
  Add-Content -LiteralPath $log -Value $line -ErrorAction SilentlyContinue
}

function Test-Health {
  try {
    $r = Invoke-WebRequest -Uri 'http://127.0.0.1:2420/api/health' -UseBasicParsing -TimeoutSec 3
    return $r.StatusCode -eq 200
  } catch {
    return $false
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

function Ensure-AcpBridge {
  $starter = Join-Path $root 'scripts\start-acp-bridge.ps1'
  if (Test-Path -LiteralPath $starter) {
    & $starter | Out-Null
  }
}

Ensure-AcpBridge
if (Test-Health) { exit 0 }

Write-Watch 'health miss — restarting gateway'

$svc = Get-Service -Name 'GrokRemote' -ErrorAction SilentlyContinue
if ($svc) {
  if ($svc.Status -ne 'Running') { Start-Service -Name 'GrokRemote' -ErrorAction SilentlyContinue }
  else { Restart-Service -Name 'GrokRemote' -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 3
  if (Test-Health) { Write-Watch 'service recovered'; exit 0 }
}

Start-ScheduledTask -TaskName 'GrokRemote' -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3
if (Test-Health) { Write-Watch 'task recovered'; exit 0 }

$run = Join-Path $root 'scripts\run-gateway.ps1'
if (Test-Path -LiteralPath $run) {
  $vbs = Join-Path $root 'scripts\run-hidden-ps.vbs'
  Start-Process -FilePath 'wscript.exe' -WindowStyle Hidden -ArgumentList @(
    '//B', '//Nologo', $vbs, $run
  ) | Out-Null
  Start-Sleep -Seconds 4
  if (Test-Health) { Write-Watch 'spawned run-gateway'; exit 0 }
}

Write-Watch 'still down'
exit 1
