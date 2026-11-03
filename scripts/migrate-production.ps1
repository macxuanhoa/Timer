#Requires -Version 5.1
<#
  SCREAM CONTROL V3.1 — Production pre-flight + migrate.
  Runs in its own visible window (Start-Process). Reads secrets via
  Read-Host -AsSecureString so nothing echoes to console or history.

  Safety order:
    1. Prompt for Supabase DB password.
    2. Read the migration ledger → determine what's pending.
    3. Query sc.rounds WHERE status <> 'CLOSED' and pending claims.
    4. If any live activity → STOP, print details, do NOT migrate.
    5. Otherwise show the summary + confirmation prompt.
    6. Hand off to scripts/db-push.ps1 (which re-prompts for password).
    7. Post-migration verification through psql.
    8. Marker file .audit-tmp/migration.out tells the caller it's done.
#>
$ErrorActionPreference = 'Stop'
$ref = 'efsamoxceegkrwucpqkq'
$region = 'eu-west-1'
$root = Split-Path -Parent $PSScriptRoot
$marker = Join-Path $root '.audit-tmp/migration.out'
Set-Content -Path $marker -Value "started $(Get-Date -Format o)" -Encoding utf8

function Log($m) { Write-Host $m; Add-Content -Path $marker -Value $m -Encoding utf8 }

try {
  Log "=== SCREAM CONTROL V3.1 pre-flight · project $ref ==="
  $pw = Read-Host -AsSecureString "Supabase postgres database password"
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($pw)
  $env:PGPASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)

  # Use psql through the Supavisor pooler (dual-stack), same as pooler.mjs.
  $host_ = "aws-0-$region.pooler.supabase.com"
  $user = "postgres.$ref"
  $q = { param($sql) & psql -h $host_ -p 5432 -U $user -d postgres -v ON_ERROR_STOP=1 -qtA -c $sql }

  Log "`n--- Ledger ---"
  $ledger = & $q "select coalesce(string_agg(name, ', ' order by name), '(no rows)') from public._sc_migrations"
  if ($LASTEXITCODE -ne 0) { throw "psql failed to read ledger (auth?)" }
  Log $ledger

  Log "`n--- Active rounds (status <> CLOSED) ---"
  $active = & $q "select coalesce(string_agg(id || ' team#' || team_number || ' ' || status, '; ' order by id), 'NONE') from sc.rounds where status <> 'CLOSED'"
  Log $active

  Log "`n--- Pending claims on non-closed rounds ---"
  $pending = & $q "select coalesce(string_agg(a.id || ' round=' || a.round_id || ' seq=' || a.seq, '; ' order by a.id), 'NONE') from sc.completion_attempts a join sc.rounds r on r.id = a.round_id where a.status in ('PENDING','LATE') and r.status <> 'CLOSED'"
  Log $pending

  Log "`n--- Live bindings ---"
  $bound = & $q "select coalesce(string_agg(role || '@slot' || seat_slot, ', ' order by role, seat_slot), 'NONE') from sc.operators where revoked_at is null"
  Log $bound

  $hasActive = ($active -notmatch '^NONE$') -or ($pending -notmatch '^NONE$')
  if ($hasActive) {
    Log "`n*** DỪNG: phát hiện lượt chơi hoặc claim đang chạy. Không migrate. ***"
    Log "Hãy để sự kiện kết thúc rồi chạy lại."
    Add-Content $marker "aborted-live-activity" -Encoding utf8
    Read-Host "`nNhấn Enter để đóng" | Out-Null
    exit 2
  }

  Log "`nOK: không có hoạt động đang diễn ra."
  Log "`n--- Postgres version ---"
  Log (& $q "select version()")
  Log "`n--- pgcrypto extension ---"
  Log (& $q "select coalesce(string_agg(extname, ', '), 'MISSING: pgcrypto') from pg_extension where extname = 'pgcrypto'")

  $confirm = Read-Host "`nGõ 'MIGRATE' (in hoa) để tiếp tục, hoặc Enter để huỷ"
  if ($confirm -cne 'MIGRATE') {
    Log "Cancelled by user."
    Add-Content $marker "cancelled" -Encoding utf8
    Read-Host "Nhấn Enter để đóng" | Out-Null
    exit 0
  }

  Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
  Log "`n=== Chạy scripts/db-push.ps1 -ConfigureStationCodes -ConfigureSupervisorPin -ConfigureStationReset ==="
  $pushArgs = @(
    '-ExecutionPolicy','Bypass',
    '-File', (Join-Path $root 'scripts/db-push.ps1'),
    '-ConfigureStationCodes','-ConfigureSupervisorPin','-ConfigureStationReset'
  )
  & powershell @pushArgs
  if ($LASTEXITCODE -ne 0) {
    Log "db-push exited $LASTEXITCODE"
    Add-Content $marker "db-push-failed exit=$LASTEXITCODE" -Encoding utf8
    Read-Host "Nhấn Enter để đóng" | Out-Null
    exit 1
  }

  Log "`n=== Post-migration verify ==="
  $env:PGPASSWORD = (Get-Content Env:\PGPASSWORD -ErrorAction SilentlyContinue)  # reuse if still in scope
  Log ("board_version now: " + (& $q "select (public.station_board() ->> 'board_version')"))
  Log ("codes_required:    " + (& $q "select (public.station_board() ->> 'codes_required')"))
  Log ("station_codes set: " + (& $q "select count(*) from sc.station_codes"))
  Log ("has supervisor PIN hash: " + (& $q "select supervisor_pin_hash is not null from sc.station_access_config where id"))
  Log ("reset secret hash:       " + (& $q "select reset_secret_hash is not null from sc.station_access_config where id"))

  Log "`nHOÀN THÀNH."
  Add-Content $marker "success" -Encoding utf8
} catch {
  Log "ERROR: $($_.Exception.Message)"
  Add-Content $marker "error $($_.Exception.Message)" -Encoding utf8
} finally {
  Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
}
Read-Host "`nNhấn Enter để đóng cửa sổ" | Out-Null
