# Allow LAN inbound to Grok Remote HTTP (2420) and ACP (2419). Run elevated.
$ErrorActionPreference = 'Stop'
foreach ($rule in @(
  @{ Name = 'Grok Remote HTTP'; Port = 2420 },
  @{ Name = 'Grok Remote ACP'; Port = 2419 }
)) {
  netsh advfirewall firewall delete rule name="$($rule.Name)" | Out-Null
  netsh advfirewall firewall add rule name="$($rule.Name)" dir=in action=allow protocol=TCP localport=$($rule.Port) remoteip=localsubnet profile=private,domain
  Write-Host "OK $($rule.Name) TCP $($rule.Port) from localsubnet"
}
