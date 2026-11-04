# Dong các lượt chơi còn tồn theo ĐÚNG máy trạng thái production (RPC handle_command),
# nhân danh phiên SUPERVISOR đã binding sẵn. Không sửa status bằng SQL, không xoá round.
# Password chỉ sống trong tiến trình này qua hidden prompt.
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
Set-Location (Split-Path -Parent $PSScriptRoot)

$confirm = (Read-Host 'Xác nhận KHU VỰC đội cuối cùng đã được reset VẬT LÝ xong và thông thoáng? gõ đúng: yes').Trim()
if ($confirm -cne 'yes') { Write-Host 'DỪNG: không phải "yes" chính xác. Không có thao tác nào với database.' -ForegroundColor Red; exit 1 }
$reason = Read-Host 'Lý do đóng sự kiện (bắt buộc, sẽ vào audit log)'
if ([string]::IsNullOrWhiteSpace($reason)) { Write-Host 'DỪNG: lý do là bắt buộc.' -ForegroundColor Red; exit 1 }

$pw = Read-Host -AsSecureString 'Supabase postgres password (user: postgres)'
$b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($pw)
try {
  # Deterministic production target: any leftover rehearsal override in this
  # shell (DB_HOST pointing at a sandbox) is removed before the node child starts.
  Remove-Item Env:\DB_HOST, Env:\DB_PORT, Env:\DB_USER, Env:\DB_NAME, Env:\DB_SSL, Env:\SC_ALLOW_ISOLATED_DB -ErrorAction SilentlyContinue
  $env:PGPASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b)
  $env:SC_CONFIRM_PHYSICAL_RESET = 'yes'
  $env:SC_END_REASON = $reason
  node scripts/close-rounds.mjs
  exit $LASTEXITCODE
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b)
  Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
  Remove-Item Env:\SC_CONFIRM_PHYSICAL_RESET -ErrorAction SilentlyContinue
  Remove-Item Env:\SC_END_REASON -ErrorAction SilentlyContinue
}
