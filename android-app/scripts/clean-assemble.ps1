$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$android = Join-Path $root 'android'

function Find-JavaHome {
  $cands = @()
  if ($env:JAVA_HOME) { $cands += $env:JAVA_HOME }
  if ($env:ProgramFiles) {
    $cands += (Join-Path $env:ProgramFiles 'Android\Android Studio\jbr')
    $cands += (Join-Path $env:ProgramFiles 'Android\Android Studio\jre')
  }
  foreach ($p in $cands) {
    if ($p -and (Test-Path (Join-Path $p 'bin\java.exe'))) { return $p }
  }
  throw 'Java runtime not found. Set JAVA_HOME or install Android Studio.'
}

function Find-AndroidSdk {
  $cands = @()
  if ($env:ANDROID_HOME) { $cands += $env:ANDROID_HOME }
  if ($env:ANDROID_SDK_ROOT) { $cands += $env:ANDROID_SDK_ROOT }
  if ($env:LOCALAPPDATA) { $cands += (Join-Path $env:LOCALAPPDATA 'Android\Sdk') }
  foreach ($p in $cands) {
    if ($p -and (Test-Path $p)) { return $p }
  }
  throw 'Android SDK not found. Set ANDROID_HOME.'
}

$jbr = Find-JavaHome
$sdk = Find-AndroidSdk
$env:JAVA_HOME = $jbr
$env:ANDROID_HOME = $sdk
$env:ANDROID_SDK_ROOT = $sdk
$env:Path = (Join-Path $jbr 'bin') + ';' + (Join-Path $sdk 'platform-tools') + ';' + $env:Path
Set-Location $android
& .\gradlew.bat clean assembleDebug --no-daemon
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$apk = Join-Path $android 'app\build\outputs\apk\debug\app-debug.apk'
$pkg = Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
$ver = [string]$pkg.version
$pubDir = Join-Path (Split-Path $root) 'downloads'
New-Item -ItemType Directory -Force -Path $pubDir | Out-Null
Copy-Item $apk (Join-Path $pubDir 'Grok-Remote.apk') -Force
Copy-Item $apk (Join-Path $root ("Grok-Remote-{0}-debug.apk" -f $ver)) -Force
Write-Host "Published clean $ver APK"
