-- LOCAL SQL VALIDATION HARNESS ONLY — never run this against a Supabase project.
-- It stands in for the parts of the Supabase platform that plain Postgres lacks
-- (auth schema, jwt claims, roles, realtime publication) so that migrations
-- 0001/0002 can be executed and exercised by `npm run test:sql`.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
end $$;

create schema if not exists auth;

create table if not exists auth.users (
  id uuid primary key,
  email text unique,
  created_at timestamptz not null default now()
);

-- Supabase exposes the JWT subject through this GUC.
create or replace function auth.uid() returns uuid
language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

-- ...and the decoded claims, where anonymous sessions carry is_anonymous = true.
create or replace function auth.jwt() returns jsonb
language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb)
$$;

grant usage on schema auth to authenticated, anon;
grant select on auth.users to authenticated;

do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end $$;
