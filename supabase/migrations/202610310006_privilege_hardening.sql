-- AVCU privilege hardening for the canonical Supabase schema.
-- This migration removes implicit browser/PUBLIC grants and makes RLS apply
-- even when a table is accessed by its owner (superusers remain a platform trust root).

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon')
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated')
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
    RAISE EXCEPTION 'Supabase API roles anon, authenticated and service_role must exist';
  END IF;
END
$roles$;

REVOKE CREATE ON SCHEMA public FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

ALTER TABLE public.member_profiles FORCE ROW LEVEL SECURITY;
ALTER TABLE public.avcu_financial_accounts FORCE ROW LEVEL SECURITY;
ALTER TABLE public.avcu_ledger_accounts FORCE ROW LEVEL SECURITY;
ALTER TABLE public.avcu_ledger_transactions FORCE ROW LEVEL SECURITY;
ALTER TABLE public.avcu_ledger_entries FORCE ROW LEVEL SECURITY;
ALTER TABLE public.avcu_provider_events FORCE ROW LEVEL SECURITY;
ALTER TABLE public.avcu_jurisdictions FORCE ROW LEVEL SECURITY;
ALTER TABLE public.avcu_product_authorizations FORCE ROW LEVEL SECURITY;
ALTER TABLE public.avcu_provider_routes FORCE ROW LEVEL SECURITY;
ALTER TABLE public.avcu_ledger_audit_events FORCE ROW LEVEL SECURITY;
ALTER TABLE public.avcu_provider_event_conflicts FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE
  public.member_profiles,
  public.avcu_financial_accounts,
  public.avcu_ledger_accounts,
  public.avcu_ledger_transactions,
  public.avcu_ledger_entries,
  public.avcu_provider_events,
  public.avcu_jurisdictions,
  public.avcu_product_authorizations,
  public.avcu_provider_routes,
  public.avcu_ledger_audit_events,
  public.avcu_provider_event_conflicts
FROM PUBLIC, anon, authenticated;

-- Member profile summary is the only direct browser read; row policy limits it
-- to auth.uid() and no browser role receives write privileges.
GRANT SELECT ON public.member_profiles TO authenticated;

-- Remove PostgreSQL's default PUBLIC EXECUTE from every public-schema function.
-- Privileged application functions retain only the explicit service/verifier
-- grants installed by their reviewed migrations.
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, anon, authenticated;

-- Prevent future migrations run by the schema owner from silently restoring
-- PUBLIC/browser access on newly created objects.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE ALL ON TABLES FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE ALL ON SEQUENCES FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated;

COMMENT ON SCHEMA public IS
  'AVCU application schema: browser access is explicit, RLS is forced, and default PUBLIC grants are revoked.';
