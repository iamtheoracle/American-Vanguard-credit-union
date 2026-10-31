-- AVCU member identity foundation for Supabase Auth.
-- Apply only to a dedicated Supabase project after reviewing the deployment plan.
-- This migration deliberately does not create auth users, import demo data, or enable public signup.

create table if not exists public.member_profiles (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid not null unique references auth.users(id) on delete restrict,
  member_number text unique,
  display_name text,
  status text not null default 'pending'
    check (status in ('pending', 'active', 'locked', 'closed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.member_profiles is
  'AVCU identity-to-member mapping only. Not a financial ledger or source of balances.';
comment on column public.member_profiles.status is
  'Operational member status. Login eligibility must also be enforced by trusted server-side policy.';

alter table public.member_profiles enable row level security;

-- Members can read only their own non-sensitive profile summary.
drop policy if exists "Members read own profile" on public.member_profiles;
create policy "Members read own profile"
  on public.member_profiles for select
  to authenticated
  using (auth_user_id = (select auth.uid()));

-- No client-side insert/update/delete policies are intentionally provided.
-- Provisioning and status changes must be performed by a trusted, audited server process.
revoke all on public.member_profiles from anon, authenticated;
grant select on public.member_profiles to authenticated;

create index if not exists member_profiles_status_idx
  on public.member_profiles(status);

