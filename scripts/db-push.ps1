#Requires -Version 5.1
<#
  Apply supabase/migrations/*.sql to the hosted Supabase project.

  The password is typed into a hidden prompt and only ever exists in
  $env:PGPASSWORD for the lifetime of the node process, so it does not end up in
  the shell history, in a file, or in this repository.

    powershell -ExecutionPolicy Bypass -File .\scripts\db-push.ps1
    powershell -ExecutionPolicy Bypass -File .\scripts\db-push.ps1 -Baseline

  -Baseline is only for a database whose sc.* schema was created by hand in the
  SQL editor before this script existed: it records 0001_init.sql as applied
  instead of running it a second time.
#>
param([switch]$Baseline)

$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)

$secure = Read-Host -AsSecureString 'Supabase database password (user: postgres)'
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)

try {
  $env:PGPASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  $nodeArgs = @('scripts/db-push.mjs')
  if ($Baseline) { $nodeArgs += '--baseline' }
  & node @nodeArgs
  exit $LASTEXITCODE
}
finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
}
