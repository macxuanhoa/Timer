# SCREAM CONTROL — Room 305 · V2

Single-screen, mobile-first PWA for running a 90-minute Halloween Scream Room event from
five phones. One fixed 90-minute timeline, one flexible 5-minute game window, five synchronised
operators, automatic round-by-round timing, team ranking, audited overrides and one obvious
next action per phone.

```
npm install
npm run dev          # http://localhost:5173  (authoritative engine runs in-process)
```

Then open the app from five devices (or five browser profiles) and sign in with the role for
each station.

## Operator accounts (self-hosted engine)

| Station | Account | Default passcode (`SC_PASSCODE_*`) | Owns |
| --- | --- | --- | --- |
| LOBBY | `lobby` | `3110` | call/dispatch a team — the first call starts the 90:00 |
| GATE · NPC 1 | `gate` | `3110` | **start** and **stop** the 5:00, pause/restart it, final readiness |
| CORRIDOR · NPC 2 | `corridor` | `3110` | hallway progress, hidden objects + hallway reset |
| ROOM 305 · NPC 3 | `room305` | `3110` | arrival, puzzle completion, room reset |
| SUPERVISOR | `supervisor` | `3110` | close event, config, overrides, abort, corrections, CSV |

All five stations share the duty passcode `3110` by default. Passcodes and the token secret come
from the environment (see `.env.example`), so each station can be given its own code; change them
for any real session. The login field keeps the code hidden but has an eye button to show it while
it is typed. Only GATE can finalise readiness, only GATE stops the 5:00 (and only GATE or the
supervisor may pause or restart it), and only SUPERVISOR may override admission or correct a
record — all enforced by the authoritative layer, not just hidden in the UI.

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
   clock by itself. If it is a TV or tablet, sign it in as LOBBY: the display is read-only and
   changes no score, so it is safe to aim at the players.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | App + in-process authoritative engine (HTTP + SSE at `/api/*`), state persisted to `.scream-data/event.json` so a restart restores the live session |
| `npm run build` / `npm run preview` | Production PWA build (service worker, installable, standalone) |
| `npm test` | Vitest: domain rules, engine, five-client reconciliation, real HTTP+SSE transport |
| `npm run test:sql` | Runs `supabase/migrations/*` plus the five-operator scenario against a throwaway Postgres 16 container (Docker required) |
| `npm run test:e2e` | Playwright: five phone profiles, one real round, 360 px layout, cutoff and overtime behaviour |
| `npm run typecheck` | `tsc --noEmit` over app, server, migrations-facing client code and tests |

The browser suite is serial: run the whole file (`npm run test:e2e`) rather than a single case.

## Production deployment (Supabase)

1. Create a Supabase project (Postgres, Auth, Realtime enabled).
2. Apply the migrations: copy `supabase/migrations/0001_init.sql` and `0002_rpc.sql` into
   `supabase/migrations/` of a linked project and run `supabase db push` — or paste them into the
   SQL editor. Do **not** run `supabase/tests/000_local_auth_stub.sql`; it exists only so plain
   Postgres can execute the migrations locally.
3. Create the five operator accounts (Authentication → Users): `lobby`, `gate`, `corridor`,
   `room305`, `supervisor` at your `VITE_OPERATOR_DOMAIN` (for example
   `gate@scream305.local`), each with its own password, then map them:
   ```sql
   insert into sc.operators (user_id, role, display_name)
   select id, 'SUPERVISOR', 'Mai' from auth.users where email = 'supervisor@scream305.local';
   -- repeat for LOBBY, GATE, CORRIDOR, ROOM305
   ```
4. Create one session row before the event (revision starts at 0):
   ```sql
   insert into sc.events (name, duration_ms, game_limit_ms, prep_allowance_ms, reset_target_ms, hidden_object_owner)
   values ('Halloween 305', 5400000, 300000, 90000, 90000, 'CORRIDOR')
   returning *;
   insert into sc.state (id, event_id, revision, updated_at)
   select true, id, 0, sc.now_ms() from sc.events order by id desc limit 1;
   ```
5. Set `.env`: `VITE_BACKEND=supabase`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`,
   `VITE_OPERATOR_DOMAIN`, then `npm run build` and host `dist/` on HTTPS (any static host; the
   PWA needs a service-worker-capable origin).
6. Realtime revision hints come from Postgres changes on `sc.state` (already added to
   `supabase_realtime` by the migration); clients reconcile by calling `sc.snapshot()`, so a lost
   hint only delays a refresh, it never corrupts state.

Server-side rights live in `sc.role_permissions`; clients hold no write grants. There is no
separate backend service to deploy.

## Verification evidence

Executed locally on Node 22 / Windows, October 2026. Statuses are per requirement §10 of the
hardening brief: only `PASS` means the check was executed and its output supports the result.

| Gate | How it is checked | Status |
| --- | --- | --- |
| R01 zero duplicate committed START/STOP | `test/engine.test.ts` #12/#13, `test/hardening.test.ts` H13, `test/transport.test.ts` G02, SQL 010 §4/§6 | PASS |
| R02 zero simultaneous active rounds | engine CAS + partial unique index `rounds_single_active`, SQL 020 §20, H7 | PASS |
| R03 zero invalid READY transitions | `GATE_FINALIZE` cycle-aware checks: engine tests #8/#8b, H3/H4, SQL 010 §5, 020 §15 | PASS |
| R04 zero unauthorized committed actions | permission table in `machine.ts` + `sc.role_permissions`; unit “gives every role…”, SQL 010 §1, 020 §13a/§15e | PASS |
| R05 no lost acknowledged records | file/JSON persistence + snapshot reconciliation, SQL 010 §8 (history completeness), e2e reload cases | PASS |
| R06 consistent official scores | `test/transport.test.ts` convergence asserts equal `official_duration_ms` on all five clients | PASS |
| R07 authoritative restore after reconnect | `test/clients.test.ts` #15, `test/transport.test.ts` #15b, e2e “Xem thêm”/reload cases | PASS |
| R08 no fabricated success for uncertain requests | `reconcileUnknown` + `/api/operation`: transport G02, hardening H6, clients “network failure…”, e2e G03 | PASS |
| R09 300-second boundary | unit (300 000 win / 300 001 timeout), hardening H2/H8 (before, exactly at, after) | PASS |
| R10 90-minute admission and closure | engine #1/#9/#9b/11b/19d/20, SQL 010 §10–§12, e2e #9 | PASS |
| R11 five-device workflow | Playwright `test/e2e/five-phones.spec.ts` (8 cases, five browser contexts over HTTP+SSE) | PASS |
| R12 real-device rehearsal | needs five physical phones on the event Wi-Fi against a deployed build | **NOT TESTED** — release readiness is not established until this is done |
| Supabase deployment (migrations applied to a live project) | needs project URL + anon key + five auth users | **NOT TESTED** — SQL is validated against Postgres 16 locally, not against a Supabase host |
| Real background execution / alarm audibility on iOS+Android | outside browser automation | **NOT TESTED** — the UI reports audio readiness and degrades to visual alarms |

Commands and what they produced:

- `npm run typecheck` — clean.
- `npm test` — **64 passing** cases (engine rules and every derived duration, five-client
  reconciliation, offline/lost-response handling, disputes, reopen, layout, concurrency races,
  leaderboard eligibility, wall-display countdown, controlled-clock event replay).
- `npm run test:sql` — migrations 0001+0002 apply to Postgres 16 and **both** scenarios pass:
  010 (§1–§12) and 020 (§13–§20). This is what caught `operation_status` returning SQL `NULL`
  instead of `found:false`, an inverted override test in `START_GAME`, missing client read grants,
  and a reopened-reset cycle that could never be re-confirmed.
- `npm run test:e2e` — **8 passing** browser cases, including a real offline STOP (`context.setOffline`)
  that proves no score is invented, the wall display auto-opening on `BẮT ĐẦU`, and 360 px layout
  checks for all five roles.
- `npm run build` — clean PWA build; app bundle 332 kB / **103 kB gzip**, Supabase client split into
  a lazy chunk the self-hosted build never loads.
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

Needs your project (cannot be executed here): Supabase URL + anon key, the five auth users mapped into
`sc.operators`, `supabase db push`, then `VITE_BACKEND=supabase npm run build` hosted on HTTPS, and the
real five-device rehearsal on the venue network.
