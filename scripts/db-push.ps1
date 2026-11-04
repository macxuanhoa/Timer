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

  V3.2: there are no PINs, crew codes or reset secrets left to install. The one
  optional set-up act is -AllowAdminDevice, which asks for the device uuid the
  /admin screen displays and records it on the admin allow-list. That uuid is an
  identifier, not a credential; the prompt stays hidden only so it never lands in
  shell history next to the password.
#>
param([switch]$Baseline, [switch]$SingleUrl, [switch]$AllowAdminDevice)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
Set-Location (Split-Path -Parent $PSScriptRoot)

$secure = Read-Host -AsSecureString 'Supabase database password (user: postgres)'
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)

try {
  # Deterministic production target: strip any rehearsal override left in the shell.
  Remove-Item Env:\DB_HOST, Env:\DB_PORT, Env:\DB_USER, Env:\DB_NAME, Env:\DB_SSL, Env:\SC_ALLOW_ISOLATED_DB -ErrorAction SilentlyContinue
  $env:PGPASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  # Safety gate: a read-only snapshot of every sc.* table must exist locally
  # before anything is migrated. If the export fails, the migration does not run.
  & node scripts/backup-export.mjs
  if ($LASTEXITCODE -ne 0) { throw 'Backup export failed — refusing to migrate.' }
  $nodeArgs = @('scripts/db-push.mjs', '--single-url')
  if ($Baseline) { $nodeArgs += '--baseline' }
  if ($AllowAdminDevice) {
    $dev = Read-Host 'Admin device uuid shown on /admin (8-4-4-4-12 hex)'
    if ($dev -notmatch '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$') {
      throw 'That is not a device uuid in the shape the /admin screen shows.'
    }
    $env:SC_ADMIN_DEVICE = $dev.ToLower()
    $nodeArgs += '--allow-admin-device'
  }
  & node @nodeArgs
  exit $LASTEXITCODE
}
finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
  Remove-Item Env:\SC_ADMIN_DEVICE -ErrorAction SilentlyContinue
}
