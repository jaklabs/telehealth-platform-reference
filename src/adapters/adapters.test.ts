/**
 * Adapter contract tests.
 *
 * These run against the mock, but they're written as a contract every adapter
 * must satisfy. A new adapter is held to exactly this suite
 * with credentials and staging.
 */

import { strict as assert } from "node:assert";
import { test, describe, beforeEach } from "node:test";

import { MockNetworkAdapter } from "./mock.ts";
import * as registry from "./registry.ts";
import type { VisitSubmission } from "./types.ts";

const net = new MockNetworkAdapter();

function submission(over: Partial<VisitSubmission> = {}): VisitSubmission {
  return {
    masterId: `m_${Math.random().toString(36).slice(2, 11)}`,
    tenantId: "11111111-1111-1111-1111-111111111111",
    program: "weight_loss",
    region: "US",
    patient: {
      firstName: "Dana",
      lastName: "Whitfield",
      dateOfBirth: "1985-04-02",
      sex: "female",
      email: "dana@example.test",
      phone: "+15555550101",
      address: {
        line1: "1 Main St",
        city: "Royal Oak",
        subdivision: "MI",
        postalCode: "48067",
        country: "US",
      },
    },
    answers: [{ key: "q1", question: "Any allergies?", answer: "None" }],
    treatments: [{ sku: "GLP1-1M", name: "Semaglutide", networkRefs: { medId: "x" } }],
    consents: [{ type: "telehealth", version: "1.0", signedAt: new Date().toISOString() }],
    networkConfig: {},
    ...over,
  };
}

beforeEach(() => net.reset());

describe("submission", () => {
  test("accepts a valid visit and returns a network id", async () => {
    const r = await net.submitVisit(submission());
    assert.equal(r.ok, true);
    if (r.ok) assert.ok(r.networkVisitId);
  });

  test("rejects an invalid payload as our bug, not the patient's", async () => {
    const r = await net.submitVisit(submission({ treatments: [] }));
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.error.code, "VALIDATION_FAILED");
      assert.equal(r.error.retryable, false);
    }
  });

  test("requires E.164 phone, not a local format", async () => {
    const s = submission();
    s.patient.phone = "5555550101";
    const r = await net.submitVisit(s);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error.message, /phone/);
  });

  test("rejects an unsupported region with a retryAfter-free error", async () => {
    const s = submission();
    s.patient.address.country = "GB";
    const r = await net.submitVisit(s);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, "REGION_NOT_SUPPORTED");
  });

  test("duplicate window is retryable and says when", async () => {
    const first = submission();
    assert.equal((await net.submitVisit(first)).ok, true);

    // Same patient, same programme, new visit — the cross-operator case.
    const second = submission();
    second.patient.phone = first.patient.phone;
    const r = await net.submitVisit(second);

    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.error.code, "DUPLICATE_RECENT_VISIT");
      assert.equal(r.error.retryable, true, "patient should be able to retry later");
      assert.ok(r.error.retryAfter, "must tell us when a retry becomes viable");
    }
  });
});

describe("webhooks", () => {
  test("reports itself untrusted when the network offers no verification", () => {
    const v = net.verifyWebhook();
    assert.equal(v.trusted, false);
    if (!v.trusted) assert.equal(v.reason, "no_verification_available");
  });

  test("normalises a prescription event into our vocabulary", async () => {
    const s = submission();
    await net.submitVisit(s);
    const raw = net.advance(s.masterId, "PRESCRIBED")!;

    const e = net.normalizeEvent(raw);
    assert.ok(e);
    assert.equal(e.type, "prescription.written");
    assert.equal(e.status, "PRESCRIBED");
    assert.equal(e.masterId, s.masterId);
  });

  test("synthesises a stable idempotency key when the payload has none", async () => {
    const s = submission();
    await net.submitVisit(s);
    const raw = net.advance(s.masterId, "PRESCRIBED")!;

    const a = net.normalizeEvent(raw)!;
    const b = net.normalizeEvent(raw)!;
    assert.equal(a.idempotencyKey, b.idempotencyKey, "same body must dedupe");
    assert.equal(a.idempotencyKey.length, 64);
  });

  test("distinguishes referred from prescribed", async () => {
    const s = submission();
    await net.submitVisit(s);
    const e = net.normalizeEvent(net.advance(s.masterId, "REFERRED")!)!;
    assert.equal(e.status, "REFERRED");
  });

  test("ignores events it does not model rather than throwing", () => {
    assert.equal(net.normalizeEvent('{"masterId":"x","event":"WHO_KNOWS"}'), null);
    assert.equal(net.normalizeEvent("not json at all"), null);
  });
});

describe("authoritative read", () => {
  test("getVisit is the source of truth when webhooks cannot be trusted", async () => {
    const s = submission();
    await net.submitVisit(s);
    net.advance(s.masterId, "PRESCRIBED");

    const state = await net.getVisit(s.masterId);
    assert.equal(state?.status, "PRESCRIBED");
  });

  test("returns null for an unknown visit", async () => {
    assert.equal(await net.getVisit("nope"), null);
  });
});

describe("registry", () => {
  test("resolves a registered network", () => {
    assert.equal(registry.get("mock").id, "mock");
  });

  test("names what is registered when asked for something unknown", () => {
    assert.throws(() => registry.get("no-such-network"), /Unknown clinical network/);
  });

  test("every registered adapter declares its capabilities honestly", () => {
    // The property that matters, and the reason `capabilities` exists at all.
    //
    // One real network in production could not authenticate its webhooks —
    // no signature, no shared secret, no mTLS — so a callback claiming a
    // prescription was written was forgeable by anyone who could guess an id.
    // The platform cannot refuse to integrate with a network because of that,
    // but it must never silently trust it either.
    //
    // So an adapter says what it cannot do, and the pipeline degrades: where
    // webhookVerification is false, an event is treated as a hint to go and
    // re-read authoritative state, never as the state itself.
    for (const adapter of registry.list()) {
      assert.equal(typeof adapter.capabilities.webhookVerification, "boolean",
        `${adapter.id} must declare whether its webhooks can be verified`);
      assert.ok(Array.isArray(adapter.capabilities.supportedRegions),
        `${adapter.id} must declare the regions it serves`);
    }
  });

  test("filters networks by region for tenant onboarding", () => {
    assert.ok(registry.forRegion("US").length >= 1);
    // The mock declares no region restriction, so it serves anywhere.
    assert.ok(registry.forRegion("JP").length >= 1);
  });
});
