# Multi-tenant clinical platform — architecture reference

Extracted from a production telehealth platform I designed and built solo in
2026: many separately branded clinics on one system, patient data isolated at
the database, and a vendor boundary that meant the clinical network could be
swapped without touching anything downstream.

This repository is not the product. It is the four decisions that made the
product work, with the code and the tests that enforce them — and an honest
account of three bugs that only appear in production.

```
npm install
npm test          # 26 tests, no database or network required
npm run typecheck
```

---

## Why this exists

The full platform is 95 TypeScript source files, 29 test files and 36
migrations, serving four subdomains — storefront, patient portal, clinic CRM
and webhook ingest — from one deployment. Publishing all of it would be a data
protection problem and would not be read.

What is worth showing is the small number of decisions that everything else
followed from, and whether the code actually enforces them.

---

## 1. Multi-tenancy at the database, not in application code

`db/migrations/002_rls.sql`

Every tenant-scoped table carries `tenant_id` and has PostgreSQL row-level
security enabled. The application sets `app.tenant_id` per connection; the
database refuses to return another clinic's rows even if a query forgets its
`WHERE` clause.

This is the decision that separates a platform from a pile of deployments. The
common alternative — a separate copy of the stack per clinic — gives an operator
N systems to patch, N sets of credentials, and no way to change pricing
centrally.

It also fails safe rather than open. Application-level filtering is one missing
predicate away from a cross-tenant leak, and in a system holding health data
that single mistake is the whole business. Here the missing predicate returns
nothing rather than everything.

**The question to ask anyone claiming multi-tenancy:** *is one clinic's data
isolated from another's in the database or in application code, and what stops a
query with a missing WHERE clause returning the wrong patients?* It is an
architectural decision, not a feature, and it is answerable in one sentence by
anyone who has actually built it.

## 2. The clinical-network adapter

`src/adapters/types.ts` · `registry.ts` · `mock.ts`

Everything downstream — pipeline, CRM, storefront, portals — talks to a
`ClinicalNetworkAdapter`, never to a vendor. A tenant's `clinical_network`
column selects its adapter. Adding a network is a new file and one `register()`
call.

A platform wired directly into one clinical network can only ever be sold to
that network's customers. The adapter is what made it sellable anywhere.

Four rules the interface enforces:

1. **Nothing vendor-specific crosses the boundary** — no vendor field names,
   error codes or status vocabulary.
2. **Nothing is US-shaped.** `Address.subdivision` is state, province, county or
   prefecture; postal codes are not assumed to be five digits.
3. **Adapters declare what they cannot do.** The platform degrades to the
   network's real capabilities instead of assuming video visits and labs exist.
4. **Adapters are stateless.** Persistence, retries and idempotency belong to
   the platform, so a network integration cannot invent its own.

Only the mock adapter is registered here. Real adapters encode a specific
vendor's endpoints and webhook shapes, which is their material rather than mine
to publish.

## 3. Unverifiable webhooks are hints, never state

`src/adapters/adapters.test.ts`

Not every vendor can authenticate its webhooks, and you will not always get to
pick your vendor. Verification is therefore something an adapter **declares**
rather than something the platform assumes.

You cannot refuse to integrate on that basis, and you must not silently trust
it either. So `capabilities.webhookVerification` is part of the contract, and
where it is false the pipeline treats an event as a prompt to go and re-read
authoritative state over the authenticated API — never as the state itself. An
unverifiable callback can move the platform's attention; it can never move its
data.

That is the whole design, and it holds without naming anyone: the property
belongs to the interface, not to a particular integration.

The test asserts the property rather than the vendor: every registered adapter
must declare whether its webhooks can be verified.

## 4. No database password exists

`src/core/db.ts`

Connections authenticate with a signed IAM token, minted per connection and
valid for fifteen minutes. There is no database password to leak, rotate or
find in an environment variable.

That file also carries the most instructive bug in the system — see below.

---

## Three bugs worth reading

Anyone can describe a happy path. These are the ones that only appear in a real
environment, and the reasoning is in the source next to the fix.

### `node-postgres` silently discarded the credential

`src/core/db.ts` — symptom: *"empty password returned by client"*.

`pg` does this internally:

```js
config = Object.assign({}, config, parse(config.connectionString))
```

The parsed connection string is merged **over** everything else, and parsing a
URL with no password yields `password: ""` — a key that is *present*, so it
wins. Passing both a `connectionString` and a `password` function therefore
discards the function without a word and sends an empty string.

Nothing catches it locally, because development uses ordinary URLs with no token
function. The two paths only collide in AWS. The fix decomposes the URL and
never passes the string at all, so there is nothing left for `pg` to merge.

### The health check asked a question the service was not allowed to ask

Two of four services were permanently unhealthy after deploying, with no error
that pointed anywhere useful. The readiness probe checked the main application
database — which those services' IAM roles correctly denied. The probe was
asserting a dependency the service did not have and must not have had.

Readiness now asks each role a question it is permitted to ask. A health check
that tests something outside the service's own responsibilities reports the
wrong thing in both directions.

### `readonlyRootFilesystem` stopped the exec agent

ECS Exec failed with the agent `STOPPED` and no reason given. The container had
a read-only root filesystem, which is correct hardening, and the exec agent
needs somewhere to write. Two ephemeral mounts fixed it.

Worth keeping because the failure gave no signal at all — the lesson is that
hardening changes the failure modes of tooling that has nothing to do with your
application.

---

## What is not here

The product: storefront, patient portal, clinic CRM, submission pipeline,
payments, questionnaire engine, reconciliation jobs, notification workers, the
Terraform for the whole environment, and the real network adapters. Client
identifiers, vendor API shapes and infrastructure state are all deliberately
absent.

## Stack

TypeScript · PostgreSQL with row-level security · AWS (ECS, RDS, Secrets
Manager, SES, SQS) · Terraform · Node's built-in test runner, no framework.

---

## License

**Published to be read, not reused.**

This is a portfolio artifact — the four decisions that made the product work, and
the code and tests that enforce them. It carries no open-source licence, so
ordinary copyright applies and all rights are reserved. Read it, quote it, argue
with it. Don't lift it into your own product.

If you want to use something here, ask — the answer is usually yes.

---

Built by **JD Kemp** — [jaklabs.io](https://jaklabs.io)

I build operations software for small businesses, and I run one myself, which is
why the reasoning here is about failure modes and switching costs rather than
elegance. Happy to talk about any of it.
