-- =========================================================================
-- 003 — Database roles
-- =========================================================================
--
-- Two roles, deliberately separated. This file is the reason the policies in
-- 002 actually do anything.
--
--   platform_app    every tenant-facing request. CANNOT bypass RLS.
--   platform_owner  the owner console. BYPASSRLS, on its own credential.
--
-- Cross-tenant visibility is therefore a distinct credential that can be
-- rotated, monitored and audited separately — never something a forgotten
-- SET silently confers on the application.
--
-- Passwords here are placeholders for local development. Production uses
-- IAM database authentication with no static credentials at all.

BEGIN;

-- ------------------------------------------------------------ application

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'platform_app') THEN
        CREATE ROLE platform_app LOGIN PASSWORD 'local_dev_only'
            NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
    END IF;
END $$;

GRANT USAGE ON SCHEMA public TO platform_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO platform_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO platform_app;

-- The application may never alter history, and may never change a tenant's
-- own configuration or pricing.
REVOKE UPDATE, DELETE ON pipeline_events, audit_log FROM platform_app;
REVOKE INSERT, UPDATE, DELETE ON tenants FROM platform_app;

-- ---------------------------------------------------------- owner console

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'platform_owner') THEN
        CREATE ROLE platform_owner LOGIN PASSWORD 'local_dev_only'
            NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS;
    END IF;
END $$;

GRANT USAGE ON SCHEMA public TO platform_owner;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO platform_owner;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO platform_owner;

-- Even the owner console cannot rewrite history.
REVOKE UPDATE, DELETE ON pipeline_events, audit_log FROM platform_owner;

-- Anything created by later migrations inherits the same grants.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO platform_app, platform_owner;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO platform_app, platform_owner;

COMMIT;
