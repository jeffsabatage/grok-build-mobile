#Requires -Version 5.1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$run = Join-Path $root 'scripts\run-inject-job.ps1'
Unregister-ScheduledTask -TaskName 'GrokRemoteInject' -Confirm:$false -ErrorAction SilentlyContinue
$vbs = Join-Path $root 'scripts\run-hidden-ps.vbs'
$arg = "//B //Nologo `"$vbs`" `"$run`""
$action = New-ScheduledTaskAction -Execute 'C:\Windows\System32\wscript.exe' -Argument $arg -WorkingDirectory $root
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
try { $settings.ExecutionTimeLimit = 'PT1M' } catch { }
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddYears(10)
Register-ScheduledTask -TaskName 'GrokRemoteInject' `
  -Action $action `
  -Trigger $trigger `
  -Principal $principal `
  -Settings $settings `
  -Description 'Type a phone prompt into the live Grok TUI window.' |
  Out-Null
Write-Host 'GrokRemoteInject registered'
