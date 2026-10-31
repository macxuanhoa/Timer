#Requires -Version 5.1
<#
  Mint, list or revoke the station invitation links.

  The database password is typed into a hidden prompt and only ever exists in
  $env:PGPASSWORD for the lifetime of the node process. The links themselves are
  written to %USERPROFILE%\.scream-305\invites-<date>.txt, never to git and never
  to this terminal unless you pass --stdout.

    powershell -ExecutionPolicy Bypass -File .\scripts\mint-invites.ps1
    powershell -ExecutionPolicy Bypass -File .\scripts\mint-invites.ps1 --base https://your-app.vercel.app
    powershell -ExecutionPolicy Bypass -File .\scripts\mint-invites.ps1 --role GATE --reassign
    powershell -ExecutionPolicy Bypass -File .\scripts\mint-invites.ps1 --list
    powershell -ExecutionPolicy Bypass -File .\scripts\mint-invites.ps1 --revoke GATE
#>
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Rest)

$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)

$secure = Read-Host -AsSecureString 'Supabase database password (user: postgres)'
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)

try {
  $env:PGPASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  & node scripts/mint-invites.mjs @Rest
  exit $LASTEXITCODE
}
finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
}
