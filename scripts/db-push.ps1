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

  -ConfigureSupervisorPin, -ConfigureStationReset and -ConfigureStationCodes install a
  bcrypt hash of the typed secret. Neither value is echoed, saved to a file or sent to
  the browser. The crew codes are the four operating positions' access codes; the
  viewing seat stays password-free by design.
#>
param([switch]$Baseline, [switch]$SingleUrl, [switch]$ConfigureSupervisorPin, [switch]$ConfigureStationReset, [switch]$ConfigureStationCodes)

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
  if ($ConfigureStationReset) {
    $secretSecure = Read-Host -AsSecureString 'Station reset secret (10-64 characters, hidden)'
    $secretConfirm = Read-Host -AsSecureString 'Confirm station reset secret (hidden)'
    $secretBstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secretSecure)
    $secretConfirmBstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secretConfirm)
    try {
      $env:SC_STATION_RESET_SECRET = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($secretBstr)
      if ($env:SC_STATION_RESET_SECRET -cne [Runtime.InteropServices.Marshal]::PtrToStringBSTR($secretConfirmBstr)) { throw 'Reset secret confirmation does not match.' }
    } finally {
      [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($secretBstr)
      [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($secretConfirmBstr)
    }
    $nodeArgs += '--configure-station-reset'
  }
  if ($ConfigureStationCodes) {
    # One code per operating position, read twice, never echoed. The JSON map only
    # lives in this process' environment and is removed in the finally block.
    $codes = [ordered]@{}
    foreach ($role in @('LOBBY','CORRIDOR','GATE','ROOM305')) {
      $codeSecure = Read-Host -AsSecureString "Crew code for $role (4-12 chars A-Z/0-9, hidden)"
      $codeConfirm = Read-Host -AsSecureString "Confirm crew code for $role (hidden)"
      $codeBstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($codeSecure)
      $codeConfirmBstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($codeConfirm)
      try {
        $value = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($codeBstr).ToUpper()
        if ($value -cne [Runtime.InteropServices.Marshal]::PtrToStringBSTR($codeConfirmBstr).ToUpper()) { throw "Crew code confirmation for $role does not match." }
        if ($value -notmatch '^[A-Z0-9]{4,12}$') { throw "The crew code for $role must be 4-12 characters of A-Z or 0-9." }
        $codes[$role] = $value
      } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($codeBstr)
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($codeConfirmBstr)
      }
    }
    $env:SC_STATION_CODES = ($codes | ConvertTo-Json -Compress)
    $nodeArgs += '--configure-station-codes'
  }
  & node @nodeArgs
  exit $LASTEXITCODE
}
finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
  Remove-Item Env:\SC_SUPERVISOR_PIN -ErrorAction SilentlyContinue
  Remove-Item Env:\SC_STATION_RESET_SECRET -ErrorAction SilentlyContinue
  Remove-Item Env:\SC_STATION_CODES -ErrorAction SilentlyContinue
}
