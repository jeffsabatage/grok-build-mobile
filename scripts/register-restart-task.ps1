# One-time (UAC) setup so restart-gateway.ps1 can bounce the gateway without elevation.
#Requires -Version 5.1
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here
$id = [Security.Principal.WindowsIdentity]::GetCurrent()
$admin = (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) {
  Write-Host 'Requesting Administrator once to register GrokRemoteRestart…'
  $arg = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
  $p = Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $arg -Wait -PassThru
  if (-not $p -or $p.ExitCode -ne 0) { throw "Elevated register failed: $($p.ExitCode)" }
  exit 0
}

$restart = Join-Path $here 'install-service.ps1'
Unregister-ScheduledTask -TaskName 'GrokRemoteRestart' -Confirm:$false -ErrorAction SilentlyContinue
$arg = "-NoProfile -ExecutionPolicy Bypass -File `"$restart`" -Action Restart"
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arg -WorkingDirectory $root
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew
try { $settings.ExecutionTimeLimit = 'PT5M' } catch { }
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddYears(10)
Register-ScheduledTask -TaskName 'GrokRemoteRestart' `
  -Action $action `
  -Trigger $trigger `
  -Principal $principal `
  -Settings $settings `
  -Description 'On-demand restart of Grok Remote LAN Gateway. Run from restart-gateway.ps1; no extra UAC.' |
  Out-Null
Write-Host 'Scheduled task GrokRemoteRestart registered (Highest, current user).'
$taskFile = Join-Path $env:SystemRoot 'System32\Tasks\GrokRemoteRestart'
if (Test-Path -LiteralPath $taskFile) {
  icacls $taskFile /grant "$($env:USERNAME):(RX)" /grant "BUILTIN\Users:(RX)" | Out-Null
}
try {
  $svc = New-Object -ComObject 'Schedule.Service'
  $svc.Connect()
  $rt = $svc.GetFolder('\').GetTask('GrokRemoteRestart')
  $rt.SetSecurityDescriptor('D:(A;;GA;;;BA)(A;;GA;;;SY)(A;;GRGX;;;AU)(A;;GRGX;;;WD)', 0)
  Write-Host 'Task DACL allows Authenticated Users to run GrokRemoteRestart.'
} catch {
  Write-Host "Task DACL skip: $($_.Exception.Message)"
}

try {
  $sid = $id.User.Value
  $sddl = ((cmd /c "sc.exe sdshow GrokRemote") | Where-Object { $_ -match '\S' } | Select-Object -First 1)
  if ($sddl -and $sddl -notmatch [regex]::Escape($sid)) {
    $ace = "(A;;CCLCSWRPWPDTLOCRRC;;;$sid)"
    $new = if ($sddl -match 'S:') { $sddl -replace 'S:', ($ace + 'S:') } else { $sddl.Trim() + $ace }
    cmd /c "sc.exe sdset GrokRemote $new" | Out-Null
    Write-Host 'Granted current user start/stop on service GrokRemote.'
  }
} catch {
  Write-Host "Service ACL skip: $($_.Exception.Message)"
}

$logDir = Join-Path $root 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
'OK GrokRemoteRestart registered' | Set-Content -LiteralPath (Join-Path $logDir 'register-restart.log')
Write-Host 'OK'
exit 0
