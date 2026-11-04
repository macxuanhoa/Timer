# SCREAM CONTROL — Room 305

One production root URL for all staff: **https://timer-smoky-seven.vercel.app**.
The existing Vercel project is timer; timer.vercel.app is not assigned to this project.

## One flow, five positions

The night runs as a single authoritative sequence, and every device shows the same
phase of it. Each step belongs to exactly one position, and no step can be pressed
twice or out of order:

```text
01 (sảnh tầng 1) nhận đội & cho lên tầng 2
 → 02 (tầng 2) xác nhận đội đã đến tầng 2       [hoặc NPC 1 bỏ qua tầng 2 có lý do]
  → NPC 1 (cửa vào tầng 3) phổ biến luật và BẮT ĐẦU 5:00
   → 5:00 chạy, mọi máy khoá vào màn hình đồng hồ
    → NPC 2 (phòng 305) ghi nhận báo hoàn thành, rồi kiểm tra trận đồ
     → khớp: chốt THÀNH CÔNG theo đúng mốc báo · hết giờ: HẾT GIỜ
      → NPC 1 xác nhận đội đã rời tầng 3 (mốc hoàn thành không đổi)
       → nhân viên tầng 3 xác nhận reset, NPC 1 đóng lượt, chờ đội kế tiếp
```

**The official time of a successful team is the instant its validated completion
announcement was recorded** (`claimed_at - started_at`) — not the moment NPC2 finished
checking the arrangement, and not the moment the team walked out. Every announcement is
kept as its own attempt (Lần 1, Lần 2, …) with its own timestamp and its own decision.

| Identity | Stored id | Position | Authority |
| --- | --- | --- | --- |
| OPERATOR 01 | `LOBBY` | Tầng 1 / sảnh | Receive the team, name the team, nothing else |
| OPERATOR 02 | `CORRIDOR` | Tầng 2 | Confirm physical arrival at floor 2, then read-only |
| NPC 1 | `GATE` | Cửa vào tầng 3 | Bypass floor 2 (reason), START, confirm exit, early exit |
| NPC 2 | `ROOM305` | Phòng 305 | Record announcements, verify the arrangement |
| Quản trị | `SUPERVISOR` | Không trực tại sàn | Disputes, corrections, reopened resets, closure |
| Người theo dõi | `OBSERVER` | Bất kỳ máy nào | Read-only live view, no password, 10 seats |

## Staff access

Open the root URL → choose an available station → dashboard → **VỀ HOME SCREAM ROOM**.
No account registration, email, invitation token or second confirmation for the four
stations or the viewing seat.

| Tile | Label | Device capacity |
| --- | --- | --- |
| 01 · SẢNH TẦNG 1 | OPERATOR 01 | 1 |
| 02 · TẦNG 2 | OPERATOR 02 | 1 |
| NPC 1 · CỬA VÀO TẦNG 3 | NPC1 / FLOOR3_GATE | 1 |
| NPC 2 · PHÒNG 305 | NPC2 / PUZZLE_CHECKER | 1 |
| XEM TRỰC TIẾP | OBSERVER — no password | 10 concurrent seats |

The retained **QUẢN TRỊ · GIÁM SÁT** entry is deliberately not a tile on the board: it
opens the same PIN sheet from a quiet management line, so the operator side stays
authenticated while the audience side stays open. One identity holds one role; switching
requires releasing first, and the database refuses either direction.

Home reads actual server occupancy. Available stations are green; full stations are grey
and disabled. The viewer seat shows `n/10` and is claimed with no credential at all.
Unknown, stale or offline occupancy is neutral and disabled. A PostgreSQL Realtime
subscription refetches the public board on updates; a 3-second poll and foreground/
online refetch recover missed hints. The server always rechecks capacity at claim time,
so two phones can never take the same seat — including the tenth viewing seat.

On the board heading line, the **↺ RESET BẢNG VỊ TRÍ** icon is the organiser escape hatch for a
stuck board: after the administrator secret is typed in, PostgreSQL revokes every live binding at
once, so all six seats return to CÒN TRỐNG and each kicked phone lands back on this picker within
its next 5-second authority recheck. It is an **access action only** — it never stops a clock,
closes a round, deletes a result or marks a physical check, and the freed seats are immediately
re-claimable. It is refused while a team is inside the 5:00 window: the icon greys out (the board
publishes `game_running`) and the RPC answers `RESET_GAME_RUNNING`, because cancelling a live
round is the separate KẾT THÚC SỚM / HỦY LƯỢT action, which keeps its own history.
The secret field starts masked; the eye button in it switches between readable and
hidden so a long secret can be checked before committing, and closing the sheet always
masks it again.

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

- **One countdown, stored as two instants.** NPC1's `BẮT ĐẦU` writes `started_at` and
  `deadline_at = started_at + 300 s`. Nothing else stores or derives a clock: the 5:00
  cannot be paused, restarted, edited or advanced by any role, including the admin, and
  there is no event-level countdown any more. Every device renders the same remaining
  time from the stored deadline plus its synchronised server-clock estimate, so a
  refresh, a screen sleep or a minute offline neither restarts nor extends it.
- **Expiry is derived, never scheduled.** The phase and the result are computed from
  immutable facts (start, deadline, each announcement's own instant and decision, exit,
  abort), so a device that reconnects after the deadline, a phone with no stream and the
  database all agree without any timer task to win a race against NPC2's decision. At the
  deadline the display stops at `00:00`; it never shows negative digits.
- **Announcement and decision are separate facts.** `CLAIM_COMPLETE` records a row in
  `sc.completion_attempts` with the server instant, the elapsed and remaining time, the
  recorder and `PENDING`, and leaves the countdown running. `VERIFY_ATTEMPT` then judges
  *that one attempt* (`attempt_id`): `CHƯA ĐÚNG` closes it as `INVALID` and keeps every
  earlier row; `CHÍNH XÁC` finalises the round atomically with
  `official_duration_ms = claimed_at - started_at`. An announcement recorded at or after
  the deadline is stored as `LATE`, is visible for the record, and can never be validated
  into a win. A round past its deadline with an open in-time announcement reads
  `HẾT GIỜ — ĐANG CHỜ XÁC MINH MỐC HỢP LỆ`, not as a failure.
- **Completion and departure are separate events.** NPC1's `XÁC NHẬN ĐỘI ĐÃ RỜI TẦNG 3`
  records `exit_confirmed_at` and never touches the score. If an announcement is still
  open, the team is not held in the room: the exit is recorded and the review stays open,
  and the round cannot be closed until NPC2 has settled it. `KẾT THÚC SỚM / RỜI KHU VỰC`
  is the guarded safety path — reason required, second confirmation, result `ABORTED`,
  and no winning time is ever invented.
- **The floor-2 bypass is audited as a bypass.** NPC1 may skip the second-floor
  confirmation when the team is visibly already on floor 3. It writes
  `floor2_bypassed_at/by/reason` and leaves `floor2_confirmed_at` null, flags the round
  for review, and a later press from OPERATOR_02 is refused without reverting anything.
  It cannot be used to skip the reception itself: with no team received there is nothing
  to bypass onto.
- **A locked game screen, not an overlay.** While `5:00` runs (or the clock has run out
  and a milestone awaits verification) every role's phone renders the countdown as the
  whole screen: navigation, the journey editor, the previous phase's buttons and the
  ranking are not rendered at all, session data cannot be edited, and the only controls
  left are NPC2's announcement/verification panel and NPC1's secondary emergency path.
  `MM:SS` carries the screen; the hundredths are a separate, much smaller field; digits
  are tabular so the layout never shifts. At `00:00` the countdown stops rather than
  counting into negative digits, and the moment a round is decided the hero stops
  ticking altogether: it then carries the official time (`THỜI GIAN HOÀN THÀNH`) or, for
  an early exit, the time that was left when NPC1 pressed it (`KẾT THÚC SỚM`) — never an
  invented finishing time.
- **Observers are open and powerless.** No password, no repeated challenge, natural
  entry and exit, ten concurrent seats enforced atomically in PostgreSQL against a
  heartbeat with a timeout, and a viewer identity that reuses its own seat after a
  refresh. A seat is given up only by the viewer's own `THOÁT XEM` (or by a closed tab
  timing out): a screen re-rendering never throws a watching phone out of a seat it is
  sitting in. A viewer's snapshot is redacted *on the server* (`redacted: true`): no action
  log, no claim list, no operator identities, no dispute flags, no hidden-object layout.
  Every command from an `OBSERVER` binding is refused with `READ_ONLY`, and filling the
  ten seats never blocks a station phone (or vice versa).
- **Rendering vs scoring**: phones sync an estimated server clock using RTT probes and a
  monotonic local clock, and re-verify the authoritative revision every 10 s even when
  realtime is silent. The status reads `TRỰC TIẾP` only while a fresh read is recent,
  otherwise `ĐANG ĐỒNG BỘ`, `DỮ LIỆU CÓ THỂ CŨ` or `MẤT KẾT NỐI` — and no action is
  offered while unreadable. Official scores always come from persisted server-side
  instants, never from displayed digits.
- **Disputes are never resolved silently**: a press whose commit arrived more than
  `review_threshold_ms` (default 500 ms) after the physical tap, a validated result
  within 500 ms of 5:00, a bypassed floor, or a hand-corrected timestamp marks the round
  `CHỜ XÉT`. It stays in history with its numbers intact, is excluded from the ranking,
  and only the retained supervisor's reasoned `CHẤP NHẬN` / `LOẠI BỎ` decides. Corrections
  may touch start, deadline, floor-2 and exit instants with a reason — never an
  announcement row, which is why the score can only move by judging the right attempt.
- **Reset integrity**: the three physical checks — hallway and the hidden-object layout on
  floor 3, plus room 305 — are confirmed only by the floor-3 staff who own them (`GATE`,
  `ROOM305`); OPERATOR_02 confirms nothing because it is no longer on that floor.
  `MỞ LẠI RESET` (supervisor, reason required) advances the reset cycle, clears every
  confirmation and revokes readiness. Closure additionally requires the confirmed
  departure and a finalised result.
- **Wall display (màn hình lớn)**: a phone with nothing left to press during the game —
  OPERATOR 01 or OPERATOR 02 — turns itself into the full-screen countdown of the same
  authoritative clock; any other station can open it from `Xem thêm → Màn hình lớn`. It
  offers **no** control over the clock at all, so the number on the wall can never
  disagree with the score, and it closes itself once the round is settled. `CHỈ SỐ TO`
  shows the number alone, a tap brings the buttons back, `Esc` leaves. At `00:00` the
  screen settles into a deep red wash with `HẾT GIỜ`, sounds the critical alarm (with
  `TẮT TIẾNG`) and vibrates where supported — no strobe, no automatic clear.
- **Journey map (hành trình)**: every phone draws the same five-node rail the team walks —
  `SẢNH TẦNG 1 → TẦNG 2 → CỬA VÀO TẦNG 3 → PHÒNG 305 → KẾT THÚC`. Finished legs are red
  checks; the area the team is in or walking into wears its own colour as a glowing ring;
  stops ahead stay grey. Under the rail one status pill carries the sentence all devices
  read, and tapping it opens the floor map with the server time of every press and the
  reset checklist. The rail is derived only from round timestamps, so it cannot invent a
  leg. Observers see the same rail with no tap target at all.

## Operator runbook

1. **Before the doors open**: the retained admin sets the preparation allowance, the reset target
   and the hidden-object owner in `Xem thêm → Quản lý`, and confirms every station phone shows
   `TRỰC TIẾP`. There is no start button anywhere: the countdown exists only per team, opened by
   NPC 1. Each phone must tap once anywhere (that unlocks its alarm audio); the screen then stays
   awake via Wake Lock where the browser supports it.
2. **Normal cycle**: OPERATOR 01 `NHẬN ĐỘI & CHO LÊN TẦNG 2` → OPERATOR 02 `XÁC NHẬN ĐÃ ĐẾN
   TẦNG 2` → NPC 1 `BẮT ĐẦU TRÒ CHƠI — 05:00` (after the briefing and the hints) → NPC 2
   `GHI NHẬN BÁO HOÀN THÀNH`, then `CHÍNH XÁC — CHỐT THỜI GIAN` or `CHƯA ĐÚNG — TIẾP TỤC` →
   NPC 1 `XÁC NHẬN ĐỘI ĐÃ RỜI TẦNG 3` → NPC 1 and NPC 2 `ĐÃ RESET XONG` → NPC 1 `XÁC NHẬN
   SẴN SÀNG`. Only then may OPERATOR 01 receive the next team, and the rail starts again at SẢNH.
   While the countdown runs, all four phones are locked onto the clock: OPERATOR 01 and 02 have
   nothing left to press, so one of them is the wall display.
3. **Team straight to floor 3**: NPC 1 presses `ĐỘI ĐÃ ĐẾN TẦNG 3 — BỎ QUA XÁC NHẬN TẦNG 2`,
   types why, and confirms. The audit records a bypass, never a floor-2 confirmation, and a later
   press by OPERATOR 02 is refused without rewinding the game.
4. **Wrong announcement**: NPC 2 judges that one attempt `CHƯA ĐÚNG`; its row and its timestamp
   stay, the players keep playing, and a new announcement can be recorded. Nothing is ever
   overwritten. A mis-timed press is corrected by judging the *right* attempt, not by editing time.
5. **GAP AFTER THE LAST PLAYER LEAVES**: the screen shows `… ở lại khu vực được …s — NPC 1 chưa
   xác nhận rời tầng 3`. The software never decides a departure by itself; NPC 1 presses
   `XÁC NHẬN ĐỘI ĐÃ RỜI TẦNG 3` when the area is empty. That press cannot change the score.
6. **A claim still open when the clock dies**: the round reads `HẾT GIỜ — ĐANG CHỜ XÁC MINH MỐC
   HỢP LỆ`. NPC 1 may still let the team out; the closure stays blocked (`Kết quả trận chưa chốt`)
   until NPC 2 settles the announcement, which then wins at its own recorded instant.
7. **Premature DONE**: `MỞ LẠI RESET` in `Quản lý` re-opens the cycle (reason required). Both
   floor-3 operators confirm again; readiness is revoked until they do.
8. **Hidden-object mismatch**: the assigned floor-3 operator (NPC 1 or NPC 2) picks the prepared
   layout A/B/C in `Xem thêm → Trạng thái NPC`; it is recorded on the round and on the placement
   confirmation, and every station (including NPC 1, for hints) can read it. Observers cannot.
9. **Safety or an early walk-out**: NPC 1 uses `KẾT THÚC SỚM / RỜI KHU VỰC`, with a reason and a
   second confirmation. The result is `HỦY / RỜI KHU VỰC SỚM`, no winning time is produced, and
   physical egress never depends on the app agreeing to anything.
10. **Network loss**: phones show `MẤT KẾT NỐI`; presses are not sent, and a lost reply is
   reconciled with the server (`ĐANG XÁC MINH…` → `ĐÃ GHI NHẬN (đã xác minh)` or
   `CHƯA ĐƯỢC GHI NHẬN`). The countdown is stored, so a phone that reconnects resumes at the same
   instant, and an announcement that never reached the server simply does not exist — nothing is
   scored twice. If the event must continue without the app: use the paper backup (below), then
   enter the times with `HIỆU CHỈNH` (reason required) once connectivity returns; the round will be
   flagged for review.
11. **Physical backup timer (independent of the app)**: keep one stopwatch at the third-floor
   entrance, started by NPC 1 on `BẮT ĐẦU`, plus a wall clock, and record on paper the team number,
   the start, each "xong" announcement and the exit confirmation. This is the fallback of record for
   scoring disputes; the app is the authoritative system whenever it is reachable.
12. **Room display**: the OPERATOR 01 phone (or any phone via `Màn hình lớn`) is the audience
   countdown. Tap it once early so its alarm is unlocked, then leave it — it opens and closes with
   the game clock by itself. If it is a TV or tablet, open the OPERATOR 01 link on it, or give the
   audience the observer seat: both are read-only and change no score.
13. **Board stuck full** (a crew left mid-shift, phones were handed over, or a station shows
   ĐÃ ĐỦ NGƯỜI with nobody on duty): open the root URL on any phone that is not holding a station,
   tap the **↺** icon on the `VỊ TRÍ TRỰC` line, and type the administrator secret. Every seat
   returns to CÒN TRỐNG, every on-duty phone drops back to this picker, and the crew re-selects its
   station. Clocks, results, claims and history are untouched. This is refused while a team is on
   the 5:00 — NPC 1 has to confirm the departure (or the early exit) first. If nobody is
   trusted with the secret, an administrator may instead revoke one lost `user_id` in `sc.operators`
   from a trusted SQL session.

14. **Next shift, same room (migration 0018)**: after the retained supervisor closes the event
   with `ĐÓNG SỰ KIỆN CÓ KIỂM SOÁT`, every phone reads `SỰ KIỆN ĐÃ KẾT THÚC` and no station can
   receive a team. To hand the room to the next shift, the supervisor taps the **MỞ SỰ KIỆN MỚI**
   button — either on the finished-event card on the dashboard or in `Xem thêm → Quản trị →
   KIỂM SOÁT KHẨN CẤP`. An optional name may be typed there; leaving it blank reuses the closed
   event's name. PostgreSQL creates a fresh `sc.events` row that inherits the operational
   configuration (round duration, prep allowance, reset target, hidden-object owner, hiding layout,
   review threshold, stall warning), moves `sc.state.event_id` to it, resets every clock to null
   and restarts the team sequence at #001. Rounds, completion attempts, reset tasks and
   `sc.action_log` rows of the closed event stay exactly where they were — nothing about the
   previous shift is deleted, rewritten or reset. OPERATOR 01 can then receive the first team of
   the new night on the same five phones, and every phone adopts the fresh event as soon as the
   Realtime broadcast for `sc.state` lands (the frame carries the new `event_id`, so a lower
   revision on the new pointer is treated as authoritative, not stale).

## Security and administration

Migration **0016_unified_flow.sql** carries the V3 flow into the production authority: it adds the
reception/handover/bypass/deadline/exit columns and the `sc.completion_attempts` table, widens every
check before rewriting the live statuses onto the single vocabulary, replaces `sc.role_permissions`
with the V3 matrix, replaces `sc.handle_command` and `sc.snapshot`, and opens the observer seat.
It is forward-only: no table or column is dropped, no historical row loses a timestamp, and rounds
that are still on the floor keep exactly the time they had left (a stored deadline is reconstructed
from the retired banked-time fields, so nobody gains or loses a millisecond from the upgrade).
Rounds that a newer round demonstrably superseded are marked `CLOSED`; their own stamps are kept and
no clearance is claimed for them. Applied migration files 0001–0015 are unchanged.

Migration **0018_open_new_event.sql** adds the counterweight to `END_EVENT`: a single new
`OPEN_NEW_EVENT` action, registered in `sc.role_permissions` for `SUPERVISOR` only, intercepted
inside the `sc.handle_command` wrapper before `_handle_command_internal` reads the current event.
It inserts a fresh `sc.events` row that inherits the closed event's operational configuration,
moves `sc.state.event_id` to it, and writes one `sc.action_log` entry (against the new event, so
the closed event's audit stays intact). Every previous shift's rounds, claims, checklist rows and
audit entries stay exactly where they were. Applied to a database already carrying a closed event
it simply unlocks the next shift; applied to a fresh database it changes nothing until a supervisor
presses the button. Migration files 0001–0017 are unchanged.

Migration **0019_v33_operations.sql** adds the V3.3 stabilisation surface:

  * `sc.release_station(role)` frees one named duty binding. SUPERVISOR-only,
    authorised by the caller's own live binding (the same model as
    `sc.reset_all_stations`), it exists specifically for the stuck-seat case a
    whole-board sweep cannot cover — the sweep is refused while the floor still
    looks live, but a phone that walked off duty is precisely the situation the
    operator needs to unstick. It never touches a round, a clock, a checklist or
    an audit row of the game; it just leaves a `STATION_RELEASED` row in
    `sc.access_audit` naming both the caller and the freed identity.
  * `sc.runtime_flags.min_client_version` stores the bundle floor the command
    surface accepts. `sc.handle_command` refuses anything stamped below it with
    `VERSION_STALE` before any state check runs. A pre-V3.3 bundle sends no
    stamp and is refused when the floor is raised; V3.3+ clients write
    `p_meta._v = APP_VERSION+build` on every command, and `sc.state_revision()`
    carries the floor to the phone on the probe it already polls. The
    `configure_min_client_version` setter is owner-only and defaults to empty,
    so a partially-deployed fleet is never stranded. The `release_station` and
    `reset_all_stations` endpoints intentionally bypass the gate — a supervisor
    phone that is itself stale must always be able to unstick the board.
  * Two partial indexes (`rounds_live_idx`, `reset_tasks_open_idx`) back the
    "one live round per event" and "any outstanding checklist task?" probes the
    dashboard runs on every read.

Migration files 0001–0018 are unchanged.

Claims, releases, PIN changes and commands share a PostgreSQL transaction advisory lock.
The user primary key, the partial unique index on (role, seat_slot) and the slot CHECK constraints
provide additional enforcement: four single station slots plus two supervisor slots, never seven
devices, and ten observer slots claimed the same atomic way. A heartbeat row in
`sc.observer_seats` keeps a viewing seat live; `sc._observer_sweep()` revokes OBSERVER bindings
whose beat is older than 45 s, so an abandoned browser cannot lock the audience out. Every command
still resolves its live binding, role permission, phase, revision and actor-scoped idempotency key
on the server; a phase answer is only given after the revision check, so a device that is merely
behind receives `STALE_REVISION` and resynchronises. Claim/release and the presence endpoints never
touch a round, a clock or a reset task.
Access changes have a separate private audit table and do not alter the scoring history.
`handle_command` truncates the optional `_press` diagnostic instant to whole milliseconds and drops
it when it cannot be read, so a fractional browser clock can never abort a reception, a START, an
announcement or a verification. Committed press and transport values stay whole milliseconds.

An `OBSERVER` binding is refused every action by the permission table (there is no OBSERVER row) and
by `sc.handle_command` itself (`READ_ONLY`), and it can only ever receive the redacted view built by
`sc.snapshot()`/`sc._redact()`: no action log, no claim list, no operator identities, no dispute
flags and no hidden-object layout. RLS additionally denies a viewer SELECT on `sc.rounds`,
`sc.reset_tasks` and `sc.action_log`, so the read-only rule does not depend on the client at all.

PIN hashes use pgcrypto bcrypt with cost 10. No plaintext PIN is stored in Postgres, frontend,
logs or local storage. There are at most 5 PIN attempts per identity and 30 globally in a
15-minute window. The global limit resists rotating anonymous identities but permits a public
attacker to temporarily deny new supervisor claims. Existing supervisors remain operational.
Use a unique randomly chosen 10–12 digit PIN and share it privately with supervisors.

The board reset secret follows the same model: migration **0014_station_reset.sql** stores only
a bcrypt cost-10 hash in `sc.station_access_config`, `sc.reset_all_stations(secret)` compares
the typed value inside PostgreSQL, and neither the secret nor its hash ever reaches the browser,
an audit row or local storage. Refusals are capped at 5 attempts per identity and 10 globally
per 15 minutes under separate `reset:%` counters, so they cannot lock out supervisor PIN claims.
Every refusal (`RESET_REFUSED`) and every sweep (`STATIONS_RESET`, with the number of freed
seats and the secret version) lands in the private access audit. When no secret is configured
the button reports RESET CHƯA ĐƯỢC MỞ and frees nothing.

Rotate through the hidden prompt:

~~~powershell
powershell -ExecutionPolicy Bypass -File .\scripts\db-push.ps1 -ConfigureSupervisorPin
~~~

Install or rotate the reset secret the same way — it is never written to a file:

~~~powershell
powershell -ExecutionPolicy Bypass -File .\scripts\db-push.ps1 -ConfigureStationReset
~~~

The database-owner-only sc.configure_station_access(pin, revoke_supervisors) function supports
rotation, disabling new claims with NULL, and explicit revocation with the second parameter true.
Rotation defaults to preserving on-duty devices. It is not granted to anon/authenticated or
exposed through PostgREST. If a phone is lost, an administrator may revoke only that user_id in
sc.operators from a trusted SQL session; do not clear all staff bindings. No expiry or heartbeat
can silently free a working phone. sc.configure_station_reset(secret) and sc.reset_all_stations(secret)
are owner-only in the same way: the browser can reach only `public.reset_all_stations(text)`, and
freeing the whole board is a deliberate, secret-gated human action rather than an automatic sweep.

Public `station_occupancy` keeps the five operator role/capacity/device counters (the administrator
PIN is now entered from the management line rather than from a tile). `sc.station_board()` reports
`board_version: 2` and counts the operator seats and the ten viewing seats separately, so filling
the audience never makes a station look full. Operator identities, the presence table, the access
audit, PIN hashes and rate-limit counters stay private; internal helpers and retired invitation RPC
grants are revoked.

**Station access trade-off:** the root URL intentionally allows anyone to request an available
station. Capacity prevents a duplicate claim; it does not prove staff membership. One-time crew
codes, hashed server-side and atomically consumed with the claim, would prevent casual outsiders
from occupying the four operator roles. They require distributing a fresh code per new device and
add one entry step. They are not enabled in this release to preserve immediate station selection;
for a publicly advertised event URL, enable such codes in a future forward migration or limit
network access. The admin PIN protects only the retained management entry, and the viewing seat is
open by design.

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
scenarios run before 0010; scenario 033 then checks the capacity, binding, preservation,
PIN and RLS contract of that release. 0011 normalises press instants and scenario 034 checks that a
fractional or malformed press still commits the command; scenarios 035–038 check the round-only
clock, team labels, the secret-gated board sweep and the area-staff-only reset checks. Scenario
**039** then exercises the unified flow itself against the production RPCs: reception, the floor-2
confirmation, the bypass and its stale-press refusal, announcement/announcement scoring, a claim
verified after the deadline, a late claim that cannot win, TIME UP, exit, closure, the next team
inheriting nothing, and the observer seat (no PIN, redacted view, `READ_ONLY` on every command,
ten seats then the eleventh refused, a seat surviving a refresh and an abandoned seat expiring).
Scenario **041** then proves the OPEN_NEW_EVENT handoff on the production RPCs: a duty seat and a
viewer are refused, a live event refuses with `INVALID_STATE`, an actual handoff creates a fresh
`sc.events` row that inherits the round window and hidden-object configuration, moves the pointer,
resets every clock and the team sequence to #001, and — checked with an owner-role fingerprint —
leaves every closed-event row exactly where it was. An idempotent retry with the same key opens
exactly one event. Never run the local auth stub against hosted Supabase.

The workflow browser suite uses the local authoritative engine and covers the full round on four
phones plus a viewer: locked countdown, claim and verification, exit, reset and closure, the bypass
branch, expiry, the guarded early exit, the wall display, 360px layouts and a 1280×800 desktop pass
(no sideways overflow, the hero clock still dominant, the hundredths still an order of magnitude
smaller). The access suite runs
the production Supabase client against real local PostgreSQL RPCs, with only Auth/HTTP transport
adapted by the test harness. It checks the four station slots plus the admin pair and the ten
viewing seats, release/replacement, PWA session reuse, revoked permissions, stale/offline boards,
concurrent database transactions and the post-migration workflow cycles. Its fallback polling tests
deliberately run without Realtime delivery. Hosted GoTrue, live Realtime and physical PWA behavior
require separate production/read-only or venue checks; local tests do not certify physical phones or
venue Wi-Fi.

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
powershell -ExecutionPolicy Bypass -File .\scripts\db-push.ps1 -SingleUrl -ConfigureSupervisorPin -ConfigureStationReset
~~~

The terminal asks for the PostgreSQL password, supervisor PIN and reset secret using hidden
prompts. Secrets exist only in process memory. No DATABASE_URL or password file is needed.
The runner refuses missing 0001–0007 history, locks access changes, fingerprints the event,
rounds, action log, reset tasks and the active roster before/after (and, from this release, the
claim and observer-seat tables too), and commits all pending migrations — including
**0016_unified_flow.sql**, which is on the reviewed allowlist — plus PIN configuration in
one transaction. It rolls back on changed fingerprints or unsafe grants. A non-secret report is
written to .git/production-migration.json. An 8-second lock timeout avoids an indefinite wait.
No on-duty binding is revoked and no event command is sent.

After successful checks and migration, commit and push GitHub main, deploy to the already-linked
Vercel project, and verify the root URL, old deep links, whoami, occupancy and Realtime. Keep the
existing working production domain unless timer.vercel.app is confirmed assigned to this project.
Do not CALL_TEAM or START_GAME on production during validation. A release requires physical
phone/PWA/venue rehearsal separately; keep unverified items explicit in the delivery report.
