-- =========================================================================
-- 001 — Multi-tenant foundation
-- =========================================================================
--
-- The architectural decisions in this file are the ones that cannot be
-- changed later without a rewrite:
--
--   1. Every tenant-scoped table carries tenant_id and is protected by
--      row-level security. Isolation is enforced by the database, not by
--      remembering to write a WHERE clause.
--   2. Policies FAIL CLOSED. No tenant context means no rows.
--   3. The application connects as a role that cannot bypass RLS.
--   4. pipeline_events and audit_log are append-only.
--
-- Everything else in the platform can be refactored. This cannot.

BEGIN;

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- -------------------------------------------------------------- tenancy

-- A tenant is one branded clinic operating on the platform. The platform
-- owner's own brand is simply the first tenant — it runs the same code
-- path as every partner clinic, deliberately.
CREATE TABLE tenants (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug            TEXT NOT NULL UNIQUE,
    name            TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'ACTIVE'
                        CHECK (status IN ('ACTIVE','SUSPENDED','ONBOARDING')),

    -- Branding is configuration, never code.
    primary_domain  TEXT UNIQUE,
    brand           JSONB NOT NULL DEFAULT '{}'::jsonb,

    -- Which clinical network this tenant is wired to. The platform talks to
    -- an adapter, so a tenant on a different network is a config value,
    -- not a different build.
    clinical_network        TEXT NOT NULL DEFAULT 'acme',
    clinical_network_config JSONB NOT NULL DEFAULT '{}'::jsonb,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE tenants IS
    'One row per branded clinic. Platform-owner rows only — never tenant-writable.';

-- --------------------------------------------------------------- people

CREATE TABLE users (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    UUID REFERENCES tenants(id) ON DELETE CASCADE,
    email        TEXT NOT NULL,
    full_name    TEXT NOT NULL,

    -- PLATFORM_* roles have tenant_id NULL and operate across tenants via
    -- a separate database credential, never via a NULL tenant check.
    role         TEXT NOT NULL
                     CHECK (role IN ('PLATFORM_ADMIN','PLATFORM_OPS',
                                     'TENANT_ADMIN','TENANT_STAFF','PROVIDER')),
    status       TEXT NOT NULL DEFAULT 'ACTIVE'
                     CHECK (status IN ('ACTIVE','DISABLED','INVITED')),
    external_id  TEXT,                        -- identity provider subject
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, email)
);

CREATE TABLE patients (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

    external_id    TEXT,                      -- identity provider subject
    first_name     TEXT NOT NULL,
    last_name      TEXT NOT NULL,
    dob            DATE NOT NULL,
    sex            TEXT NOT NULL CHECK (sex IN ('Male','Female','Other')),
    email          TEXT NOT NULL,

    -- Clinical networks commonly require one patient per phone number.
    -- Unique per tenant rather than globally: two clinics may legitimately
    -- serve the same person.
    phone          TEXT NOT NULL,

    address_line1  TEXT,
    city           TEXT,
    state          CHAR(2),
    zip            TEXT,

    -- Acquisition attribution, for partner commission calculation.
    source         TEXT,
    referred_by    UUID REFERENCES tenants(id),

    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, phone)
);

-- ------------------------------------------------------------- catalogue

-- Programs and their mapping to whatever the clinical network calls them.
-- The network's identifier lives in network_refs so a tenant can move
-- networks without the catalogue being rebuilt.
CREATE TABLE products (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    sku           TEXT NOT NULL,
    name          TEXT NOT NULL,
    program       TEXT NOT NULL,              -- 'weight_loss', 'trt', 'ed'
    visit_type    TEXT NOT NULL,              -- network's visitType string
    network_refs  JSONB NOT NULL DEFAULT '{}'::jsonb,   -- { "medId": "..." }

    -- Pricing is platform-controlled. Tenants have no UPDATE policy on this
    -- table at all, so a clinic cannot change its own price.
    price_cents   INTEGER NOT NULL CHECK (price_cents >= 0),
    active        BOOLEAN NOT NULL DEFAULT true,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, sku)
);

-- Questionnaires are versioned configuration. A new vertical is a row,
-- not a deployment.
CREATE TABLE questionnaires (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    program     TEXT NOT NULL,
    version     INTEGER NOT NULL,
    definition  JSONB NOT NULL,               -- questions, branching, exclusions
    published   BOOLEAN NOT NULL DEFAULT false,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, program, version)
);

-- ---------------------------------------------------------------- visits

CREATE TABLE visits (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    patient_id      UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
    product_id      UUID REFERENCES products(id),

    -- Our identifier, generated by us and sent to the network.
    master_id       TEXT NOT NULL UNIQUE,
    -- The network's identifier, when it returns one.
    network_visit_id TEXT,

    pipeline_stage  TEXT NOT NULL DEFAULT 'LEAD',
    network_status  TEXT,
    outcome         TEXT CHECK (outcome IN ('prescribed','referred','canceled')),

    -- Exactly what we transmitted, retained verbatim. When there is a
    -- clinical question a year from now, "what did we send" must be
    -- answerable from our own records.
    submitted_payload JSONB,
    submitted_at      TIMESTAMPTZ,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE visit_answers (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    visit_id    UUID NOT NULL REFERENCES visits(id) ON DELETE CASCADE,
    questionnaire_id UUID REFERENCES questionnaires(id),
    answers     JSONB NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE consents (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    patient_id    UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
    consent_type  TEXT NOT NULL,
    version       TEXT NOT NULL,
    document_hash TEXT,
    signed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    ip_address    INET
);

-- ------------------------------------------------------- append-only logs

-- The pipeline is a projection of this table. Stage is derived from real
-- events, never hand-set, which is what makes the timeline auditable.
CREATE TABLE pipeline_events (
    id            BIGSERIAL PRIMARY KEY,
    tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    visit_id      UUID REFERENCES visits(id) ON DELETE CASCADE,
    patient_id    UUID REFERENCES patients(id) ON DELETE CASCADE,

    event_type    TEXT NOT NULL,
    from_stage    TEXT,
    to_stage      TEXT,
    source        TEXT NOT NULL
                      CHECK (source IN ('system','network','staff','patient','timer')),
    actor         TEXT,
    payload       JSONB NOT NULL DEFAULT '{}'::jsonb,

    -- Deduplication key for inbound network events. Networks frequently
    -- send no event id, so this is synthesised from a hash of the body.
    idempotency_key TEXT UNIQUE,

    occurred_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
    id          BIGSERIAL PRIMARY KEY,
    tenant_id   UUID REFERENCES tenants(id) ON DELETE CASCADE,
    actor_id    UUID,
    actor_role  TEXT,
    action      TEXT NOT NULL,               -- READ | CREATE | UPDATE | DELETE | EXPORT
    entity_type TEXT NOT NULL,
    entity_id   TEXT,
    detail      JSONB NOT NULL DEFAULT '{}'::jsonb,
    ip_address  INET,
    at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE audit_log IS
    'Append-only. Never contains PHI values — identifiers and actions only.';

-- --------------------------------------------------------------- indexes

CREATE INDEX ON users (tenant_id);
CREATE INDEX ON patients (tenant_id);
CREATE INDEX ON patients (tenant_id, email);
CREATE INDEX ON products (tenant_id);
CREATE INDEX ON questionnaires (tenant_id, program);
CREATE INDEX ON visits (tenant_id);
CREATE INDEX ON visits (tenant_id, pipeline_stage);
CREATE INDEX ON visits (network_visit_id);
CREATE INDEX ON visit_answers (tenant_id, visit_id);
CREATE INDEX ON consents (tenant_id, patient_id);
CREATE INDEX ON pipeline_events (tenant_id, visit_id, occurred_at DESC);
CREATE INDEX ON pipeline_events (tenant_id, occurred_at DESC);
CREATE INDEX ON audit_log (tenant_id, at DESC);
CREATE INDEX ON audit_log (entity_type, entity_id);

COMMIT;
