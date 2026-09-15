param(
  [Parameter(Mandatory = $true)][string]$Version,
  [Parameter(Mandatory = $true)][string]$Title,
  [Parameter(Mandatory = $true)][string[]]$Notes,
  [switch]$ForceUpdate,
  [switch]$SkipBuild
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root

$utf8 = New-Object System.Text.UTF8Encoding $false
function Read-Utf8([string]$Path) {
  [System.IO.File]::ReadAllText($Path, $utf8)
}
function Write-Utf8([string]$Path, [string]$Text) {
  [System.IO.File]::WriteAllText($Path, $Text, $utf8)
}

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
$node = if ($nodeCmd) { $nodeCmd.Source } else { $null }
if (-not $node) {
  $hermes = Join-Path $env:LOCALAPPDATA 'hermes\node\node.exe'
  if (Test-Path $hermes) { $node = $hermes }
}
if (-not $node) { $node = "node" }

$notesJson = ConvertTo-Json -Compress -InputObject @($Notes)
if ($notesJson[0] -ne '[') { $notesJson = "[$notesJson]" }
$env:GR_VER = $Version
$env:GR_TITLE = $Title
$env:GR_NOTES = $notesJson
$env:GR_FORCE = if ($ForceUpdate) { "true" } else { "false" }
$bump = Join-Path $root 'scripts\bump-version.mjs'
& $node $bump
if ($LASTEXITCODE -ne 0) { throw "node version bump failed" }

$htmlPath = Join-Path $root 'public\index.html'
$html = Read-Utf8 $htmlPath
$html = [regex]::Replace($html, 'window.GROK_REMOTE_VERSION = "[^"]+"', "window.GROK_REMOTE_VERSION = `"$Version`"")
Write-Utf8 $htmlPath $html

$shellPath = Join-Path $root 'android-app\shell.js'
$shell = Read-Utf8 $shellPath
$shell = [regex]::Replace($shell, 'const APP_VERSION = "[^"]+"', "const APP_VERSION = `"$Version`"")
Write-Utf8 $shellPath $shell

$gradlePath = Join-Path $root 'android-app\android\app\build.gradle'
$gradle = Read-Utf8 $gradlePath
if ($Version -match '^(\d+)\.(\d+)\.(\d+)$') {
  $code = ([int]$Matches[1] * 10000) + ([int]$Matches[2] * 100) + [int]$Matches[3]
  $gradle = [regex]::Replace($gradle, 'versionCode \d+', "versionCode $code")
  $gradle = [regex]::Replace($gradle, 'versionName "[^"]+"', "versionName `"$Version`"")
  Write-Utf8 $gradlePath $gradle
}

Write-Host "Version set to $Version"
if (-not $SkipBuild) {
  powershell -NoProfile -File (Join-Path $root 'android-app\scripts\build-debug-apk.ps1')
}
Write-Host "Phones on v < $Version will see the update banner + changelog and can download /downloads/Grok-Remote.apk"
