# SCREAM CONTROL — Room 305 · V2

Single-screen, mobile-first PWA for running a 90-minute Halloween Scream Room event from
five phones. One fixed 90-minute timeline, one flexible 5-minute game window, five synchronised
operators, automatic round-by-round timing, team ranking, audited overrides and one obvious
next action per phone.

```
npm install
npm run dev          # http://localhost:5173  (authoritative engine runs in-process)
```

Then open the app from five devices (or five browser profiles), each on its own station link — see
below.

## Operator access

Production has no accounts and no login screen. There are exactly **five permanent station links**
— one per role — built from 256-bit tokens of which only the SHA-256 is stored. A link never expires
and is never spent; what is exclusive is the **seat**: at most one live device per role — with one
deliberate exception, **SUPERVISOR may be staffed by two devices** (organiser + assistant) opening
the same link. Every other station still accepts exactly one phone.

1. The organizer mints the five links once: `powershell -ExecutionPolicy Bypass -File .\scripts\mint-invites.ps1`.
   They are written to `%USERPROFILE%\.scream-305\invites-<date>.txt` (never into git, never into the
   terminal log) and are sent to the five phones.
2. Opening `https://<app>/i/<token>` signs the phone in anonymously — Supabase Anonymous Sign-ins,
   invisible to the operator — and binds it to that station. The app lands straight on the station's
   dashboard: no password, no role picker.
3. The session survives refresh and PWA restart: Supabase persists the anonymous session and the app
   re-reads its role with `whoami()` on every boot. Locking the screen or losing the network for a
   while does not touch the binding.
4. The link is reusable for ever, but only while its station is **free**. With a phone already on duty,
   another phone opening the same link is refused with `VỊ TRÍ ĐANG CÓ NGƯỜI SỬ DỤNG`, and no link —
   a second one, a forgotten bookmark, an edited URL — can evict, replace or kick the phone on duty.
   SUPERVISOR is the only double-staffed station: the same link admits a second supervisor into the
   second seat, and a third device is still refused with the same sentence.
5. The gate paints the five-seat board — **red** for a station that already has a phone, **green** for
   a free one — straight from the database, before the phone holds any session.
6. Replacing a phone: `ĐỔI MÁY` releases the binding on the server, then the new phone opens the
   **same** link. Lost phone: the organizer runs `...mint-invites.ps1 --release GATE`, and the same link
   is usable again — no new link is minted.
7. Refresh, screen lock, PWA cold start and temporary network loss never free a seat. The only release
   paths are `release_device` (the ĐỔI MÁY button) and the organizer's `--release`; there is no TTL and
   no heartbeat that could drop a working phone.
8. The token is removed from the address bar as soon as it has been read, and it is never written to
   storage: only the Supabase session is kept on the phone.

| Station | Owns |
| --- | --- |
| LOBBY | call/dispatch a team — the first call starts the 90:00 |
| GATE · NPC 1 | **start** and **stop** the 5:00, pause/restart it, final readiness |
| CORRIDOR · NPC 2 | hallway progress, hidden objects + hallway reset |
| ROOM 305 · NPC 3 | arrival, puzzle completion, room reset |
| SUPERVISOR | close event, config, overrides, abort, corrections, CSV |

Only GATE can finalise readiness, only GATE stops the 5:00 (and only GATE or the supervisor may
pause or restart it), and only SUPERVISOR may override admission or correct a record — all enforced
inside Postgres by `sc.role_permissions`, not merely hidden in the UI. The right to *be* SUPERVISOR
is the SUPERVISOR link itself: no client can ask for a role, and a bound phone that opens another
station's link is refused.

**Why the PostgreSQL role is never the authority.** An anonymous session and a password session are
granted the *same* database role — `authenticated` — so a grant to `authenticated` can only ever mean
"this function is callable", never "this caller may act". Every operator-facing function therefore
resolves `auth.uid()` against the live `sc.operators` binding before it reads `sc.role_permissions`, and
the RLS policies on the seven readable tables go through `sc.is_operator()` (self-only for
`sc.operators`). An anonymous phone that holds no valid link is `authenticated` and still gets zero rows
and `PERMISSION_DENIED` on every write — asserted by SQL scenario 030, and re-checked against the live
catalog with `npm run test:sql`.

### Handing over the five links

`mint-invites.ps1` prints nothing to the terminal: the five links (labelled `LOBBY`, `NPC 1`, `NPC 2`,
`NPC 3`, `SUPERVISOR`) land in `%USERPROFILE%\.scream-305\invites-<date>.txt`. Hand them over like
you would hand over a house key:

| Link | Send to | Channel |
| --- | --- | --- |
| `LOBBY` | the lobby desk phone | one-to-one message to that person, or open the link on the phone in front of them |
| `GATE` (`NPC 1`) | the third-floor entrance phone | as above |
| `CORRIDOR` (`NPC 2`) | the hallway phone | as above |
| `ROOM305` (`NPC 3`) | the room phone | as above |
| `SUPERVISOR` | the organizer's own phone only | never in a group chat — this link grants corrections, overrides and closure |

- Five links in total, permanent and reusable. Open one while its station is free and that phone takes
  the seat; open it while the station is on duty and the answer is `VỊ TRÍ ĐANG CÓ NGƯỜI SỬ DỤNG`.
- A leaked link that is **not** bound is a station key: burn it with
  `...mint-invites.ps1 --revoke GATE` and mint a replacement for that station only (`--role GATE`).
  A leaked link that **is** bound is worse: `--release GATE` first, then replace the link.
- Do not photograph the list, do not paste links into a group, do not print them on a QR at the desk,
  and do not commit the file (it lives outside the repository by design). Keep it — it is the only
  copy, because the database stores hashes only.
- Moving a station to another phone: `ĐỔI MÁY` on the old one (or `--release GATE` when the phone is
  lost), then open the **same** link on the new one. Nothing is re-minted, nothing is re-registered.
- All five stations on duty: a new phone is refused on every link (at most six devices in total:
  four single-staffed stations plus two supervisors), while the live dashboards keep their seat,
  their session and every command. Freeing any seat makes its link usable again at once.
- SUPERVISOR alone may be staffed twice on the same link. Both devices get the real supervisor
  rights, and the audit log tells them apart by `actor_id`; a third device is refused.
  To give the seat to someone else, either supervisor releases its own phone (or the organiser runs
  `--release SUPERVISOR`, which frees both).
- Nothing expires (`--expires` is ignored and warned about). Re-mint only for a leak or a lost file;
  that revokes the station's previous link and nothing else.
- Staff never register anything: no email, no phone number, no password, no PIN.

The self-hosted engine (`npm run dev`) has no Supabase to redeem against, so `/?station=GATE` stands
in for a link: it signs in with that station's `SC_PASSCODE_*` value (default `3110`; override the
client side with `VITE_DEV_PASSCODE`). It is a development harness and is never part of a production
build.

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

## Final rehearsal (never on the official event)

The official event must still be frozen when the doors open: `event_started_at IS NULL`, no rounds,
no action-log rows, an empty leaderboard and five free seats. A rehearsal cannot be run there —
one `CALL_TEAM` anchors the 90-minute clock, every press writes the append-only history, and the five
rehearsal devices would take the five seats the event needs. Two isolated environments are supported.

**Option A — a second Supabase project (closest to production).** Create an empty project, enable
Anonymous sign-ins, apply the migrations, mint rehearsal links, then drive five devices:

```powershell
powershell -File .\scripts\db-push.ps1        # 0001–0008 against the rehearsal database
powershell -File .\scripts\mint-invites.ps1 --base https://<rehearsal-app-url>
node scripts/rehearsal.mjs --url https://<rehearsal-ref>.supabase.co --key <rehearsal-publishable-key> --links ~\.scream-305\invites-<date>.txt
```

`scripts/rehearsal.mjs` signs in five anonymous devices, redeems the five links, runs
`CALL_TEAM → TEAM_UPSTAIRS → START_GAME → HALLWAY_PROGRESS → ROOM_REACHED → PUZZLE_COMPLETE →
RETURN_START → GAME_STOP → RESET_DONE ×3 → GATE_FINALIZE`, then runs a second round that forces
`TIMEOUT` (it shortens `game_limit_ms` through supervisor `CONFIGURE`, so `allow_test_clock` stays
false everywhere), and prints one PASS/FAIL row per check, including cross-role refusals and
measured realtime push lag. Safety: it refuses the official project ref with no override flag, and
aborts if the target event already has an active round or an anchored clock. Tokens are read from
the mint file and never printed. Add `--keep-bound` to leave the five seats live for the manual
phone walk-through, and `--game-limit-ms` to control how long the timeout takes.

**Option B — the self-hosted engine on the venue Wi-Fi (fastest, zero Supabase exposure).** Delete
`.scream-data/event.json`, run `npm run dev` on a laptop plugged into the same access point, and
have the five phones open `http://<laptop-ip>:5173/?station=LOBBY` … `?station=SUPERVISOR`. Same
rule engine, same SSE realtime, same alarms. Plain `http://` on a LAN IP is not a secure context,
so service-worker install and Wake Lock are unavailable: this rehearses timing, hand-offs and
audio, not the PWA shell. Never use `?station=` links on event day — they are a development harness.

Then walk the manual checklist, one tick per line, with five real phones on the venue Wi-Fi:

| # | Do on | Must see on all five phones |
| --- | --- | --- |
| 1 | LOBBY `CHO ĐỘI … LÊN` | 90:00 starts running; others show `ĐÃ GỌI ĐỘI`; GATE shows the wait line |
| 2 | LOBBY `ĐÃ LÊN TẦNG 3` | rail moves to CỬA VÀO with `Đội đã lên tới cửa vào tầng 3` |
| 3 | GATE `BẮT ĐẦU` | hero `05:00.000` counting in GAME mode; LOBBY phone becomes the wall display |
| 4 | CORRIDOR `ĐÃ SETUP XONG`, ROOM305 `ĐÃ ĐẾN 305` | rail lights in order, no phone disagrees |
| 5 | ROOM305 `XÁC NHẬN HOÀN THÀNH` | clock **keeps running**, `Trận đồ đã hoàn thành` |
| 6 | (rehearsal only) let 5:00 expire | `HẾT GIỜ` flash, alarm audible, vibrate on Android — still no automatic clear |
| 7 | GATE `KHÁCH ĐÃ RA — CHỐT GIỜ` | one `official_duration_ms`, identical on all five, outcome `WON`/`TIMEOUT` |
| 8 | GATE `XÁC NHẬN SẴN SÀNG` too early | refused: `Chưa xác nhận reset: còn N tác vụ` |
| 9 | CORRIDOR + ROOM305 (+ GATE if it owns the objects) `ĐÃ RESET XONG` | checklist fills, then GATE may finalize → `SẴN SÀNG` |
| 10 | LOBBY calls the next team | only allowed now; rail restarts at SẢNH |
| 11 | `Xem thêm → Kết nối & cảnh báo` on each phone | sane RTT and data age; write down the worst p95 (target < 500 ms) |
| 12 | drop Wi-Fi on one phone during STOP | `ĐANG XÁC MINH…` then the truth; no score is invented |
| 13 | `Xem thêm → Bảng xếp hạng` | finished rounds ranked, disputed ones withheld with a reason |
| 14 | lock and unlock a phone mid-game | on reopening it rejoins the live round from the server |

Afterwards reset the rehearsal state. Rehearsal links stay bound to the rehearsal project, so the
official five must be minted from the official project — and only after the rehearsal passes.

One gotcha worth writing down: a `.env.local` containing `VITE_BACKEND=supabase` (created by
`vercel env pull`) makes `npm run dev` skip the in-process engine, so Option B and
`npm run test:e2e` both need that file absent.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | App + in-process authoritative engine (HTTP + SSE at `/api/*`), state persisted to `.scream-data/event.json` so a restart restores the live session |
| `npm run build` / `npm run preview` | Production PWA build (service worker, installable, standalone) |
| `npm test` | Vitest: domain rules, engine, five-client reconciliation, real HTTP+SSE transport |
| `npm run test:sql` | Runs `supabase/migrations/*` plus the operator, hardening and invitation scenarios against a throwaway Postgres 16 container (Docker required) |
| `npm run test:e2e` | Playwright: five phone profiles, one real round, 360 px layout, cutoff, overtime, the invitation gate |
| `npm run typecheck` | `tsc --noEmit` over app, server, migrations-facing client code and tests |
| `powershell -File .\scripts\db-push.ps1` | Applies pending migrations to the hosted Supabase project; prompts for the database password with no echo |
| `powershell -File .\scripts\mint-invites.ps1` | Mints/replaces the five permanent station links (`--list` shows ACTIVE/REVOKED + OCCUPIED/available + NEVER EXPIRES; `--release GATE` frees a lost phone's seat; `--revoke GATE` burns a leaked link; `--role GATE` replaces one station's link) |

The browser suite is serial: run the whole file (`npm run test:e2e`) rather than a single case.

## Production deployment (Supabase)

1. Create a Supabase project (Postgres, Auth, Realtime enabled).
2. **Turn on anonymous sign-ins**: Authentication → Sign In / Providers → *Anonymous sign-ins* →
   Enable → Save. Without this the phone cannot obtain the anonymous identity that the station link
   is bound to, and the gate reports `SUPABASE CHƯA BẬT ĐĂNG NHẬP ẨN DANH`. Nothing else about Auth
   needs configuring: there are no users to create, no email templates and no passwords.
3. Apply the migrations: `powershell -ExecutionPolicy Bypass -File .\scripts\db-push.ps1` prompts for
   the database password without echoing it and applies `0001`–`0008` in order, recording each file in
   `public._sc_migrations` so a re-run is a no-op. It connects through the Supavisor pooler because the
   direct host `db.<ref>.supabase.co` only publishes an AAAA record and cannot be reached from an
   IPv4-only network. The same files can be pasted into the SQL editor instead; add `-Baseline` if the
   `sc.*` schema was created that way before. Do **not** run `supabase/tests/000_local_auth_stub.sql`;
   it exists only so plain Postgres can execute the migrations locally. **Never re-run 0004**: it renames
   a live function and now that it is recorded, `db-push` skips it — if a ledger ever lost it, record it
   by hand instead of applying it again.
4. Mint the five station links: `powershell -ExecutionPolicy Bypass -File .\scripts\mint-invites.ps1`
   (add `--base https://your-app.vercel.app` if the default origin is wrong). The links are written to
   a file outside the repository; only their SHA-256 is ever stored in the database.
5. Set `.env`: `VITE_BACKEND=supabase`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, then
   `npm run build` and host `dist/` on HTTPS (any static host; the PWA needs a service-worker-capable
   origin). On Vercel, `vercel.json` pins `npm run build` and `dist/`, so the same values only need to
   exist in Project → Settings → Environment Variables before the first deploy. No schema needs to be
   exposed to PostgREST: the browser talks to nine `public` functions (0005–0006) and never to a table.
6. The event session and its single state row are created by the first phone that redeems a link
   (`sc._ensure_event()`), using the column defaults from `0001`; a project that already has an event
   keeps it. Realtime revision hints come from Postgres changes on `sc.state` (added to
   `supabase_realtime` by the migration); clients reconcile by calling `snapshot()`, so a lost hint
   only delays a refresh, it never corrupts state.
7. Keep the `*.txt` invitation file: the links are permanent, and the database stores hashes only, so
   the file is the **only** copy. Treat it like the key cabinet. A lost file means minting new links for
   that station (`--role GATE`), which revokes the old one — never a re-registration by staff.

Server-side rights live in `sc.role_permissions`; clients hold no write grants and cannot execute the
internal `sc` helpers. There is no separate backend service to deploy.

## Verification evidence

Executed locally on Node 22 / Windows, October 2026. Statuses are per requirement §10 of the
hardening brief: only `PASS` means the check was executed and its output supports the result.

| Gate | How it is checked | Status |
| --- | --- | --- |
| R01 zero duplicate committed START/STOP | `test/engine.test.ts` #12/#13, `test/hardening.test.ts` H13, `test/transport.test.ts` G02, SQL 010 §4/§6 | PASS |
| R02 zero simultaneous active rounds | engine CAS + partial unique index `rounds_single_active`, SQL 020 §20, H7 | PASS |
| R03 zero invalid READY transitions | `GATE_FINALIZE` cycle-aware checks: engine tests #8/#8b, H3/H4, SQL 010 §5, 020 §15 | PASS |
| R04 zero unauthorized committed actions | permission table in `machine.ts` + `sc.role_permissions`; unit “gives every role…”, SQL 010 §1, 020 §13a/§15e, 030 §8 | PASS |
| Operator entry: permanent reusable links, one seat per role (SUPERVISOR ×2) | SQL 030 §1–§7, §8w–§8ae (bind, idempotent re-open, refusal, no takeover, full board, live phones untouched) + SQL 031 P1–P13/Q1–Q16 (first join, second phone refused with the official sentence, a second link cannot take over, release, same link reused, three reuse cycles, simultaneous redeem, past expiry ignored, revoked link refused, session revocation, 5/5 capacity, no function but `release_device` retires a binding) + SQL 032 S1–S9/T1–T8 (two supervisors on ONE link, third refused, slots 1/2, catalog constraints, every other station still single, six devices max, board still five stations) | PASS |
| Operators hold no write grants | SQL 030 §10 (table privileges, `anon` cannot redeem, no internal `sc` helper is callable) | PASS |
| R05 no lost acknowledged records | file/JSON persistence + snapshot reconciliation, SQL 010 §8 (history completeness), e2e reload cases | PASS |
| R06 consistent official scores | `test/transport.test.ts` convergence asserts equal `official_duration_ms` on all five clients | PASS |
| R07 authoritative restore after reconnect | `test/clients.test.ts` #15, `test/transport.test.ts` #15b, e2e “Xem thêm”/reload cases | PASS |
| R08 no fabricated success for uncertain requests | `reconcileUnknown` + `/api/operation`: transport G02, hardening H6, clients “network failure…”, e2e G03 | PASS |
| R09 300-second boundary | unit (300 000 win / 300 001 timeout), hardening H2/H8 (before, exactly at, after) | PASS |
| R10 90-minute admission and closure | engine #1/#9/#9b/11b/19d/20, SQL 010 §10–§12, e2e #9 | PASS |
| R11 five-device workflow | Playwright `test/e2e/five-phones.spec.ts` (9 cases, five browser contexts over HTTP+SSE, station links) | PASS |
| R12 real-device rehearsal | needs five physical phones on the event Wi-Fi against a deployed build | **NOT TESTED** — release readiness is not established until this is done |
| Supabase deployment (migrations applied to a live project, anonymous sign-ins on) | needs the project password, the dashboard switch, and five real phones | **NOT TESTED** — SQL is validated against Postgres 16 locally, not against a Supabase host |
| Real background execution / alarm audibility on iOS+Android | outside browser automation | **NOT TESTED** — the UI reports audio readiness and degrades to visual alarms |

Commands and what they produced:

- `npm run typecheck` — clean.
- `npm test` — **88 passing** cases (engine rules and every derived duration, five-client
  reconciliation, offline/lost-response handling, disputes, reopen, layout, concurrency races,
  leaderboard eligibility, wall-display countdown, controlled-clock event replay, invitation-link
  parsing, and the boot path: a forged `localStorage` or `?role=` never becomes a role).
- `npm run test:sql` — migrations 0001–0008 apply to Postgres 16 and **all five** scenarios pass:
  010 (§1–§12), 020 (§13–§20), 030 (bindings, board, privilege boundary), 031 (permanent links:
  reuse after release, exclusive seat, no takeover, no auto-release, catalog-level proof that
  redemption holds neither consumption nor expiry logic) and 032 (SUPERVISOR double staffing on the
  same link, third device refused, other stations still single). 030 is what caught `handle_command`
  resolving the operator row without honouring a released binding; it now goes through a guarded
  wrapper.
- `npm run test:e2e` — **9 passing** browser cases, including a real offline STOP (`context.setOffline`)
  that proves no score is invented, the wall display auto-opening on `BẮT ĐẦU`, 360 px layout checks
  for all five roles, a phone that only sees the invitation gate unless it holds a link, and a
  station that survives reopening without the link.
- `npm run build` — clean PWA build; app bundle 358 kB / **110 kB gzip**, Supabase client split into
  lazy chunks the self-hosted build never loads.
- `npm audit --omit=dev` — 0 vulnerabilities.

**Measured synchronisation (loopback HTTP + SSE, five live clients, one full round = 44 observations)**:
p50 **7–13 ms**, p95 **15–21 ms**, p99 **15–21 ms**, max **21 ms**. Those are single-machine numbers on
an idle network and are *not* an event-Wi-Fi guarantee; the p95 < 500 ms target must be re-measured on
the venue network, and each phone displays its own current RTT and estimated display error in
`Xem thêm → Kết nối & cảnh báo`.

### Known limits, stated plainly

- Timestamp resolution is not physical input accuracy: the recorded STOP is when the server received the
  press, and the gap is stored (`stop_transport_ms`) and disputed when it exceeds the review threshold.
- Network latency means phones can render different digits for tens of milliseconds; only the server's
  stored durations are authoritative.
- Mobile browsers may suspend or freeze background tabs; alarms cannot be guaranteed while the app is
  backgrounded, and a PWA cannot promise continuous execution. On reopening, the app recalibrates and
  restores the live round from the server — the paper backup timer in the runbook is the fallback.
- Zero-millisecond display divergence between devices cannot be guaranteed, and no claim is made here.

Needs your project (cannot be executed here): Anonymous sign-ins enabled, `db-push.ps1` run against the
hosted database, the five links minted with `mint-invites.ps1`, `VITE_BACKEND=supabase` build hosted on
HTTPS, and the real five-device rehearsal on the venue network.
