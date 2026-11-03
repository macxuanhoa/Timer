Write-Host "=== SCREAM CONTROL V3.1 pre-flight · project efsamoxceegkrwucpqkq ===" -ForegroundColor Cyan
"Repo: $(Get-Location)"
$pw = Read-Host -AsSecureString "Supabase postgres password (user: postgres)"
$b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($pw)
$env:PGPASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b)
[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b)
$env:SUPABASE_PROJECT_REF = "efsamoxceegkrwucpqkq"
$env:SUPABASE_REGION = "eu-west-1"
node scripts/preflight.mjs
$code = $LASTEXITCODE
Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
Write-Host ""
if ($code -eq 0) {
  Write-Host "Preflight SAFE (exit 0)." -ForegroundColor Green
  Write-Host "Nếu đã tạo backup ở https://supabase.com/dashboard/project/efsamoxceegkrwucpqkq/database/backups," -ForegroundColor Yellow
  Write-Host "chạy tiếp:" -ForegroundColor Yellow
  Write-Host '  powershell -ExecutionPolicy Bypass -File .\scripts\db-push.ps1 -ConfigureSupervisorPin -ConfigureStationReset -ConfigureStationCodes' -ForegroundColor White
} elseif ($code -eq 2) {
  Write-Host "Preflight ABORTED: có lượt chơi hoặc claim đang chạy. KHÔNG migrate." -ForegroundColor Red
} elseif ($code -eq 3) {
  Write-Host "Preflight ABORTED: pgcrypto chưa bật ở Supabase → Database → Extensions." -ForegroundColor Red
} else {
  Write-Host "Preflight exit code $code — xem output ở trên." -ForegroundColor Yellow
}
Write-Host "`nNhấn Enter để đóng cửa sổ này."
[Console]::ReadKey() | Out-Null
