-- SCREAM CONTROL — Room 305 · V2 · the only browser-facing surface
--
-- PostgREST resolves unqualified calls in an exposed schema. Rather than adding
-- `sc` to the exposed schema list (which would also publish every table), the
-- eight callable entry points are wrapped in `public`. Each wrapper is SECURITY
-- DEFINER and delegates straight to the sc implementation, which does its own
-- role check — so the wrappers add no authority of their own.
--
-- `sc` therefore stays unexposed: no table, no view and no internal helper is
-- reachable from a browser, only these functions.

create or replace function public.snapshot() returns jsonb
language sql security definer set search_path = '' as
$$ select sc.snapshot() $$;

create or replace function public.server_now_ms() returns bigint
language sql security definer set search_path = '' as
$$ select sc.server_now_ms() $$;

create or replace function public.state_revision() returns jsonb
language sql security definer set search_path = '' as
$$ select sc.state_revision() $$;

create or replace function public.operation_status(p_idempotency_key text) returns jsonb
language sql security definer set search_path = '' as
$$ select sc.operation_status(p_idempotency_key) $$;

-- No parameter defaults here: PostgREST must never have to choose between
-- overloads, so the client always sends all four arguments by name.
create or replace function public.handle_command(
  p_action text, p_meta jsonb, p_expected_revision bigint, p_idempotency_key text
) returns jsonb
language sql security definer set search_path = '' as
$$ select sc.handle_command(p_action, coalesce(p_meta, '{}'::jsonb), p_expected_revision, p_idempotency_key) $$;

create or replace function public.redeem_invitation(p_token text, p_device_id text) returns jsonb
language sql security definer set search_path = '' as
$$ select sc.redeem_invitation(p_token, p_device_id) $$;

create or replace function public.release_device() returns jsonb
language sql security definer set search_path = '' as
$$ select sc.release_device() $$;

create or replace function public.whoami() returns jsonb
language sql security definer set search_path = '' as
$$ select sc.whoami() $$;

-- Anonymous (not yet bound) phones may only redeem; everything else needs a
-- live operator binding, which the sc functions check again on their own.
revoke all on function public.snapshot() from public;
revoke all on function public.server_now_ms() from public;
revoke all on function public.state_revision() from public;
revoke all on function public.operation_status(text) from public;
revoke all on function public.handle_command(text, jsonb, bigint, text) from public;
revoke all on function public.redeem_invitation(text, text) from public;
revoke all on function public.release_device() from public;
revoke all on function public.whoami() from public;

grant execute on function public.snapshot()                              to authenticated;
grant execute on function public.server_now_ms()                         to authenticated;
grant execute on function public.state_revision()                        to authenticated;
grant execute on function public.operation_status(text)                  to authenticated;
grant execute on function public.handle_command(text, jsonb, bigint, text) to authenticated;
grant execute on function public.redeem_invitation(text, text)           to authenticated;
grant execute on function public.release_device()                        to authenticated;
grant execute on function public.whoami()                                to authenticated;
