#Requires -Version 5.1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$run = Join-Path $root 'scripts\start-acp-bridge.ps1'
Unregister-ScheduledTask -TaskName 'GrokRemoteAcpBridge' -Confirm:$false -ErrorAction SilentlyContinue
$vbs = Join-Path $root 'scripts\run-hidden-ps.vbs'
$arg = "//B //Nologo `"$vbs`" `"$run`""
$action = New-ScheduledTaskAction -Execute 'C:\Windows\System32\wscript.exe' -Argument $arg -WorkingDirectory $root
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew
$logon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$once = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddSeconds(15))
try {
  $once.Repetition.Interval = 'PT1M'
  $once.Repetition.Duration = 'P9999D'
} catch { }
Register-ScheduledTask -TaskName 'GrokRemoteAcpBridge' -Action $action -Trigger @($logon, $once) -Principal $principal -Settings $settings -Description 'User ACP bridge so phone Grok joins the live TUI leader.' | Out-Null
Start-ScheduledTask -TaskName 'GrokRemoteAcpBridge'
Write-Host 'GrokRemoteAcpBridge registered and started'
