/**
 * Which clinic a request belongs to, from the hostname.
 *
 * A clinic has one domain on its tenant row, and its services are reached at
 * subdomains named after what they do:
 *
 *   staging.brightpath.example          the storefront — the clinic's domain
 *   portal.staging.brightpath.example   the patient's account
 *   crm.staging.brightpath.example      where clinic staff work
 *   hooks.staging.brightpath.example    the clinical network's callbacks
 *
 * Only the first of those equals `primary_domain`, so matching the raw Host
 * header finds the clinic for the storefront and nothing else. The portal and
 * the CRM return 404 for a clinic that plainly exists.
 *
 * So the service label comes off before the lookup. The alternative — a row
 * per hostname — is the right answer if clinics ever want unrelated domains
 * per service, and is more machinery than the situation currently earns.
 *
 * The prefixes are an allowlist rather than "strip the first label", because
 * a clinic reached at `brightpath.example` must not be looked up as
 * `com`, and a clinic that really is at `wellness.example.com` must not
 * silently resolve to `example.com` — a different customer's domain.
 */

const SERVICE_PREFIXES = new Set(["portal", "crm", "hooks", "www"]);

/**
 * Normalises a Host header to the clinic's own domain.
 *
 * Lowercases, drops any port, and removes one leading service label. Anything
 * it does not recognise is returned unchanged.
 */
export function tenantHost(host: string | undefined): string {
  const bare = (host ?? "").toLowerCase().split(":")[0] ?? "";
  const labels = bare.split(".");
  const [first, ...rest] = labels;

  // Two labels must remain, so `crm.io` keeps its own name rather than being
  // reduced to `io`.
  if (first && rest.length >= 2 && SERVICE_PREFIXES.has(first)) {
    return rest.join(".");
  }
  return bare;
}
