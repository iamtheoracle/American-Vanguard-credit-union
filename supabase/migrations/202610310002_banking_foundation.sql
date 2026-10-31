-- AVCU banking foundation: provider-independent account registry and ledger primitives.
-- This migration creates schema only. It does not connect a provider, create customer
-- accounts, move money, or enable production banking.

create extension if not exists pgcrypto;

do $$ begin
  create type public.avcu_account_kind as enum ('customer', 'settlement', 'fee', 'suspense');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.avcu_ledger_account_type as enum ('asset', 'liability', 'equity', 'income', 'expense');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.avcu_transaction_status as enum ('draft', 'pending', 'posted', 'failed', 'reversed');
exception when duplicate_object then null; end $$;

create table if not exists public.avcu_financial_accounts (
  id uuid primary key default gen_random_uuid(),
  owner_profile_id uuid references public.member_profiles(id) on delete restrict,
  account_kind public.avcu_account_kind not null,
  country_code char(2) not null,
  currency_code char(3) not null,
  provider_code text,
  provider_account_ref text,
  status text not null default 'pending'
    check (status in ('pending', 'active', 'restricted', 'closed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (country_code = upper(country_code)),
  check (currency_code = upper(currency_code)),
  unique (provider_code, provider_account_ref)
);

create table if not exists public.avcu_ledger_accounts (
  id uuid primary key default gen_random_uuid(),
  financial_account_id uuid references public.avcu_financial_accounts(id) on delete restrict,
  code text not null unique,
  account_type public.avcu_ledger_account_type not null,
  currency_code char(3) not null,
  is_control_account boolean not null default false,
  created_at timestamptz not null default now(),
  check (currency_code = upper(currency_code))
);

create table if not exists public.avcu_ledger_transactions (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique,
  external_reference text,
  transaction_type text not null,
  status public.avcu_transaction_status not null default 'draft',
  description text,
  effective_at timestamptz,
  created_at timestamptz not null default now(),
  posted_at timestamptz,
  reversed_by uuid references public.avcu_ledger_transactions(id),
  metadata jsonb not null default '{}'::jsonb
);

create table if not exists public.avcu_ledger_entries (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references public.avcu_ledger_transactions(id) on delete restrict,
  ledger_account_id uuid not null references public.avcu_ledger_accounts(id) on delete restrict,
  currency_code char(3) not null,
  debit_amount numeric(20,4) not null default 0 check (debit_amount >= 0),
  credit_amount numeric(20,4) not null default 0 check (credit_amount >= 0),
  created_at timestamptz not null default now(),
  check (currency_code = upper(currency_code)),
  check ((debit_amount > 0 and credit_amount = 0) or (credit_amount > 0 and debit_amount = 0))
);

create index if not exists avcu_ledger_entries_transaction_idx
  on public.avcu_ledger_entries(transaction_id);
create index if not exists avcu_ledger_entries_account_idx
  on public.avcu_ledger_entries(ledger_account_id, created_at desc);

create table if not exists public.avcu_provider_events (
  id uuid primary key default gen_random_uuid(),
  provider_code text not null,
  provider_event_id text not null,
  event_type text not null,
  payload jsonb not null,
  signature_verified boolean not null default false,
  processing_status text not null default 'received'
    check (processing_status in ('received', 'processing', 'processed', 'retry', 'quarantined')),
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  unique (provider_code, provider_event_id)
);

-- These are financial-control tables. Browser/member roles receive no direct access.
alter table public.avcu_financial_accounts enable row level security;
alter table public.avcu_ledger_accounts enable row level security;
alter table public.avcu_ledger_transactions enable row level security;
alter table public.avcu_ledger_entries enable row level security;
alter table public.avcu_provider_events enable row level security;

revoke all on public.avcu_financial_accounts from anon, authenticated;
revoke all on public.avcu_ledger_accounts from anon, authenticated;
revoke all on public.avcu_ledger_transactions from anon, authenticated;
revoke all on public.avcu_ledger_entries from anon, authenticated;
revoke all on public.avcu_provider_events from anon, authenticated;

comment on table public.avcu_financial_accounts is
  'Provider-independent account registry. Not proof of a bank account or deposit insurance.';
comment on table public.avcu_ledger_transactions is
  'Financial journal headers. Posting must occur only through a reviewed server-side transaction service.';
comment on table public.avcu_ledger_entries is
  'Double-entry journal lines. Entries must balance per currency before a transaction can be posted.';
comment on table public.avcu_provider_events is
  'Deduplicated provider webhook inbox. Verify signatures before processing; never trust payload instructions.';
