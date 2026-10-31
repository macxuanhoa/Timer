# SCREAM CONTROL — Room 305

One production root URL for all staff: **https://timer-smoky-seven.vercel.app**.
The existing Vercel project is timer; timer.vercel.app is not assigned to this project.

## Staff access

Open the root URL → choose an available station → dashboard → **VỀ HOME SCREAM ROOM**.
No account registration, email, invitation token or second confirmation for NPC roles.

| Station | Label | Device capacity |
| --- | --- | --- |
| LOBBY | SẢNH TẦNG 1 | 1 |
| GATE | NPC 1 / CỬA VÀO | 1 |
| CORRIDOR | NPC 2 / HÀNH LANG | 1 |
| ROOM305 | NPC 3 / PHÒNG 305 | 1 |
| SUPERVISOR | GIÁM SÁT | 2 |

Home reads actual server occupancy. Available stations are green; full stations are grey
and disabled. SUPERVISOR shows 0/2, 1/2 or 2/2 and requires the administrator PIN once
when claiming. Unknown, stale or offline occupancy is neutral and disabled. A PostgreSQL
Realtime subscription refetches the public board on updates; a 3-second poll and foreground/
online refetch recover missed hints. The server always rechecks capacity at claim time.

Supabase Anonymous Auth runs in the background on selection and persists across refresh,
screen lock, network loss and PWA restart. Every boot resolves authority with whoami;
active dashboards recheck it every 5 seconds and on foreground/reconnect. Local storage,
URL parameters and caller-supplied device identifiers never grant production permissions.

Returning Home releases only auth.uid()'s binding and waits for an affirmative server result.
A failure keeps the dashboard and shows a short retry instruction. A committed release with a
lost reply is safely repeatable. Closing a tab, refreshing, going offline or hiding the page
never releases a seat. One identity has one role; switching roles requires releasing first.

Legacy /i/<token> and ?i=<token> URLs are scrubbed to the root and never redeemed. Existing
bindings still restore. Old cached clients cannot redeem invitations after migration 0010.
The historical mint tool refuses operation on the new access model.

## How the rules are implemented

- **The 90-minute clock is a fixed timeline.** It is anchored by the very first `CHO ĐỘI … LÊN`
  press from LOBBY — there is no separate “start event” button — and it never restarts, pauses or
  stops per team. It keeps running through prep, play, resets and idle, and past 90:00 it simply
  keeps counting **negative** (`-1:23`). Warnings at 15 and 5 minutes; closing the event stays an
  explicit, reasoned supervisor decision (`ĐÓNG SỰ KIỆN CÓ KIỂM SOÁT`), never a timer side effect.
- **The 5-minute game clock is the one flexible window**, and it always counts inside that timeline.
  It starts only on GATE's `BẮT ĐẦU` (walking upstairs and the briefing are excluded), keeps running
  after `TRẬN ĐỒ HOÀN THÀNH`, and stops only when GATE confirms the last player is out. GATE (or the
  supervisor) may **tạm dừng** it — the 5:00 freezes and the paused gap is excluded from the score,
  while the 90:00 keeps running — or **reset 5:00** for a team hit by a fault: the window restarts
  from 5:00, the discarded time is logged, and the round is flagged `CHỜ XÉT` because a restarted
  clock is a prize decision. Both presses are authoritative, so every phone sees the same state.
  Past 300 s the game is *overtime*: alarms plus a controlled-exit state, never an automatic clear.
- **Two numbers, no more**: the corner of every phone shows the fixed `SỰ KIỆN 90:00` timeline
  (negative after the deadline) and the hero shows the 5:00 window only while a team is on the
  clock. Prep, reset and idle are status lines, not extra stopwatches; millisecond detail lives in
  `Xem thêm` and on the official result.
- **Admission**: dispatch requires `game limit + preparation allowance` (default 5:00 + 0:90) on the
  event clock; below that the lobby sees `SẮP KẾT THÚC — KHÔNG NHẬN ĐỘI MỚI`. A supervisor may
  override only with a typed reason, which is written to the audit log and flagged on the round.
  Once the event clock reaches zero, admission is refused with no override.
- **Timing is derived, never typed**: every press writes one immutable server-timestamped log row
  (`event`, `round`, `team`, `action`, `actor`, `from`/`to` state, revision, idempotency key,
  metadata). Preparation, game, total/Corridor/Room/GATE reset, inter-team, start-to-start and
  idle-after-ready durations all come from those timestamps. Countdown frames never write to storage.
- **Rendering vs scoring**: phones sync an estimated server clock using RTT probes and a monotonic
  local clock, and re-verify the authoritative revision every 10 s even when realtime is silent.
  The status reads `TRỰC TIẾP` only while a fresh read is recent, otherwise `ĐANG ĐỒNG BỘ`,
  `DỮ LIỆU CŨ` or `MẤT KẾT NỐI` — and no action is offered while unreadable. Official scores
  always come from persisted server-side durations, never from displayed digits.
- **Disputes are never resolved silently**: a press whose commit arrived more than
  `review_threshold_ms` (default 500 ms) after the physical tap, a finish within 500 ms of 5:00, or a
  hand-corrected timestamp marks the round `CHỜ XÉT`. It stays in history with its numbers intact,
  is excluded from the ranking, and only a supervisor's reasoned `CHẤP NHẬN` / `LOẠI BỎ` decides.
  `Xem thêm → Kết nối & cảnh báo` shows measured RTT, data age and audio readiness.
- **Reset integrity**: each confirmation stores round, cycle, actor and server time. `MỞ LẠI RESET`
  (supervisor, reason required) advances the round's reset cycle, clears every confirmation and
  revokes READY, so a reopened round needs all three confirmations again before any dispatch.
- **Wall display (màn hình lớn)**: the moment the official 5-minute clock starts, the LOBBY phone —
  the one station with nothing left to press during a game — turns itself into a full-screen red
  countdown of *that* clock, with the fixed 90:00 timeline in the corner. Any other station can open
  the same view from `Xem thêm → Màn hình lớn`. `RESET 5:00` and `TẠM DỪNG` on the display send the
  same audited commands as the GATE phone (disabled for stations that do not own the clock), so the
  number on the wall can never disagree with the score. `CHỈ SỐ TO` shows the number and nothing else,
  a tap brings the controls back, `Esc` leaves. At `00:00` the screen flashes red with `HẾT GIỜ`,
  the critical alarm sounds (with `TẮT TIẾNG` to silence it) and vibrate fires where supported —
  still no automatic clear. The display closes itself when GATE stops the clock.
- **Journey map (hành trình)**: every phone draws the same five-node rail the team walks —
  `SẢNH TẦNG 1 → CỬA VÀO → HÀNH LANG → PHÒNG 305 → KẾT THÚC`. Finished legs are red checks; the area
  the team is in or walking into wears its own colour as a glowing ring; stops ahead stay grey. Under
  the rail one status pill carries the sentence all five stations read (`Đội đang ở hành lang`), and
  tapping it opens the floor map with the server time of every press and the reset checklist. The
  rail is derived only from round timestamps and the audit log, so it cannot invent a leg; when GATE
  clears the area the route resets to SẢNH, where LOBBY presses first for the next team.
  The five-station relay strip lives in `Xem thêm → Trạng thái NPC`, next to `Màn hình lớn` and
  `Đổi máy`, so the operator screen says one thing at a time.

## Operator runbook

1. **Before the doors open**: supervisor sets the preparation allowance and the reset target in
   `Xem thêm → Quản lý` and confirms all five phones show `TRỰC TIẾP`. There is no start button: the
   90:00 stays frozen at `90:00` until LOBBY sends the first team up. Each phone must tap once
   anywhere (that unlocks its alarm audio); the screen then stays awake via Wake Lock where the
   browser supports it.
2. **Normal cycle**: LOBBY `CHO ĐỘI LÊN` → LOBBY `ĐÃ LÊN TẦNG 3` (the team reached the
   third-floor entrance) → GATE `BẮT ĐẦU` → (optional) CORRIDOR `ĐÃ SETUP XONG` → ROOM305
   `ĐÃ ĐẾN 305`, `XÁC NHẬN HOÀN THÀNH`, `ĐỘI RỜI PHÒNG 305` → GATE `KHÁCH ĐÃ RA — CHỐT GIỜ` →
   CORRIDOR/ROOM305 `ĐÃ RESET XONG` (and GATE too if it owns the hidden objects) → GATE `XÁC NHẬN
   SẴN SÀNG`. Only then may LOBBY call the next team — and the journey rail starts again at SẢNH.
3. **Wrong puzzle confirmation**: supervisor uses `HIỆU CHỈNH` with the field `Trận đồ xong` and an
   empty value (undo) plus a reason. The original timestamp is kept in the audit log, and the result
   is flagged for review — never quietly deleted.
4. **GATE forgets STOP**: the dashboard shows `Đội #… rời 305 được …s — GATE chưa chốt giờ`. The
   software never stops the official clock by itself. GATE presses `KHÁCH ĐÃ RA — CHỐT GIỜ` when the
   last player is out; if the delay was long, the round appears under `KẾT QUẢ CHỜ XÉT`.
5. **Premature DONE**: `MỞ LẠI RESET` in `Quản lý` re-opens the cycle (reason required). All three
   operators confirm again; READY is revoked until they do.
6. **Hidden-object mismatch (Scenario C)**: the assigned operator (CORRIDOR or GATE) picks the
   prepared layout A/B/C in `Xem thêm → Trạng thái NPC`; the layout is recorded on the round and on
   the placement confirmation, and everyone (including GATE, for hints) can read it.
7. **Network loss**: phones show `MẤT KẾT NỐI`; presses are not sent, and a lost reply is reconciled
   with the server (`ĐANG XÁC MINH…` → `ĐÃ GHI NHẬN (đã xác minh)` or `CHƯA ĐƯỢC GHI NHẬN`). A
   `STOP` that never reached the server leaves the game clock running — nothing is scored twice.
   If the event must continue without the app: use the paper backup (below), then enter the times with
   `HIỆU CHỈNH` (reason required) once connectivity returns; the round will be flagged for review.
8. **Physical backup timer (independent of the app)**: keep one analogue or phone stopwatch at the
   third-floor entrance, started by GATE on `BẮT ĐẦU` and stopped when the last player exits, plus a
   wall clock for the 90-minute event. Record team number, start, stop and the exit confirmation on
   paper for every round. This is the fallback of record for scoring disputes; the app is the
   authoritative system whenever it is reachable.
9. **Room display**: the LOBBY phone (or any phone via `Màn hình lớn`) is the audience countdown.
   Tap it once early so its alarm is unlocked, then leave it — it opens and closes with the game
   clock by itself. If it is a TV or tablet, open the LOBBY link on it: the display is read-only and
   changes no score, so it is safe to aim at the players.

## Security and administration

Migration **0011_command_press_integer.sql** follows 0010_single_url_roles.sql,
0009_board_capacity.sql and 0008_supervisor_pair.sql. Applied migration files 0001–0010 are
unchanged. All active bindings, events, rounds, reset tasks and action logs survive the upgrade.
The migration ledger decides which forward files remain pending; never reset bindings for this
upgrade.

Claims, releases, PIN changes and commands share a PostgreSQL transaction advisory lock.
The user primary key, partial unique index on (role, seat_slot) and slot CHECK constraints
provide additional enforcement: four single slots plus two supervisor slots, never seven devices.
Every command still resolves its live binding, role permission, state, revision and actor-scoped
idempotency key on the server. Claim/release do not call _ensure_event, tick, START or RESET.
Access changes have a separate private audit table and do not alter the scoring history.
handle_command truncates the optional `_press` diagnostic instant to whole milliseconds and drops
it when it cannot be read, so a fractional browser clock can never abort START, STOP or PUZZLE.
Committed press and transport values stay whole milliseconds either way.

PIN hashes use pgcrypto bcrypt with cost 10. No plaintext PIN is stored in Postgres, frontend,
logs or local storage. There are at most 5 PIN attempts per identity and 30 globally in a
15-minute window. The global limit resists rotating anonymous identities but permits a public
attacker to temporarily deny new supervisor claims. Existing supervisors remain operational.
Use a unique randomly chosen 10–12 digit PIN and share it privately with supervisors.

Rotate through the hidden prompt:

~~~powershell
powershell -ExecutionPolicy Bypass -File .\scripts\db-push.ps1 -ConfigureSupervisorPin
~~~

The database-owner-only sc.configure_station_access(pin, revoke_supervisors) function supports
rotation, disabling new claims with NULL, and explicit revocation with the second parameter true.
Rotation defaults to preserving on-duty devices. It is not granted to anon/authenticated or
exposed through PostgREST. If a phone is lost, an administrator may revoke only that user_id in
sc.operators from a trusted SQL session; do not clear all staff bindings. No expiry or heartbeat
can silently free a working phone.

Public station_occupancy contains only five role/capacity/device counters. RLS permits SELECT
for anon/authenticated and no client writes. Operator identities, access audit, PIN hashes and
rate-limit counters stay private; internal helpers and retired invitation RPC grants are revoked.

**NPC access trade-off:** the root URL intentionally allows anyone to request an available NPC
station. Capacity prevents a duplicate claim; it does not prove staff membership. One-time crew
codes, hashed server-side and atomically consumed with the claim, would prevent casual outsiders
from occupying NPC roles. They require distributing a fresh code per new device and add one
entry step. They are not enabled in this release to preserve immediate station selection; for a
publicly advertised event URL, enable such codes in a future forward migration or limit network
access. A supervisor PIN does not protect NPC slots.

## Validation

~~~powershell
npm ci
npm run typecheck
npm test
npm run test:sql
npm run test:e2e
npm run test:access
npm run build
~~~

SQL validation uses a disposable local PostgreSQL 16 Docker container. Historical access
scenarios run before 0010; scenario 033 then checks the new capacity, binding, preservation,
PIN and RLS contract. 0011 then normalises press instants and scenario 034 checks that a
fractional or malformed press still commits the command. Never run the local auth stub against
hosted Supabase.

The workflow browser suite uses the local authoritative engine and covers full rounds, ranking,
timeout, admission cutoff, offline commands, the wall display and 360px layouts. The access suite
runs the production Supabase client against real local PostgreSQL RPCs, with only Auth/HTTP
transport adapted by the test harness. It checks all six slots, release/replacement, PWA session
reuse, revoked permissions, stale/offline boards, concurrent database transactions and workflow
cycles after the migration. Its fallback polling tests deliberately run without Realtime delivery.
Hosted GoTrue, live Realtime and physical PWA behavior require separate production/read-only or
venue checks; local tests do not certify physical phones or venue Wi-Fi.

On 2026-10-31 the hosted access smoke passed anonymous auth, final-NPC-slot contention,
whoami, identity exclusivity, revoked legacy access, release/reclaim and actual PostgreSQL
Realtime delivery for claim and release. All test bindings were released; the three on-duty
bindings remained. Database fingerprints before/after the upgrade matched for events, rounds,
action logs, reset tasks, state and the active roster. The live supervisor PIN was entered only
in the hidden administrator terminal; the two-supervisor live-device test remains unverified.
Run the access-only production smoke without event actions:

~~~powershell
node --env-file=.env.local scripts/verify-production-access.mjs
~~~

For local development, set VITE_BACKEND=local explicitly. Its ?station= links and shared test
passcodes are development-only; its picker does not simulate production slot ownership.
Both browser suites set their backend and use separate ports, databases and output folders.
Run destructive workflow rehearsals only locally or against a separate rehearsal database.
The legacy invitation rehearsal driver is for pre-0010 installations and cannot grant new access.

## Production rollout

Use the existing Supabase project and Vercel project; do not create replacements.
Run the protected database upgrade before pushing main (GitHub pushes trigger Vercel):

~~~powershell
powershell -ExecutionPolicy Bypass -File .\scripts\db-push.ps1 -SingleUrl -ConfigureSupervisorPin
~~~

The terminal asks for the PostgreSQL password and supervisor PIN using hidden prompts.
Secrets exist only in process memory. No DATABASE_URL or password file is needed.
The runner refuses missing 0001–0007 history, locks access changes, fingerprints the event
and active roster before/after, and commits all pending migrations plus PIN configuration in
one transaction. It rolls back on changed fingerprints or unsafe grants. A non-secret report is
written to .git/production-migration.json. An 8-second lock timeout avoids an indefinite wait.
No on-duty binding is revoked and no event command is sent.

After successful checks and migration, commit and push GitHub main, deploy to the already-linked
Vercel project, and verify the root URL, old deep links, whoami, occupancy and Realtime. Keep the
existing working production domain unless timer.vercel.app is confirmed assigned to this project.
Do not CALL_TEAM or START_GAME on production during validation. A release requires physical
phone/PWA/venue rehearsal separately; keep unverified items explicit in the delivery report.
