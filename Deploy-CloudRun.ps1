param(
    [string]$Account,
    [switch]$RotateKey
)

$ErrorActionPreference = 'Stop'
$setupScript = Join-Path $PSScriptRoot 'tools\google-cloud-setup.mjs'
$argsList = @('--deploy')
if ($Account) { $argsList += @('--account', $Account) }
if ($RotateKey) { $argsList += '--rotate-key' }

& node $setupScript @argsList
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}
