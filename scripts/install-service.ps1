#Requires -Version 5.1
<#
.SYNOPSIS
  Keep the Grok Remote LAN gateway running outside Grok Build.

.DESCRIPTION
  Installs a Windows Scheduled Task (runs as you, at logon, restarts on crash).
  That is required so grok agent --leader stdio can attach to your live TUI.

  Optional -AsNssm installs an NSSM Windows Service as well (needs Administrator).
  Prefer the scheduled task for live session attach.

.PARAMETER Action
  Install | Uninstall | Start | Stop | Restart | Status
#>
param(
  [ValidateSet('Install', 'Uninstall', 'Start', 'Stop', 'Restart', 'Status')]
  [string]$Action = 'Install',
  [switch]$AsNssm
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$taskName = 'GrokRemote'
$svcName = 'GrokRemote'
$nssmCandidates = @(
  (Join-Path $root 'tools\nssm\nssm.exe')
)
$pwsh = Join-Path $root 'scripts\run-gateway.ps1'
function Get-Node {
  $c = Get-Command node -ErrorAction SilentlyContinue
  if ($c -and $c.Source) { return $c.Source }
  foreach ($p in @(
    (Join-Path $env:LOCALAPPDATA 'hermes\node\node.exe'),
    (Join-Path ${env:ProgramFiles} 'nodejs\node.exe')
  )) {
    if ($p -and (Test-Path -LiteralPath $p)) { return $p }
  }
  throw 'node.exe not found on PATH'
}

function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $p = New-Object Security.Principal.WindowsPrincipal($id)
  return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Stop-PortListeners {
  param([int]$Port = 2420)
  Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique |
    ForEach-Object {
      if ($_ -and $_ -gt 4) {
        Write-Host "Stopping PID $_ on port $Port"
        Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue
      }
    }
  Start-Sleep -Seconds 1
}

function Get-Nssm {
  foreach ($p in $nssmCandidates) {
    if (Test-Path -LiteralPath $p) { return $p }
  }
  return $null
}

function Install-Task {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  $arg = "-NoProfile -ExecutionPolicy Bypass -File `"$pwsh`""
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arg -WorkingDirectory $root
  $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -DontStopOnIdleEnd `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew
  try { $settings.ExecutionTimeLimit = 'PT0S' } catch { }
  $triggers = @(
    (New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME)
  )
  Register-ScheduledTask -TaskName $taskName `
    -Action $action `
    -Trigger $triggers `
    -Principal $principal `
    -Settings $settings `
    -Description 'Grok Remote LAN gateway (:2420). Independent of Grok Build.' |
    Out-Null
  Write-Host "Scheduled task '$taskName' installed (at logon, restart on crash)."
}

function Start-TaskNow {
  Start-ScheduledTask -TaskName $taskName
  Write-Host "Started task '$taskName'."
}

function Wait-Health {
  Write-Host "Waiting for http://127.0.0.1:2420/api/health ..."
  for ($i = 0; $i -lt 25; $i++) {
    Start-Sleep -Milliseconds 400
    try {
      $h = Invoke-WebRequest -Uri 'http://127.0.0.1:2420/api/health' -UseBasicParsing -TimeoutSec 2
      Write-Host $h.Content
      return
    } catch { }
  }
  throw 'Gateway did not become healthy on :2420'
}

function Install-NssmService {
  if (-not (Test-Admin)) { throw 'NSSM service install requires Administrator PowerShell.' }
  $nssm = Get-Nssm
  if (-not $nssm) { throw 'nssm.exe not found under grok-remote\tools\nssm\nssm.exe' }
  New-Item -ItemType Directory -Force -Path (Join-Path $root 'logs') | Out-Null
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  Stop-PortListeners -Port 2420
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  & $nssm stop $svcName 2>$null | Out-Null
  & $nssm remove $svcName confirm 2>$null | Out-Null
  $ErrorActionPreference = $prev
  $nodeExe = Get-Node
  $app = Join-Path $root 'server.mjs'
  Write-Host "node=$nodeExe"
  & $nssm install $svcName $nodeExe $app | Out-Null
  & $nssm set $svcName AppDirectory $root | Out-Null
  & $nssm set $svcName AppParameters $app | Out-Null
  & $nssm set $svcName DisplayName 'Grok Remote LAN Gateway' | Out-Null
  & $nssm set $svcName Description 'LAN gateway for the Grok Remote Android app (HTTP :2420, ACP). Shown in services.msc. Automatic start.' | Out-Null
  & $nssm set $svcName Start SERVICE_AUTO_START | Out-Null
  & $nssm set $svcName AppStdout (Join-Path $root 'logs\gateway.out.log') | Out-Null
  & $nssm set $svcName AppStderr (Join-Path $root 'logs\gateway.err.log') | Out-Null
  & $nssm set $svcName AppRotateFiles 1 | Out-Null
  & $nssm set $svcName AppRotateBytes 2000000 | Out-Null
  & $nssm set $svcName AppRestartDelay 3000 | Out-Null
  & $nssm set $svcName AppExit Default Restart | Out-Null
  & $nssm set $svcName AppNoConsole 1 | Out-Null
  $userHome = $env:USERPROFILE
  $grokHome = Join-Path $userHome '.grok'
  $grokBin = Join-Path $grokHome 'bin\grok.exe'
  $homeDrive = $env:HOMEDRIVE
  $homePath = $env:HOMEPATH
  & $nssm set $svcName AppEnvironmentExtra `
    "GROK_BIN=$grokBin" `
    "GROK_HOME=$grokHome" `
    "USERPROFILE=$userHome" `
    "HOMEDRIVE=$homeDrive" `
    "HOMEPATH=$homePath" `
    "HOME=$userHome" | Out-Null
  Write-Host "NSSM service '$svcName' installed (Automatic, LocalSystem, USERPROFILE from installing account)."
  & $nssm start $svcName
  $st = Get-Service -Name $svcName -ErrorAction Stop
  Write-Host "Service status: $($st.Status)  start=$($st.StartType)"
}

if ($AsNssm -and $Action -eq 'Install' -and -not (Test-Admin)) {
  Write-Host "Requesting Administrator (UAC) to install services.msc entry 'GrokRemote'..."
  Write-Host "Approve the Windows prompt if it appears."
  $log = Join-Path $root 'logs\service-install.log'
  New-Item -ItemType Directory -Force -Path (Split-Path $log) | Out-Null
  $arg = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Action Install -AsNssm"
  $p = Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $arg -Wait -PassThru
  if (Test-Path $log) { Write-Host '--- elevated log ---'; Get-Content $log }
  if (-not $p -or $p.ExitCode -ne 0) {
    throw "Elevated install exited $($p.ExitCode). Approve UAC (Yes) if it was shown. Log: $log"
  }
  Get-Service -Name $svcName -ErrorAction SilentlyContinue | Format-List Name, Status, StartType, DisplayName
  try { (Invoke-WebRequest -Uri 'http://127.0.0.1:2420/api/health' -UseBasicParsing -TimeoutSec 4).Content } catch { "health: $($_.Exception.Message)" }
  exit 0
}

switch ($Action) {
  'Install' {
    New-Item -ItemType Directory -Force -Path (Join-Path $root 'logs') | Out-Null
    if ($AsNssm) {
      $log = Join-Path $root 'logs\service-install.log'
      try {
        Install-NssmService
        Wait-Health
        'OK' | Set-Content $log
        Write-Host "Grok Remote is in services.msc as 'Grok Remote LAN Gateway' (GrokRemote)."
      } catch {
        $_ | Out-File $log
        throw
      }
    } else {
      Stop-PortListeners -Port 2420
      Install-Task
      Start-TaskNow
      Wait-Health
      Write-Host "Grok Remote is running as logon task '$taskName' (not services.msc). Use -AsNssm for a real service."
    }
  }
  'Uninstall' {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    $nssm = Get-Nssm
    if ($nssm) {
      & $nssm stop $svcName 2>$null | Out-Null
      & $nssm remove $svcName confirm 2>$null | Out-Null
    }
    Stop-PortListeners -Port 2420
    Write-Host 'Removed Grok Remote task/service.'
  }
  'Start' {
    $svc = Get-Service -Name $svcName -ErrorAction SilentlyContinue
    if ($svc) { Start-Service $svcName }
    else { Start-TaskNow }
  }
  'Stop' {
    $svc = Get-Service -Name $svcName -ErrorAction SilentlyContinue
    if ($svc) { Stop-Service $svcName -Force -ErrorAction SilentlyContinue }
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Stop-PortListeners -Port 2420
  }
  'Restart' {
    $svc = Get-Service -Name $svcName -ErrorAction SilentlyContinue
    if ($svc) {
      Restart-Service $svcName -Force
    } else {
      Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
      Stop-PortListeners -Port 2420
      Start-Sleep -Seconds 1
      Start-TaskNow
    }
  }
  'Status' {
    Get-Service -Name $svcName -ErrorAction SilentlyContinue | Format-List Name, DisplayName, Status, StartType
    Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue | Format-List TaskName, State
    try { (Invoke-WebRequest -Uri 'http://127.0.0.1:2420/api/health' -UseBasicParsing -TimeoutSec 3).Content } catch { "health: $($_.Exception.Message)" }
  }
}
