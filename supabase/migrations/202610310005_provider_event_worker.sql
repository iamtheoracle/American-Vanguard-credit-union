-- AVCU provider webhook inbox reliability controls.
-- This stores and schedules events; cryptographic signature verification remains
-- the responsibility of the provider-specific server adapter before verification is recorded.

alter table public.avcu_provider_events
  add column if not exists payload_sha256 text,
  add column if not exists signature_verified_at timestamptz,
  add column if not exists verification_reference text,
  add column if not exists attempt_count integer not null default 0 check (attempt_count >= 0),
  add column if not exists next_attempt_at timestamptz not null default now(),
  add column if not exists lease_token uuid,
  add column if not exists lease_expires_at timestamptz,
  add column if not exists last_error_code text,
  add column if not exists updated_at timestamptz not null default now();

-- Backfill deterministic hashes for pre-existing inbox rows. Legacy rows marked
-- verified without a verification timestamp are quarantined rather than trusted.
update public.avcu_provider_events
set payload_sha256 = encode(digest(payload::text,'sha256'),'hex')
where payload_sha256 is null;

update public.avcu_provider_events
set signature_verified = false,
    processing_status = 'quarantined',
    last_error_code = 'legacy_verification_unproven',
    updated_at = now()
where signature_verified = true
  and signature_verified_at is null;

update public.avcu_provider_events
set processing_status = 'retry',
    next_attempt_at = now(),
    lease_token = null,
    lease_expires_at = null,
    updated_at = now()
where processing_status = 'processing'
  and lease_expires_at is null;

create index if not exists avcu_provider_events_claim_idx
  on public.avcu_provider_events(processing_status,next_attempt_at,received_at)
  where signature_verified = true;

create table if not exists public.avcu_provider_event_conflicts (
  id uuid primary key default gen_random_uuid(),
  provider_code text not null,
  provider_event_id text not null,
  existing_payload_sha256 text,
  incoming_payload_sha256 text not null,
  detected_at timestamptz not null default now()
);
alter table public.avcu_provider_event_conflicts enable row level security;
revoke all on public.avcu_provider_event_conflicts from public, anon, authenticated, service_role;

create or replace function public.avcu_ingest_provider_event(
  p_provider_code text,
  p_provider_event_id text,
  p_event_type text,
  p_payload jsonb
) returns public.avcu_provider_events
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_event public.avcu_provider_events;
  v_hash text;
  v_inserted integer;
begin
  if p_provider_code is null or length(trim(p_provider_code)) = 0
     or p_provider_event_id is null or length(trim(p_provider_event_id)) = 0
     or p_event_type is null or length(trim(p_event_type)) = 0
     or p_payload is null or jsonb_typeof(p_payload) is distinct from 'object' then
    raise exception 'Provider event fields are invalid' using errcode = '22023';
  end if;

  v_hash := encode(digest(p_payload::text,'sha256'),'hex');

  insert into public.avcu_provider_events(
    provider_code,provider_event_id,event_type,payload,signature_verified,
    processing_status,payload_sha256,next_attempt_at
  ) values (
    trim(p_provider_code),trim(p_provider_event_id),trim(p_event_type),p_payload,false,
    'received',v_hash,now()
  )
  on conflict (provider_code,provider_event_id) do nothing;

  get diagnostics v_inserted = row_count;

  select * into v_event
  from public.avcu_provider_events
  where provider_code = trim(p_provider_code)
    and provider_event_id = trim(p_provider_event_id)
  for update;

  if v_inserted = 0 and v_event.payload_sha256 is distinct from v_hash then
    insert into public.avcu_provider_event_conflicts(
      provider_code,provider_event_id,existing_payload_sha256,incoming_payload_sha256
    ) values (
      trim(p_provider_code),trim(p_provider_event_id),v_event.payload_sha256,v_hash
    );
    raise exception 'Provider event ID was replayed with a different payload'
      using errcode = '23505';
  end if;

  return v_event;
end;
$$;

-- Call only after the adapter has validated the provider's signature using its
-- documented algorithm, timestamp tolerance, key rotation and raw request bytes.
create or replace function public.avcu_mark_provider_event_verified(
  p_event_id uuid,
  p_verification_reference text
) returns public.avcu_provider_events
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_event public.avcu_provider_events;
begin
  if p_verification_reference is null or length(trim(p_verification_reference)) < 3 then
    raise exception 'Verification reference is required' using errcode = '22023';
  end if;

  update public.avcu_provider_events
  set signature_verified = true,
      signature_verified_at = now(),
      verification_reference = trim(p_verification_reference),
      updated_at = now()
  where id = p_event_id
    and signature_verified = false
    and processing_status = 'received'
  returning * into v_event;

  if not found then
    raise exception 'Event is missing, already verified, or no longer eligible' using errcode = '55000';
  end if;
  return v_event;
end;
$$;

create or replace function public.avcu_claim_provider_event(
  p_worker_id text,
  p_lease_seconds integer default 60
) returns public.avcu_provider_events
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_event public.avcu_provider_events;
begin
  if p_worker_id is null or length(trim(p_worker_id)) < 3
     or p_lease_seconds is null or p_lease_seconds < 10 or p_lease_seconds > 300 then
    raise exception 'Worker ID or lease duration is invalid' using errcode = '22023';
  end if;

  select * into v_event
  from public.avcu_provider_events
  where signature_verified = true
    and next_attempt_at <= now()
    and attempt_count < 10
    and (
      processing_status in ('received','retry')
      or (processing_status = 'processing' and lease_expires_at < now())
    )
  order by received_at
  for update skip locked
  limit 1;

  if not found then
    return null;
  end if;

  update public.avcu_provider_events
  set processing_status = 'processing',
      attempt_count = attempt_count + 1,
      lease_token = gen_random_uuid(),
      lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      updated_at = now()
  where id = v_event.id
  returning * into v_event;

  return v_event;
end;
$$;

create or replace function public.avcu_complete_provider_event(
  p_event_id uuid,
  p_lease_token uuid
) returns public.avcu_provider_events
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_event public.avcu_provider_events;
begin
  update public.avcu_provider_events
  set processing_status = 'processed',
      processed_at = now(),
      lease_token = null,
      lease_expires_at = null,
      last_error_code = null,
      updated_at = now()
  where id = p_event_id
    and processing_status = 'processing'
    and lease_token = p_lease_token
    and lease_expires_at > now()
    and signature_verified = true
  returning * into v_event;

  if not found then
    raise exception 'Event lease is invalid or expired' using errcode = '55000';
  end if;
  return v_event;
end;
$$;

create or replace function public.avcu_retry_provider_event(
  p_event_id uuid,
  p_lease_token uuid,
  p_error_code text,
  p_retry_after_seconds integer
) returns public.avcu_provider_events
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_event public.avcu_provider_events;
begin
  if p_error_code is null or length(trim(p_error_code)) = 0
     or p_retry_after_seconds is null or p_retry_after_seconds < 5 or p_retry_after_seconds > 86400 then
    raise exception 'Retry details are invalid' using errcode = '22023';
  end if;

  update public.avcu_provider_events
  set processing_status = case when attempt_count >= 10 then 'quarantined' else 'retry' end,
      next_attempt_at = now() + make_interval(secs => p_retry_after_seconds),
      last_error_code = left(trim(p_error_code),100),
      lease_token = null,
      lease_expires_at = null,
      updated_at = now()
  where id = p_event_id
    and processing_status = 'processing'
    and lease_token = p_lease_token
    and lease_expires_at > now()
  returning * into v_event;

  if not found then
    raise exception 'Event lease is invalid or expired' using errcode = '55000';
  end if;
  return v_event;
end;
$$;

create or replace function public.avcu_quarantine_provider_event(
  p_event_id uuid,
  p_lease_token uuid,
  p_error_code text
) returns public.avcu_provider_events
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_event public.avcu_provider_events;
begin
  if p_error_code is null or length(trim(p_error_code)) = 0 then
    raise exception 'Quarantine reason is required' using errcode = '22023';
  end if;

  update public.avcu_provider_events
  set processing_status = 'quarantined',
      last_error_code = left(trim(p_error_code),100),
      lease_token = null,
      lease_expires_at = null,
      updated_at = now()
  where id = p_event_id
    and processing_status = 'processing'
    and lease_token = p_lease_token
    and lease_expires_at > now()
  returning * into v_event;

  if not found then
    raise exception 'Event lease is invalid or expired' using errcode = '55000';
  end if;
  return v_event;
end;
$$;

revoke insert, update, delete on public.avcu_provider_events from service_role;
grant select on public.avcu_provider_events to service_role;

revoke all on function public.avcu_ingest_provider_event(text,text,text,jsonb) from public, anon, authenticated, service_role;
revoke all on function public.avcu_mark_provider_event_verified(uuid,text) from public, anon, authenticated, service_role;
revoke all on function public.avcu_claim_provider_event(text,integer) from public, anon, authenticated, service_role;
revoke all on function public.avcu_complete_provider_event(uuid,uuid) from public, anon, authenticated, service_role;
revoke all on function public.avcu_retry_provider_event(uuid,uuid,text,integer) from public, anon, authenticated, service_role;
revoke all on function public.avcu_quarantine_provider_event(uuid,uuid,text) from public, anon, authenticated, service_role;

grant execute on function public.avcu_ingest_provider_event(text,text,text,jsonb) to service_role;
grant execute on function public.avcu_mark_provider_event_verified(uuid,text) to service_role;
grant execute on function public.avcu_claim_provider_event(text,integer) to service_role;
grant execute on function public.avcu_complete_provider_event(uuid,uuid) to service_role;
grant execute on function public.avcu_retry_provider_event(uuid,uuid,text,integer) to service_role;
grant execute on function public.avcu_quarantine_provider_event(uuid,uuid,text) to service_role;
