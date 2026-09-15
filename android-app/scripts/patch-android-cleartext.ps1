# Ensure Android allows LAN cleartext HTTP for the Grok Remote iframe.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$android = Join-Path $root 'android'
if (-not (Test-Path $android)) {
  Write-Host 'android/ not found. Run: npx cap add android'
  exit 1
}

$resXml = Join-Path $android 'app\src\main\res\xml'
New-Item -ItemType Directory -Force -Path $resXml | Out-Null
$nsc = Join-Path $resXml 'network_security_config.xml'
@'
<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <base-config cleartextTrafficPermitted="true">
        <trust-anchors>
            <certificates src="system" />
        </trust-anchors>
    </base-config>
</network-security-config>
'@ | Set-Content -Path $nsc -Encoding UTF8

$manifest = Join-Path $android 'app\src\main\AndroidManifest.xml'
$txt = Get-Content $manifest -Raw
$dirty = $false
if ($txt -notmatch 'android:usesCleartextTraffic') {
  $txt = $txt -replace '<application', '<application android:usesCleartextTraffic="true" android:networkSecurityConfig="@xml/network_security_config"'
  $dirty = $true
}
if ($txt -notmatch 'POST_NOTIFICATIONS') {
  $txt = $txt -replace '(</manifest>)', "    <uses-permission android:name=`"android.permission.POST_NOTIFICATIONS`" />`r`n    <uses-permission android:name=`"android.permission.ACCESS_NETWORK_STATE`" />`r`n    <uses-permission android:name=`"android.permission.INTERNET`" />`r`n`$1"
  $dirty = $true
}
if ($dirty) { Set-Content -Path $manifest -Value $txt -Encoding UTF8 }
Write-Host "Wrote $nsc"
