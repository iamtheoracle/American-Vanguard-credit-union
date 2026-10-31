-- AVCU controlled ledger posting and reversal safeguards.
-- Posting is atomic, serialized by transaction row lock, and balanced per currency.
-- No payment rail or provider call is performed by these functions.

create table if not exists public.avcu_ledger_audit_events (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references public.avcu_ledger_transactions(id) on delete restrict,
  event_type text not null check (event_type in ('posted','reversed')),
  actor_role text not null,
  reason text,
  occurred_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

alter table public.avcu_ledger_audit_events enable row level security;
revoke all on public.avcu_ledger_audit_events from public, anon, authenticated, service_role;

create index if not exists avcu_ledger_audit_events_transaction_idx
  on public.avcu_ledger_audit_events(transaction_id, occurred_at desc);

-- Reject journal lines whose currency differs from their ledger account, and
-- prevent changes to journal lines after their parent transaction is posted.
create or replace function public.avcu_guard_ledger_entry_write()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_status public.avcu_transaction_status;
  v_account_currency char(3);
  v_transaction_id uuid;
begin
  v_transaction_id := case when tg_op = 'DELETE' then old.transaction_id else new.transaction_id end;

  select status into v_status
  from public.avcu_ledger_transactions
  where id = v_transaction_id
  for update;

  if not found then
    raise exception 'Ledger transaction does not exist' using errcode = '23503';
  end if;

  if v_status <> 'draft' then
    raise exception 'Journal entries can only be changed while transaction is draft' using errcode = '55000';
  end if;

  if tg_op <> 'DELETE' then
    select currency_code into v_account_currency
    from public.avcu_ledger_accounts
    where id = new.ledger_account_id;

    if not found then
      raise exception 'Ledger account does not exist' using errcode = '23503';
    end if;

    if new.currency_code <> v_account_currency then
      raise exception 'Journal entry currency must match ledger account currency' using errcode = '23514';
    end if;

    if tg_op = 'UPDATE' and new.transaction_id <> old.transaction_id then
      raise exception 'Moving a journal line between transactions is prohibited' using errcode = '55000';
    end if;

    return new;
  end if;

  return old;
end;
$$;

drop trigger if exists avcu_ledger_entry_write_guard on public.avcu_ledger_entries;
create trigger avcu_ledger_entry_write_guard
before insert or update or delete on public.avcu_ledger_entries
for each row execute function public.avcu_guard_ledger_entry_write();

-- Keep transaction identity and posted history stable. Only the controlled
-- reversal routine may mark a posted transaction as reversed.
create or replace function public.avcu_guard_ledger_transaction_update()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_operation text := current_setting('avcu.ledger_operation', true);
begin
  if tg_op = 'INSERT' then
    if new.status <> 'draft' or new.posted_at is not null or new.reversed_by is not null then
      raise exception 'Ledger transactions must be created as drafts' using errcode = '55000';
    end if;
    return new;
  end if;

  if old.status = 'draft' and new.status = 'posted' then
    if v_operation is distinct from 'post'
       or new.id is distinct from old.id
       or new.idempotency_key is distinct from old.idempotency_key
       or new.transaction_type is distinct from old.transaction_type
       or new.description is distinct from old.description
       or new.external_reference is distinct from old.external_reference
       or new.effective_at is distinct from old.effective_at
       or new.metadata is distinct from old.metadata
       or new.created_at is distinct from old.created_at
       or new.reversed_by is distinct from old.reversed_by then
      raise exception 'Draft transactions can only be posted through the controlled posting function' using errcode = '55000';
    end if;
    return new;
  end if;

  if old.status = 'posted' and new.status = 'reversed' then
    if v_operation is distinct from 'reverse'
       or new.id is distinct from old.id
       or new.idempotency_key is distinct from old.idempotency_key
       or new.transaction_type is distinct from old.transaction_type
       or new.description is distinct from old.description
       or new.external_reference is distinct from old.external_reference
       or new.effective_at is distinct from old.effective_at
       or new.metadata is distinct from old.metadata
       or new.created_at is distinct from old.created_at
       or new.posted_at is distinct from old.posted_at
       or new.reversed_by is null then
      raise exception 'Posted transaction history is immutable; use a controlled compensating reversal' using errcode = '55000';
    end if;
    return new;
  end if;

  raise exception 'Invalid or prohibited ledger transaction state transition' using errcode = '55000';
end;
$$;

drop trigger if exists avcu_ledger_transaction_update_guard on public.avcu_ledger_transactions;
create trigger avcu_ledger_transaction_update_guard
before insert or update on public.avcu_ledger_transactions
for each row execute function public.avcu_guard_ledger_transaction_update();

-- Store a canonical request fingerprint so a reused idempotency key cannot
-- silently refer to a different journal request.
alter table public.avcu_ledger_transactions
  add column if not exists request_fingerprint text;

create or replace function public.avcu_create_draft_ledger_transaction(
  p_idempotency_key text,
  p_transaction_type text,
  p_description text,
  p_external_reference text,
  p_effective_at timestamptz,
  p_metadata jsonb,
  p_entries jsonb
) returns public.avcu_ledger_transactions
language plpgsql
security definer
set search_path = public, pg_temp
as $
declare
  v_tx public.avcu_ledger_transactions;
  v_fingerprint text;
  v_inserted integer;
  v_count integer;
  v_entry jsonb;
begin
  if p_idempotency_key is null or length(trim(p_idempotency_key)) < 8 or length(p_idempotency_key) > 200 then
    raise exception 'Idempotency key must be between 8 and 200 characters' using errcode = '22023';
  end if;
  if p_transaction_type is null or length(trim(p_transaction_type)) = 0 then
    raise exception 'Transaction type is required' using errcode = '22023';
  end if;
  if p_entries is null or jsonb_typeof(p_entries) is distinct from 'array' then
    raise exception 'Journal entries must be supplied as a JSON array' using errcode = '22023';
  end if;

  v_count := jsonb_array_length(p_entries);
  if v_count < 2 or v_count > 500 then
    raise exception 'A draft journal must contain between 2 and 500 entries' using errcode = '22023';
  end if;

  for v_entry in select value from jsonb_array_elements(p_entries)
  loop
    if jsonb_typeof(v_entry) is distinct from 'object'
       or not (v_entry ? 'ledger_account_id')
       or not (v_entry ? 'currency_code')
       or not (v_entry ? 'debit_amount')
       or not (v_entry ? 'credit_amount') then
      raise exception 'Each journal entry requires account, currency, debit and credit fields' using errcode = '22023';
    end if;
  end loop;

  v_fingerprint := encode(digest(jsonb_build_object(
    'transaction_type',trim(p_transaction_type),
    'description',p_description,
    'external_reference',p_external_reference,
    'effective_at',p_effective_at,
    'metadata',coalesce(p_metadata,'{}'::jsonb),
    'entries',p_entries
  )::text,'sha256'),'hex');

  insert into public.avcu_ledger_transactions(
    idempotency_key,transaction_type,description,external_reference,
    effective_at,metadata,request_fingerprint
  ) values (
    trim(p_idempotency_key),trim(p_transaction_type),p_description,p_external_reference,
    p_effective_at,coalesce(p_metadata,'{}'::jsonb),v_fingerprint
  )
  on conflict (idempotency_key) do nothing;

  get diagnostics v_inserted = row_count;

  select * into v_tx
  from public.avcu_ledger_transactions
  where idempotency_key = trim(p_idempotency_key)
  for update;

  if v_inserted = 0 then
    if v_tx.request_fingerprint is distinct from v_fingerprint then
      raise exception 'Idempotency key was already used for a different journal request'
        using errcode = '23505';
    end if;
    return v_tx;
  end if;

  for v_entry in select value from jsonb_array_elements(p_entries)
  loop
    insert into public.avcu_ledger_entries(
      transaction_id,ledger_account_id,currency_code,debit_amount,credit_amount
    ) values (
      v_tx.id,
      (v_entry->>'ledger_account_id')::uuid,
      upper(v_entry->>'currency_code'),
      (v_entry->>'debit_amount')::numeric,
      (v_entry->>'credit_amount')::numeric
    );
  end loop;

  return v_tx;
end;
$;

create or replace function public.avcu_post_ledger_transaction(p_transaction_id uuid)
returns public.avcu_ledger_transactions
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tx public.avcu_ledger_transactions;
  v_line_count integer;
  v_currency_count integer;
  v_unbalanced_count integer;
begin
  select * into v_tx
  from public.avcu_ledger_transactions
  where id = p_transaction_id
  for update;

  if not found then
    raise exception 'Ledger transaction not found' using errcode = 'P0002';
  end if;

  if v_tx.status = 'posted' then
    return v_tx; -- idempotent retry after an uncertain client response
  end if;

  if v_tx.status <> 'draft' then
    raise exception 'Only draft transactions can be posted; current status: %', v_tx.status
      using errcode = '55000';
  end if;

  select count(*) into v_line_count
  from public.avcu_ledger_entries
  where transaction_id = p_transaction_id;

  if v_line_count < 2 then
    raise exception 'A posted journal requires at least two entries' using errcode = '23514';
  end if;

  select count(*) into v_currency_count
  from (
    select currency_code
    from public.avcu_ledger_entries
    where transaction_id = p_transaction_id
    group by currency_code
  ) currencies;

  select count(*) into v_unbalanced_count
  from (
    select currency_code
    from public.avcu_ledger_entries
    where transaction_id = p_transaction_id
    group by currency_code
    having sum(debit_amount) <> sum(credit_amount)
  ) unbalanced;

  if v_currency_count = 0 or v_unbalanced_count > 0 then
    raise exception 'Journal debits and credits must balance independently in every currency'
      using errcode = '23514';
  end if;

  if exists (
    select 1
    from public.avcu_ledger_entries e
    join public.avcu_ledger_accounts a on a.id = e.ledger_account_id
    where e.transaction_id = p_transaction_id
      and e.currency_code <> a.currency_code
  ) then
    raise exception 'Journal entry currency does not match its ledger account'
      using errcode = '23514';
  end if;

  perform set_config('avcu.ledger_operation','post',true);

  update public.avcu_ledger_transactions
  set status = 'posted',
      posted_at = now()
  where id = p_transaction_id
  returning * into v_tx;

  insert into public.avcu_ledger_audit_events(transaction_id,event_type,actor_role,reason)
  values (p_transaction_id,'posted',coalesce(nullif(current_setting('request.jwt.claim.role',true),''),session_user::text),'Balanced journal posted');

  return v_tx;
end;
$$;

create or replace function public.avcu_reverse_ledger_transaction(
  p_transaction_id uuid,
  p_reason text
) returns public.avcu_ledger_transactions
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_original public.avcu_ledger_transactions;
  v_reversal public.avcu_ledger_transactions;
  v_key text;
begin
  select * into v_original
  from public.avcu_ledger_transactions
  where id = p_transaction_id
  for update;

  if not found then
    raise exception 'Ledger transaction not found' using errcode = 'P0002';
  end if;

  if v_original.status = 'reversed' then
    select * into v_reversal
    from public.avcu_ledger_transactions
    where id = v_original.reversed_by;
    return v_reversal;
  end if;

  if v_original.status <> 'posted' then
    raise exception 'Only posted transactions can be reversed' using errcode = '55000';
  end if;

  if p_reason is null or length(trim(p_reason)) < 3 then
    raise exception 'A meaningful reversal reason is required' using errcode = '22023';
  end if;

  v_key := 'reverse:' || v_original.id::text;

  insert into public.avcu_ledger_transactions(
    idempotency_key, external_reference, transaction_type, status,
    description, effective_at, metadata
  ) values (
    v_key, v_original.external_reference, 'reversal', 'draft',
    'Reversal of ' || v_original.id::text, now(),
    jsonb_build_object('reverses_transaction_id',v_original.id,'reason',trim(p_reason))
  )
  on conflict (idempotency_key) do nothing;

  select * into v_reversal
  from public.avcu_ledger_transactions
  where idempotency_key = v_key
  for update;

  if v_reversal.status = 'draft' then
    insert into public.avcu_ledger_entries(
      transaction_id, ledger_account_id, currency_code, debit_amount, credit_amount
    )
    select
      v_reversal.id, ledger_account_id, currency_code, credit_amount, debit_amount
    from public.avcu_ledger_entries
    where transaction_id = v_original.id;

    perform public.avcu_post_ledger_transaction(v_reversal.id);
    select * into v_reversal
    from public.avcu_ledger_transactions
    where id = v_reversal.id;
  end if;

  perform set_config('avcu.ledger_operation','reverse',true);

  update public.avcu_ledger_transactions
  set status = 'reversed', reversed_by = v_reversal.id
  where id = v_original.id;

  insert into public.avcu_ledger_audit_events(transaction_id,event_type,actor_role,reason,metadata)
  values (
    v_original.id,'reversed',coalesce(nullif(current_setting('request.jwt.claim.role',true),''),session_user::text),trim(p_reason),
    jsonb_build_object('reversal_transaction_id',v_reversal.id)
  );

  return v_reversal;
end;
$$;

revoke insert, update, delete on public.avcu_ledger_transactions from service_role;
revoke insert, update, delete on public.avcu_ledger_entries from service_role;
grant select on public.avcu_ledger_transactions, public.avcu_ledger_entries to service_role;

revoke all on function public.avcu_create_draft_ledger_transaction(text,text,text,text,timestamptz,jsonb,jsonb) from public, anon, authenticated, service_role;
grant execute on function public.avcu_create_draft_ledger_transaction(text,text,text,text,timestamptz,jsonb,jsonb) to service_role;

revoke all on function public.avcu_post_ledger_transaction(uuid) from public, anon, authenticated, service_role;
revoke all on function public.avcu_reverse_ledger_transaction(uuid,text) from public, anon, authenticated, service_role;
grant execute on function public.avcu_post_ledger_transaction(uuid) to service_role;
grant execute on function public.avcu_reverse_ledger_transaction(uuid,text) to service_role;

comment on function public.avcu_post_ledger_transaction(uuid) is
  'Atomically posts a draft double-entry journal after per-currency balancing and currency-account validation. Safe to retry.';
comment on function public.avcu_reverse_ledger_transaction(uuid,text) is
  'Creates an idempotent compensating journal; never deletes or edits posted entries.';
