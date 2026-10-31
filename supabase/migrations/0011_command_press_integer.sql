-- 0011: a press instant that arrives from a browser is fractional.
--
-- The calibrated client clock is derived from performance.now(), so a phone sends
-- epoch milliseconds such as 1793445867821.25. `(p_meta#>>'{_press,press_ms}')::bigint`
-- rejects that text with 22P02, and because the cast runs inside handle_command the
-- whole transaction rolls back: nothing reaches the audit log, START / STOP /
-- PUZZLE_COMPLETE never commit, and the phone truthfully keeps answering
-- "CHƯA ĐƯỢC GHI NHẬN — nhấn lại để thử" while every retry fails identically.
--
-- The press instant is transport diagnostics only — it is never scored and never
-- decides a transition — so it must not be able to block the command it merely
-- annotates. It is truncated to whole milliseconds here, and dropped when it
-- cannot be read at all. Clients send whole numbers from this release on; this
-- normalisation keeps an already-installed PWA working through the same window.
create or replace function sc.handle_command(
  p_action text,
  p_meta jsonb default '{}'::jsonb,
  p_expected_revision bigint default 0,
  p_idempotency_key text default ''
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_meta  jsonb := coalesce(p_meta, '{}'::jsonb);
  v_press bigint;
begin
  -- Unchanged from 0010: claims, releases and commands share this lock, and a
  -- released seat fails closed before any workflow runs.
  perform pg_advisory_xact_lock(30501);
  if sc.my_role() is null then
    return sc._result(false, 'PERMISSION_DENIED', 'VỊ TRÍ ĐÃ ĐƯỢC THU HỒI', 0, sc.now_ms());
  end if;
  if jsonb_typeof(v_meta->'_press') = 'object' then
    begin
      v_press := trunc((v_meta#>>'{_press,press_ms}')::numeric)::bigint;
    exception when data_exception then
      v_press := null;  -- unreadable diagnostics are discarded, never fatal
    end;
    v_meta := case when v_press is null
      then jsonb_set(v_meta, '{_press}', (v_meta->'_press') - 'press_ms', true)
      else jsonb_set(v_meta, '{_press,press_ms}', to_jsonb(v_press), true) end;
  end if;
  return sc._handle_command_internal(p_action, v_meta, p_expected_revision, p_idempotency_key);
end $$;
