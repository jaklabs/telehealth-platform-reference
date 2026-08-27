import { strict as assert } from "node:assert";
import { test, describe } from "node:test";

import { tenantHost } from "./host.ts";

const CLINIC = "staging.brightpath.example";

describe("a clinic is found from any of its service subdomains", () => {
  test("the storefront host is the clinic's domain, unchanged", () => {
    assert.equal(tenantHost(CLINIC), CLINIC);
  });

  test("portal, crm and hooks resolve to the same clinic", () => {
    for (const prefix of ["portal", "crm", "hooks"]) {
      assert.equal(tenantHost(`${prefix}.${CLINIC}`), CLINIC, prefix);
    }
  });

  test("www is treated the same way", () => {
    assert.equal(tenantHost("www.brightpath.example"), "brightpath.example");
  });
});

describe("hostnames it must not rewrite", () => {
  // The reason the prefixes are an allowlist rather than "drop the first
  // label". Reducing this to "com" would match nothing at best, and at worst
  // match whatever a future clinic is called.
  test("a bare domain keeps both labels", () => {
    assert.equal(tenantHost("brightpath.example"), "brightpath.example");
  });

  // A clinic that genuinely lives at crm.io keeps its name.
  test("a two-label host is never reduced to its suffix", () => {
    assert.equal(tenantHost("crm.io"), "crm.io");
    assert.equal(tenantHost("portal.com"), "portal.com");
  });

  // The dangerous case: stripping here would resolve one customer's
  // subdomain to another customer's apex.
  test("an unrecognised subdomain is left alone", () => {
    assert.equal(tenantHost("wellness.example.com"), "wellness.example.com");
    assert.equal(tenantHost("clinic.brightpath.example"), "clinic.brightpath.example");
  });

  test("only one label is removed", () => {
    assert.equal(tenantHost("portal.crm.example.com"), "crm.example.com");
  });
});

describe("normalisation", () => {
  test("the port is dropped", () => {
    assert.equal(tenantHost("becoming.test:8080"), "becoming.test");
    assert.equal(tenantHost("portal.becoming.test:8081"), "becoming.test");
  });

  test("case is folded, because Host headers are not case-consistent", () => {
    assert.equal(tenantHost("PORTAL.Staging.BrightPath.example"), CLINIC);
  });

  test("a missing or empty header is an empty string, not a crash", () => {
    assert.equal(tenantHost(undefined), "");
    assert.equal(tenantHost(""), "");
  });
});
