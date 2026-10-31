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
param([switch]$Baseline, [switch]$SingleUrl, [switch]$ConfigureSupervisorPin)

$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)

$secure = Read-Host -AsSecureString 'Supabase database password (user: postgres)'
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)

try {
  $env:PGPASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  $nodeArgs = @('scripts/db-push.mjs')
  if ($Baseline) { $nodeArgs += '--baseline' }
  if ($SingleUrl) { $nodeArgs += '--single-url' }
  if ($ConfigureSupervisorPin) {
    $pinSecure = Read-Host -AsSecureString 'New SUPERVISOR PIN (8-12 digits, hidden)'
    $confirmSecure = Read-Host -AsSecureString 'Confirm SUPERVISOR PIN (hidden)'
    $pinBstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($pinSecure)
    $confirmBstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($confirmSecure)
    try {
      $env:SC_SUPERVISOR_PIN = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pinBstr)
      if ($env:SC_SUPERVISOR_PIN -cne [Runtime.InteropServices.Marshal]::PtrToStringBSTR($confirmBstr)) { throw 'PIN confirmation does not match.' }
    } finally {
      [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pinBstr)
      [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($confirmBstr)
    }
    $nodeArgs += '--configure-supervisor-pin'
  }
  & node @nodeArgs
  exit $LASTEXITCODE
}
finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
  Remove-Item Env:\SC_SUPERVISOR_PIN -ErrorAction SilentlyContinue
}
