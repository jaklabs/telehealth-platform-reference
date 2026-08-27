/**
 * Adapter registry.
 *
 * A tenant's `clinical_network` column selects its adapter. Adding support
 * for a new network is: write an adapter, register it here. No change to the
 * pipeline, the CRM, the storefront or any portal.
 *
 * This is the file that makes the platform sellable outside one vendor's
 * customer base.
 */

import type { ClinicalNetworkAdapter, CountryCode } from "./types.ts";
import { MockNetworkAdapter } from "./mock.ts";

const adapters = new Map<string, ClinicalNetworkAdapter>();

export function register(adapter: ClinicalNetworkAdapter): void {
  if (adapters.has(adapter.id)) {
    throw new Error(`Adapter "${adapter.id}" is already registered`);
  }
  adapters.set(adapter.id, adapter);
}

export function get(id: string): ClinicalNetworkAdapter {
  const adapter = adapters.get(id);
  if (!adapter) {
    throw new Error(
      `Unknown clinical network "${id}". Registered: ${[...adapters.keys()].join(", ") || "none"}`
    );
  }
  return adapter;
}

export function has(id: string): boolean {
  return adapters.has(id);
}

export function list(): ClinicalNetworkAdapter[] {
  return [...adapters.values()];
}

/**
 * Networks able to serve a given country. Used when onboarding a tenant, and
 * to tell a patient honestly that their region isn't covered rather than
 * letting a submission fail downstream.
 */
export function forRegion(country: CountryCode): ClinicalNetworkAdapter[] {
  return list().filter(
    (a) =>
      a.capabilities.supportedRegions.length === 0 ||
      a.capabilities.supportedRegions.includes(country)
  );
}

/** Reset — tests only. */
export function clear(): void {
  adapters.clear();
}

register(new MockNetworkAdapter());

/**
 * Only the mock adapter is registered in this reference.
 *
 * Real clinical-network adapters are implementations of the contract in
 * `types.ts` and live in the private platform, for the obvious reason: an
 * adapter encodes a specific vendor's endpoints, field names, error vocabulary
 * and webhook shape, and that is their material rather than mine to publish.
 *
 * What is worth showing is here: the contract every adapter satisfies, the
 * registry that selects one per tenant, and a working implementation. Adding a
 * network is a new file plus one `register()` call — no change to the pipeline,
 * the CRM, the storefront or any portal. That is the whole point of the
 * boundary.
 *
 * In the production system the secret for each network is resolved from AWS
 * Secrets Manager by id at call time, taken from the tenant's own
 * `clinical_network_config`, so no credential is ever stored in the database.
 */
