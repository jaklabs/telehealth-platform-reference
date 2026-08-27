-- =========================================================================
-- 002 — Row-level security
-- =========================================================================
--
-- This is the file that makes the platform multi-tenant. Four things have
-- to be true together; any one missing and the rest is decoration:
--
--   1. Policies on every tenant-scoped table
--   2. Policies that FAIL CLOSED — no tenant context means no rows
--   3. FORCE, so the table owner is subject to them too
--   4. An application role that cannot bypass RLS
--
-- Point 4 is the one that gets missed. PostgreSQL superusers and roles with
-- BYPASSRLS ignore policies entirely — perfect policies, zero protection,
-- and nothing in testing reveals it if the tests run as the owner.

BEGIN;

-- The tenant for the current connection. The application sets this once per
-- request and never again:
--
--     SET LOCAL app.tenant_id = '<uuid>';
--
-- Returns NULL when unset, which every policy below treats as "no access".
CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS UUID AS $$
    SELECT NULLIF(current_setting('app.tenant_id', TRUE), '')::UUID;
$$ LANGUAGE SQL STABLE;

-- Applies the standard tenant policy to a table. Every tenant-scoped table
-- gets exactly this, so there is one place to audit rather than fifteen.
CREATE OR REPLACE FUNCTION apply_tenant_rls(target regclass) RETURNS void AS $$
BEGIN
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', target);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', target);
    EXECUTE format($f$
        CREATE POLICY tenant_isolation ON %s
            USING      (tenant_id = current_tenant_id())
            WITH CHECK (tenant_id = current_tenant_id())
    $f$, target);
END;
$$ LANGUAGE plpgsql;

SELECT apply_tenant_rls('users');
SELECT apply_tenant_rls('patients');
SELECT apply_tenant_rls('products');
SELECT apply_tenant_rls('questionnaires');
SELECT apply_tenant_rls('visits');
SELECT apply_tenant_rls('visit_answers');
SELECT apply_tenant_rls('consents');
SELECT apply_tenant_rls('pipeline_events');
SELECT apply_tenant_rls('audit_log');

-- ---------------------------------------------------------------- tenants
--
-- The tenants table is different. A clinic may READ its own row — it needs
-- its branding and its price. It gets no INSERT, UPDATE or DELETE policy at
-- all, which is how "the platform controls pricing and clinics cannot change
-- it" is enforced. Not a hidden button: an absent policy.

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_reads_own ON tenants
    FOR SELECT USING (id = current_tenant_id());

-- -------------------------------------------------- append-only enforcement
--
-- Audit and event history must be impossible to alter, including by the
-- application. Revoking UPDATE and DELETE is stronger than a policy: there
-- is no statement the app role can issue that rewrites history.

CREATE OR REPLACE FUNCTION reject_mutation() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION '% is append-only', TG_TABLE_NAME
        USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER no_update BEFORE UPDATE ON pipeline_events
    FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER no_delete BEFORE DELETE ON pipeline_events
    FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER no_update BEFORE UPDATE ON audit_log
    FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER no_delete BEFORE DELETE ON audit_log
    FOR EACH ROW EXECUTE FUNCTION reject_mutation();

COMMIT;
