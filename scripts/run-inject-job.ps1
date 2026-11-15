$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$job = Join-Path $root 'logs\inject-job.json'
if (-not (Test-Path -LiteralPath $job)) { throw "no inject-job.json" }
$j = Get-Content -LiteralPath $job -Raw | ConvertFrom-Json
$env:TUI_TYPE_FILE = Join-Path $root 'logs\inject-job.txt'
[System.IO.File]::WriteAllText($env:TUI_TYPE_FILE, [string]$j.text)
$result = Join-Path $root 'logs\inject-job.result'
try {
  & (Join-Path $root 'scripts\tui-type.ps1') -ProcessId ([int]$j.pid)
  if ($LASTEXITCODE -ne 0) { throw "tui-type exit $LASTEXITCODE" }
  Set-Content -LiteralPath $result -Value 'ok'
} catch {
  Set-Content -LiteralPath $result -Value ("fail " + $_.Exception.Message)
  exit 1
}
