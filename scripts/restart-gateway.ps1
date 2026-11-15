# Restart the LAN gateway without a UAC prompt.
# Prefers POST /api/admin/restart (NSSM/node loop brings it back).
# Falls back to the on-demand GrokRemoteRestart scheduled task.
#Requires -Version 5.1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$secretFile = Join-Path $root '.secret'
$taskName = 'GrokRemoteRestart'

function Get-Health {
  try {
    return Invoke-RestMethod -Uri 'http://127.0.0.1:2420/api/health' -TimeoutSec 3
  } catch {
    return $null
  }
}

function Wait-Health {
  param([int]$PrevPid = 0, [int]$Seconds = 25)
  $sawDown = $false
  for ($i = 0; $i -lt ($Seconds * 2); $i++) {
    Start-Sleep -Milliseconds 500
    $h = Get-Health
    if (-not $h -or -not $h.ok) {
      $sawDown = $true
      continue
    }
    $newPid = 0
    if ($h.pid) { $newPid = [int]$h.pid }
    if ($PrevPid -and $newPid -and $newPid -eq $PrevPid) { continue }
    if ($PrevPid -and -not $newPid -and -not $sawDown) { continue }
    if ($sawDown -or ($newPid -and $newPid -ne $PrevPid) -or (-not $PrevPid -and $sawDown)) { return $h }
  }
  return $null
}

$prev = Get-Health
$prevPid = 0
if ($prev -and $prev.pid) { $prevPid = [int]$prev.pid }

if ($prev -and (Test-Path -LiteralPath $secretFile)) {
  $secret = (Get-Content -LiteralPath $secretFile -Raw).Trim()
  try {
    $r = Invoke-RestMethod -Method POST -Uri 'http://127.0.0.1:2420/api/admin/restart' `
      -Headers @{ 'X-Grok-Remote-Secret' = $secret } `
      -TimeoutSec 8
    if (-not $r.restarting) { throw 'restart endpoint missing' }
    $h = Wait-Health -PrevPid $prevPid
    if ($h) {
      Write-Host ("RESTARTED http pid={0} version={1}" -f $h.pid, $h.version)
      exit 0
    }
  } catch {
    Write-Host "HTTP restart not available yet: $($_.Exception.Message)"
  }
}

cmd /c "schtasks /Run /TN $taskName" | Out-Null
if ($LASTEXITCODE -eq 0) {
  $h = Wait-Health -PrevPid $prevPid -Seconds 30
  if ($h) {
    Write-Host ("RESTARTED task pid={0} version={1}" -f $h.pid, $h.version)
    exit 0
  }
  Write-Host 'Task ran but health did not return a new process.'
} else {
  Write-Host "schtasks /Run failed with $LASTEXITCODE"
}

Write-Host 'NEED_SETUP: run scripts\register-restart-task.ps1 once (UAC) so future restarts do not need elevation.'
exit 2
