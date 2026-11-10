param(
    [string]$ProjectId = 'gen-lang-client-0504135859',
    [string]$Region = 'europe-west1',
    [string]$ServiceName = 'freepi-proxy'
)

$ErrorActionPreference = 'Stop'
$gcloud = 'C:\Users\liket\Documents\dsh-google\tools\google-cloud-sdk\bin\gcloud.cmd'
if (-not (Test-Path -LiteralPath $gcloud)) {
    $gcloud = 'gcloud'
}

Write-Host "Deploying $ServiceName to Google Cloud Run (Project: $ProjectId, Region: $Region)..."
& $gcloud run deploy $ServiceName `
    --source $PSScriptRoot `
    --project $ProjectId `
    --region $Region `
    --platform managed `
    --allow-unauthenticated `
    --port 8080
