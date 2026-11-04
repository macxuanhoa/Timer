# SUPERVISOR recovery (schema 0014): the organiser enters the supervisor PIN
# directly into this hidden prompt; a real authenticated session then signs off
# every open reset task by task_key, finalises the gate and ends the event
# through the production state machine. PIN and password never reach argv,
# history, files or chat; the node child reads them once and deletes its copy.
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
Set-Location (Split-Path -Parent $PSScriptRoot)

$confirm = (Read-Host 'Xác nhận KHU VỰC đội cuối cùng đã được reset VẬT LÝ xong và thông thoáng? gõ đúng: yes').Trim()
if ($confirm -cne 'yes') { Write-Host 'DỪNG: không phải "yes" chính xác. Không có thao tác nào với database.' -ForegroundColor Red; exit 1 }
$reason = (Read-Host 'Lý do đóng sự kiện (bắt buộc, vào audit END_EVENT)').Trim()
if ([string]::IsNullOrWhiteSpace($reason)) { Write-Host 'DỪNG: lý do là bắt buộc.' -ForegroundColor Red; exit 1 }
$pinSecure = Read-Host -AsSecureString 'Supervisor PIN (8-12 digit, chỉ nhập tại đây)'
$pwSecure  = Read-Host -AsSecureString 'Supabase postgres password (chỉ đọc state và xác minh, không ghi SQL)'
$pinB = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($pinSecure)
$pwB  = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($pwSecure)
try {
  Remove-Item Env:\DB_HOST, Env:\DB_PORT, Env:\DB_USER, Env:\DB_NAME, Env:\DB_SSL, Env:\SC_ALLOW_ISOLATED_DB -ErrorAction SilentlyContinue
  $env:SC_SUP_PIN = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pinB)
  $env:PGPASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pwB)
  $env:SC_CONFIRM_PHYSICAL_RESET = 'yes'
  $env:SC_END_REASON = $reason
  node --env-file=.env.local scripts/supervisor-recovery.mjs
  exit $LASTEXITCODE
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pinB)
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pwB)
  Remove-Item Env:\SC_SUP_PIN -ErrorAction SilentlyContinue
  Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
  Remove-Item Env:\SC_CONFIRM_PHYSICAL_RESET -ErrorAction SilentlyContinue
  Remove-Item Env:\SC_END_REASON -ErrorAction SilentlyContinue
}
