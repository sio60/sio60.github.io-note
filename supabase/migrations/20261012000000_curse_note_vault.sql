-- CURSE NOTE only. No Auth configuration, extensions, or other app objects change.
begin;

create schema if not exists curse_note_private;
revoke all on schema curse_note_private from public, anon, authenticated, service_role;

create table if not exists curse_note_private.vaults (
  code_hash bytea primary key check (pg_catalog.octet_length(code_hash) = 32),
  records jsonb not null default '[]'::jsonb
    check (pg_catalog.jsonb_typeof(records) = 'array')
    check (pg_catalog.jsonb_array_length(records) <= 500)
    check (pg_catalog.octet_length(pg_catalog.convert_to(records::text, 'UTF8')) <= 1048576),
  revision bigint not null default 1 check (revision between 1 and 9007199254740991),
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now()
);
alter table curse_note_private.vaults enable row level security;
revoke all on table curse_note_private.vaults from public, anon, authenticated, service_role;
-- Intentionally no RLS policies: only the narrowly scoped definer RPCs access rows.

create or replace function curse_note_private.valid_timestamp(p_value text)
returns boolean language plpgsql immutable security invoker set search_path = ''
as $$
begin
  if p_value is null or pg_catalog.length(p_value) <> 24
     or p_value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9][.][0-9]{3}Z$' then
    return false;
  end if;
  perform p_value::pg_catalog.timestamptz;
  return true;
exception when invalid_datetime_format or datetime_field_overflow then
  return false;
end;
$$;

create or replace function curse_note_private.valid_records(p_records jsonb)
returns boolean language plpgsql immutable security invoker set search_path = ''
as $$
declare
  item jsonb;
  ritual jsonb;
  field text;
  seen_ids text[] := array[]::text[];
begin
  if p_records is null or pg_catalog.jsonb_typeof(p_records) <> 'array' then return false; end if;
  if pg_catalog.jsonb_array_length(p_records) > 500
     or pg_catalog.octet_length(pg_catalog.convert_to(p_records::text, 'UTF8')) > 1048576 then return false; end if;

  for item in select value from pg_catalog.jsonb_array_elements(p_records) loop
    if pg_catalog.jsonb_typeof(item) <> 'object'
       or pg_catalog.jsonb_typeof(item->'id') is distinct from 'string'
       or (item->>'id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or item->>'id' = any(seen_ids)
       or pg_catalog.jsonb_typeof(item->'updatedAt') is distinct from 'string'
       or not curse_note_private.valid_timestamp(item->>'updatedAt') then return false; end if;
    seen_ids := pg_catalog.array_append(seen_ids, item->>'id');

    if item ? 'deleted' then
      if item->'deleted' <> 'true'::jsonb then return false; end if;
      if exists (select 1 from pg_catalog.jsonb_object_keys(item) as k(key)
                 where key <> all(array['id','deleted','updatedAt'])) then return false; end if;
      continue;
    end if;

    if exists (select 1 from pg_catalog.jsonb_object_keys(item) as k(key)
               where key <> all(array['id','name','body','date','createdAt','updatedAt','curse'])) then return false; end if;
    if pg_catalog.jsonb_typeof(item->'name') is distinct from 'string'
       or pg_catalog.length(item->>'name') not between 1 and 60
       or pg_catalog.jsonb_typeof(item->'body') is distinct from 'string'
       or pg_catalog.length(item->>'body') > 20000
       or pg_catalog.jsonb_typeof(item->'date') is distinct from 'string'
       or (item->>'date') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
       or pg_catalog.jsonb_typeof(item->'createdAt') is distinct from 'string'
       or not curse_note_private.valid_timestamp(item->>'createdAt') then return false; end if;
    perform (item->>'date')::pg_catalog.date;

    ritual := item->'curse';
    if ritual is null or ritual = 'null'::jsonb then continue; end if;
    if pg_catalog.jsonb_typeof(ritual) <> 'object' then return false; end if;
    if exists (select 1 from pg_catalog.jsonb_object_keys(ritual) as k(key)
               where key <> all(array['status','startedAt','deadline','revokedAt'])) then return false; end if;
    if pg_catalog.jsonb_typeof(ritual->'status') is distinct from 'string'
       or ritual->>'status' <> all(array['pending','fulfilled','revoked'])
       or not (ritual ? 'startedAt' and ritual ? 'deadline') then return false; end if;
    foreach field in array array['startedAt','deadline','revokedAt'] loop
      if ritual ? field then
        if pg_catalog.jsonb_typeof(ritual->field) <> 'number' then return false; end if;
        if (ritual->>field)::numeric not between 0 and 253402300799999
           or (ritual->>field)::numeric <> pg_catalog.trunc((ritual->>field)::numeric) then return false; end if;
      end if;
    end loop;
    if (ritual->>'deadline')::numeric < (ritual->>'startedAt')::numeric then return false; end if;
  end loop;
  return true;
exception when invalid_datetime_format or datetime_field_overflow then
  return false;
end;
$$;

create or replace function curse_note_private.hash_code(p_code text)
returns bytea language plpgsql immutable security invoker set search_path = ''
as $$
begin
  if p_code is null or pg_catalog.length(p_code) <> 47 or p_code !~ '^cn1_[A-Za-z0-9_-]{43}$' then
    raise exception using errcode = '22023', message = 'Invalid recovery code';
  end if;
  return pg_catalog.sha256(pg_catalog.convert_to(p_code, 'UTF8'));
end;
$$;

create or replace function public.curse_note_read(p_code text)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare
  vault curse_note_private.vaults%rowtype;
  requested_hash bytea := curse_note_private.hash_code(p_code);
begin
  select * into vault from curse_note_private.vaults where code_hash = requested_hash;
  if not found then
    return pg_catalog.jsonb_build_object('status','missing','revision',0,'records','[]'::jsonb);
  end if;
  return pg_catalog.jsonb_build_object('status','ok','revision',vault.revision,'records',vault.records);
end;
$$;

create or replace function public.curse_note_write(p_code text, p_revision bigint, p_records jsonb)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
declare
  vault curse_note_private.vaults%rowtype;
  requested_hash bytea := curse_note_private.hash_code(p_code);
begin
  if p_revision is null or p_revision not between 0 and 9007199254740990 then
    raise exception using errcode = '22023', message = 'Invalid revision';
  end if;
  if not curse_note_private.valid_records(p_records) then
    raise exception using errcode = '22023', message = 'Invalid records';
  end if;

  if p_revision = 0 then
    insert into curse_note_private.vaults (code_hash, records)
    values (requested_hash, p_records)
    on conflict (code_hash) do nothing
    returning * into vault;
    if found then
      return pg_catalog.jsonb_build_object('status','ok','revision',vault.revision,'records',vault.records);
    end if;
  else
    -- The row lock and revision predicate make this compare-and-swap atomic.
    update curse_note_private.vaults
    set records = p_records, revision = revision + 1, updated_at = pg_catalog.clock_timestamp()
    where code_hash = requested_hash and revision = p_revision
    returning * into vault;
    if found then
      return pg_catalog.jsonb_build_object('status','ok','revision',vault.revision,'records',vault.records);
    end if;
  end if;

  select * into vault from curse_note_private.vaults where code_hash = requested_hash;
  if not found then
    return pg_catalog.jsonb_build_object('status','conflict','revision',0,'records','[]'::jsonb);
  end if;
  return pg_catalog.jsonb_build_object('status','conflict','revision',vault.revision,'records',vault.records);
end;
$$;

revoke all on function curse_note_private.valid_timestamp(text) from public, anon, authenticated, service_role;
revoke all on function curse_note_private.valid_records(jsonb) from public, anon, authenticated, service_role;
revoke all on function curse_note_private.hash_code(text) from public, anon, authenticated, service_role;
revoke all on function public.curse_note_read(text) from public, anon, authenticated, service_role;
revoke all on function public.curse_note_write(text,bigint,jsonb) from public, anon, authenticated, service_role;
grant execute on function public.curse_note_read(text) to anon, authenticated;
grant execute on function public.curse_note_write(text,bigint,jsonb) to anon, authenticated;

comment on table curse_note_private.vaults is 'CURSE NOTE capability vault. Recovery codes are SHA-256 hashed; note contents are not end-to-end encrypted.';
comment on function public.curse_note_read(text) is 'Read only the vault identified by a high-entropy recovery code. No account required.';
comment on function public.curse_note_write(text,bigint,jsonb) is 'Replace only the matching vault at the expected revision. Zero creates a vault; stale revisions return a conflict snapshot.';

commit;
