-- Isolated regression scenario. All fixtures roll back.
reset role;
begin;
update sc.operators set revoked_at = now() where revoked_at is null;
delete from sc.access_rate_limits;
insert into auth.users(id) values
 ('66666666-0000-4000-8000-000000000001'),
 ('66666666-0000-4000-8000-000000000002'),
 ('66666666-0000-4000-8000-000000000003'),
 ('66666666-0000-4000-8000-000000000004') on conflict do nothing;
-- Even an old allow-listed device must type the code after releasing its role.
insert into sc.admin_devices(user_id, note) values ('66666666-0000-4000-8000-000000000001','PIN test') on conflict do nothing;
create temp table pin_state_before as select * from sc.state;
set local role authenticated;
do $$
declare v jsonb; i int;
begin
 perform set_config('request.jwt.claim.sub', '', true);
 perform set_config('request.jwt.claims', '{"sub":"66666666-0000-4000-8000-000000000001","is_anonymous":true}', true);
 v := public.claim_station('SUPERVISOR');
 if v->>'code' <> 'PIN_REQUIRED' then raise exception 'PIN required: %', v; end if;
 v := public.claim_station('SUPERVISOR', '000000');
 if v->>'code' <> 'PIN_INVALID' then raise exception 'Wrong PIN: %', v; end if;
 v := public.station_admin();
 if (v->>'ok')::boolean then raise exception 'Guest received admin report'; end if;
 v := public.claim_station('SUPERVISOR', '211105');
 if not (v->>'ok')::boolean or v->>'role' <> 'SUPERVISOR' then raise exception 'PIN grant: %', v; end if;
 v := public.station_admin();
 if not (v->>'ok')::boolean then raise exception 'New admin cannot act: %', v; end if;
 v := public.claim_station('SUPERVISOR', '211105');
 if v->>'code' <> 'ALREADY_BOUND' then raise exception 'Refresh took another seat: %', v; end if;
 perform set_config('request.jwt.claims', '{"sub":"66666666-0000-4000-8000-000000000002","is_anonymous":true}', true);
 v := public.claim_station('SUPERVISOR', '211105');
 if not (v->>'ok')::boolean then raise exception 'Second admin: %', v; end if;
 perform set_config('request.jwt.claims', '{"sub":"66666666-0000-4000-8000-000000000003","is_anonymous":true}', true);
 v := public.claim_station('SUPERVISOR', '211105');
 if v->>'code' <> 'ROLE_TAKEN' then raise exception 'Admin capacity: %', v; end if;
 perform set_config('request.jwt.claims', '{"sub":"66666666-0000-4000-8000-000000000004","is_anonymous":true}', true);
 v := public.claim_station('LOBBY');
 if not (v->>'ok')::boolean then raise exception 'Open duty seat: %', v; end if;
 v := public.claim_station('SUPERVISOR', '211105');
 if v->>'code' <> 'ALREADY_BOUND_OTHER_ROLE' then raise exception 'Role replaced in place: %', v; end if;
 perform set_config('request.jwt.claims', '{"sub":"66666666-0000-4000-8000-000000000001","is_anonymous":true}', true);
 v := public.release_device();
 if not (v->>'ok')::boolean then raise exception 'Release failed: %', v; end if;
 v := public.station_admin();
 if (v->>'ok')::boolean then raise exception 'Released admin retained power'; end if;
 v := public.claim_station('SUPERVISOR');
 if v->>'code' <> 'PIN_REQUIRED' then raise exception 'Release bypassed PIN: %', v; end if;
 for i in 1..5 loop
   v := public.claim_station('SUPERVISOR', '000000');
   if v->>'code' <> 'PIN_INVALID' then raise exception 'Failure count %: %', i, v; end if;
 end loop;
 v := public.claim_station('SUPERVISOR', '211105');
 if v->>'code' <> 'PIN_RATE_LIMITED' then raise exception 'Missing rate limit: %', v; end if;
end $$;
reset role;
do $$ begin
 if exists (select * from sc.state except select * from pin_state_before) then raise exception 'PIN changed event state'; end if;
 if exists (select 1 from sc.access_audit where metadata::text like '%211105%') then raise exception 'PIN leaked to audit'; end if;
 if has_table_privilege('authenticated', 'sc.access_rate_limits', 'SELECT') then raise exception 'Limiter leaked'; end if;
end $$;
rollback;
