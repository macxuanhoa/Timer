# V3.2 pre-flight: đọc migration ledger + phát hiện lượt đang chạy, an toàn mới migrate.
# Password chỉ sống trong tiến trình này qua hidden prompt; không bao giờ vào chat/log.
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
Set-Location (Split-Path -Parent $PSScriptRoot)
$pw = Read-Host -AsSecureString 'Supabase postgres password (user: postgres)'
$b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($pw)
try {
  Remove-Item Env:\DB_HOST, Env:\DB_PORT, Env:\DB_USER, Env:\DB_NAME, Env:\DB_SSL, Env:\SC_ALLOW_ISOLATED_DB -ErrorAction SilentlyContinue
  $env:PGPASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b)
  $env:SUPABASE_PROJECT_REF = 'efsamoxceegkrwucpqkq'
  $env:SUPABASE_REGION = 'eu-west-1'
  node scripts/preflight.mjs
  $code = $LASTEXITCODE
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b)
  Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
}
Write-Host ''
switch ($code) {
  0 { Write-Host 'SAFE — chạy tiếp: powershell -ExecutionPolicy Bypass -File .\scripts\db-push.ps1' -ForegroundColor Green }
  2 { Write-Host 'DỪNG: còn lượt chơi đang mở. Nếu là round legacy (RESETTING/GATE_CLEARED chưa finalise) của sự kiện ĐÃ kết thúc vật lý: chạy scripts\close-rounds.ps1 (đóng bằng đúng RPC máy trạng thái), rồi chạy lại preflight.' -ForegroundColor Red }
  default { Write-Host "DỪNG: preflight exit $code — xem output ở trên." -ForegroundColor Red }
}
Write-Host ''
Read-Host 'Nhấn Enter để đóng'
