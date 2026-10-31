-- AVCU jurisdiction controls.
-- Configuration only: every product remains unavailable until a scoped approval is
-- explicitly recorded, current, evidenced, and linked to an approved provider route.

create table if not exists public.avcu_jurisdictions (
  country_code char(2) primary key,
  country_name text not null,
  region_code text not null check (region_code in ('US','CA','UK','EU_EEA','EUROPE_NON_EEA')),
  eu_member boolean not null default false,
  eea_member boolean not null default false,
  enabled_for_onboarding boolean not null default false,
  created_at timestamptz not null default now(),
  check (country_code = upper(country_code))
);

-- Initial market map only. Membership flags are data, not permission to operate.
insert into public.avcu_jurisdictions
  (country_code, country_name, region_code, eu_member, eea_member)
values
  ('US','United States','US',false,false),
  ('CA','Canada','CA',false,false),
  ('GB','United Kingdom','UK',false,false),
  ('AT','Austria','EU_EEA',true,true),
  ('BE','Belgium','EU_EEA',true,true),
  ('BG','Bulgaria','EU_EEA',true,true),
  ('HR','Croatia','EU_EEA',true,true),
  ('CY','Cyprus','EU_EEA',true,true),
  ('CZ','Czechia','EU_EEA',true,true),
  ('DK','Denmark','EU_EEA',true,true),
  ('EE','Estonia','EU_EEA',true,true),
  ('FI','Finland','EU_EEA',true,true),
  ('FR','France','EU_EEA',true,true),
  ('DE','Germany','EU_EEA',true,true),
  ('GR','Greece','EU_EEA',true,true),
  ('HU','Hungary','EU_EEA',true,true),
  ('IE','Ireland','EU_EEA',true,true),
  ('IT','Italy','EU_EEA',true,true),
  ('LV','Latvia','EU_EEA',true,true),
  ('LT','Lithuania','EU_EEA',true,true),
  ('LU','Luxembourg','EU_EEA',true,true),
  ('MT','Malta','EU_EEA',true,true),
  ('NL','Netherlands','EU_EEA',true,true),
  ('PL','Poland','EU_EEA',true,true),
  ('PT','Portugal','EU_EEA',true,true),
  ('RO','Romania','EU_EEA',true,true),
  ('SK','Slovakia','EU_EEA',true,true),
  ('SI','Slovenia','EU_EEA',true,true),
  ('ES','Spain','EU_EEA',true,true),
  ('SE','Sweden','EU_EEA',true,true),
  ('IS','Iceland','EU_EEA',false,true),
  ('LI','Liechtenstein','EU_EEA',false,true),
  ('NO','Norway','EU_EEA',false,true),
  ('CH','Switzerland','EUROPE_NON_EEA',false,false),
  ('AL','Albania','EUROPE_NON_EEA',false,false),
  ('AD','Andorra','EUROPE_NON_EEA',false,false),
  ('BA','Bosnia and Herzegovina','EUROPE_NON_EEA',false,false),
  ('GE','Georgia','EUROPE_NON_EEA',false,false),
  ('MD','Moldova','EUROPE_NON_EEA',false,false),
  ('MC','Monaco','EUROPE_NON_EEA',false,false),
  ('ME','Montenegro','EUROPE_NON_EEA',false,false),
  ('MK','North Macedonia','EUROPE_NON_EEA',false,false),
  ('SM','San Marino','EUROPE_NON_EEA',false,false),
  ('RS','Serbia','EUROPE_NON_EEA',false,false),
  ('TR','Türkiye','EUROPE_NON_EEA',false,false),
  ('UA','Ukraine','EUROPE_NON_EEA',false,false),
  ('VA','Vatican City','EUROPE_NON_EEA',false,false)
on conflict (country_code) do update set
  country_name = excluded.country_name,
  region_code = excluded.region_code,
  eu_member = excluded.eu_member,
  eea_member = excluded.eea_member;

create table if not exists public.avcu_product_authorizations (
  id uuid primary key default gen_random_uuid(),
  operating_entity_code text not null,
  country_code char(2) not null references public.avcu_jurisdictions(country_code),
  customer_type text not null check (customer_type in ('individual','business')),
  capability_code text not null check (capability_code in (
    'personal_accounts','business_accounts','domestic_payments',
    'international_payments','external_bank_linking','virtual_cards',
    'physical_cards','deposits','withdrawals'
  )),
  approval_status text not null default 'pending'
    check (approval_status in ('draft','pending','approved','suspended','expired','revoked')),
  regulator_name text,
  partner_code text,
  evidence_reference text,
  approved_by text,
  approved_at timestamptz,
  effective_from timestamptz,
  effective_until timestamptz,
  review_due_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (effective_until is null or effective_from is null or effective_until > effective_from),
  check (
    approval_status <> 'approved'
    or (
      regulator_name is not null and length(trim(regulator_name)) > 0
      and evidence_reference is not null and length(trim(evidence_reference)) > 0
      and approved_by is not null and length(trim(approved_by)) > 0
      and approved_at is not null and effective_from is not null
    )
  )
);

create index if not exists avcu_product_authorizations_lookup_idx
  on public.avcu_product_authorizations
  (country_code, customer_type, capability_code, approval_status);

create table if not exists public.avcu_provider_routes (
  id uuid primary key default gen_random_uuid(),
  authorization_id uuid not null references public.avcu_product_authorizations(id) on delete restrict,
  provider_code text not null,
  provider_program_code text,
  route_status text not null default 'disabled'
    check (route_status in ('disabled','sandbox','approved','suspended')),
  supported_currency_codes text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (authorization_id, provider_code, provider_program_code)
);

alter table public.avcu_jurisdictions enable row level security;
alter table public.avcu_product_authorizations enable row level security;
alter table public.avcu_provider_routes enable row level security;

revoke all on public.avcu_jurisdictions from anon, authenticated;
revoke all on public.avcu_product_authorizations from anon, authenticated;
revoke all on public.avcu_provider_routes from anon, authenticated;

-- A positive result requires a currently approved country/product/customer-scope
-- authorization AND a currently approved provider route. Missing data fails closed.
create or replace function public.avcu_capability_is_enabled(
  p_operating_entity_code text,
  p_country_code text,
  p_customer_type text,
  p_capability_code text,
  p_provider_code text,
  p_currency_code text default null
) returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.avcu_product_authorizations a
    join public.avcu_provider_routes r on r.authorization_id = a.id
    join public.avcu_jurisdictions j on j.country_code = a.country_code
    where a.operating_entity_code = p_operating_entity_code
      and a.country_code = upper(p_country_code)
      and a.customer_type = p_customer_type
      and a.capability_code = p_capability_code
      and a.approval_status = 'approved'
      and a.approved_at <= now()
      and a.effective_from <= now()
      and (a.effective_until is null or a.effective_until > now())
      and (a.review_due_at is null or a.review_due_at > now())
      and j.enabled_for_onboarding = true
      and r.provider_code = p_provider_code
      and r.route_status = 'approved'
      and (p_currency_code is null or upper(p_currency_code) = any(r.supported_currency_codes))
  );
$$;

revoke all on function public.avcu_capability_is_enabled(text,text,text,text,text,text) from public, anon, authenticated;

comment on table public.avcu_jurisdictions is
  'Country and regional classification only; it does not grant regulatory permission.';
comment on table public.avcu_product_authorizations is
  'Evidence-backed, scoped approvals. No row means no permission.';
comment on table public.avcu_provider_routes is
  'Provider routing is disabled by default and requires a matching approved authorization.';
comment on function public.avcu_capability_is_enabled(text,text,text,text,text,text) is
  'Fail-closed capability check; callable only by trusted server-side roles after explicit grants.';

-- Trusted backend checks only; browser roles remain denied.
grant execute on function public.avcu_capability_is_enabled(text,text,text,text,text,text) to service_role;
