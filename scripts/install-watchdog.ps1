#Requires -Version 5.1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$watch = Join-Path $root 'scripts\watch-gateway.ps1'
Unregister-ScheduledTask -TaskName 'GrokRemoteWatch' -Confirm:$false -ErrorAction SilentlyContinue
$vbs = Join-Path $root 'scripts\run-hidden-ps.vbs'
$arg = "//B //Nologo `"$vbs`" `"$watch`""
$action = New-ScheduledTaskAction -Execute 'C:\Windows\System32\wscript.exe' -Argument $arg -WorkingDirectory $root
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew
try { $settings.ExecutionTimeLimit = 'PT2M' } catch { }
$once = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(1))
try {
  $once.Repetition.Interval = 'PT1M'
  $once.Repetition.Duration = 'P9999D'
} catch { }
$logon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
Register-ScheduledTask -TaskName 'GrokRemoteWatch' `
  -Action $action `
  -Trigger @($logon, $once) `
  -Principal $principal `
  -Settings $settings `
  -Description 'If Grok Remote :2420 is down, start the service or logon task.' |
  Out-Null
Write-Host "Watchdog task GrokRemoteWatch installed."
Get-ScheduledTask -TaskName 'GrokRemoteWatch' | Select-Object TaskName, State
