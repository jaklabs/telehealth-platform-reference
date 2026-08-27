/**
 * Mock clinical network.
 *
 * This is what makes the rest of the platform buildable today. AcmeHealth has not
 * supplied working credentials or current documentation, and until they do,
 * nothing can be built against them. Everything downstream — pipeline, CRM,
 * storefront, portals, refills — can be built and tested against this instead.
 *
 * It is not a stub. It deliberately reproduces the behaviours that make real
 * clinical networks difficult:
 *
 *   - Rejects on the duplicate-visit window, the way networks do to stop the
 *     same patient being submitted twice across operators
 *   - Rejects unsupported regions
 *   - Emits webhooks with no verification and no event id, so the platform's
 *     untrusted-hint handling and synthesised idempotency get exercised
 *   - Advances visits through states over time rather than instantly
 *
 * If the platform works against this, it will work against a real network.
 */

import { createHash } from "node:crypto";
import type {
  ClinicalNetworkAdapter,
  NetworkCapabilities,
  NetworkVisitState,
  NormalizedEvent,
  NormalizedVisitStatus,
  VisitSubmission,
  VisitSubmissionResult,
  WebhookVerification,
} from "./types.ts";

interface MockVisit {
  masterId: string;
  networkVisitId: string;
  status: NormalizedVisitStatus;
  submittedAt: number;
  patientKey: string;
  program: string;
}

export interface MockOptions {
  /** Hours in which the same patient+program is refused. Networks do this. */
  duplicateWindowHours?: number;
  supportedRegions?: string[];
  /** Force a specific failure, for testing error paths. */
  failWith?: VisitSubmissionResult;
}

export class MockNetworkAdapter implements ClinicalNetworkAdapter {
  readonly id = "mock";
  readonly displayName = "Mock Clinical Network";

  readonly capabilities: NetworkCapabilities = {
    asyncVisits: true,
    videoVisits: true,
    labOrders: true,
    pharmacyFulfilment: true,
    providerMessaging: true,
    automatedRefills: true,
    photoUpload: true,
    // Deliberately false. Most real networks offer nothing here, and the
    // platform must handle that case as its default rather than its edge.
    webhookVerification: false,
    supportedRegions: [],
  };

  private visits = new Map<string, MockVisit>();
  private recent = new Map<string, number>();
  private opts: Required<Omit<MockOptions, "failWith">> & Pick<MockOptions, "failWith">;

  constructor(opts: MockOptions = {}) {
    this.opts = {
      duplicateWindowHours: opts.duplicateWindowHours ?? 24,
      supportedRegions: opts.supportedRegions ?? ["US"],
      ...(opts.failWith !== undefined ? { failWith: opts.failWith } : {}),
    };
  }

  async submitVisit(s: VisitSubmission): Promise<VisitSubmissionResult> {
    if (this.opts.failWith) return this.opts.failWith;

    // Our own payload errors — engineering's problem, not the patient's.
    const missing = this.validate(s);
    if (missing.length) {
      return {
        ok: false,
        error: {
          code: "VALIDATION_FAILED",
          message: `Missing or invalid: ${missing.join(", ")}`,
          retryable: false,
        },
      };
    }

    if (
      this.opts.supportedRegions.length &&
      !this.opts.supportedRegions.includes(s.patient.address.country)
    ) {
      return {
        ok: false,
        error: {
          code: "REGION_NOT_SUPPORTED",
          message: `Region ${s.patient.address.country} is not served`,
          retryable: false,
        },
      };
    }

    const key = `${s.patient.phone}:${s.program}`;
    const last = this.recent.get(key);
    const windowMs = this.opts.duplicateWindowHours * 3600_000;
    if (last !== undefined && Date.now() - last < windowMs) {
      return {
        ok: false,
        error: {
          code: "DUPLICATE_RECENT_VISIT",
          message: "Patient submitted a visit for this program recently",
          retryable: true,
          retryAfter: new Date(last + windowMs).toISOString(),
        },
      };
    }

    const networkVisitId = `mock_${createHash("sha1")
      .update(s.masterId)
      .digest("hex")
      .slice(0, 12)}`;

    this.visits.set(s.masterId, {
      masterId: s.masterId,
      networkVisitId,
      status: "SUBMITTED",
      submittedAt: Date.now(),
      patientKey: key,
      program: s.program,
    });
    this.recent.set(key, Date.now());

    return { ok: true, networkVisitId };
  }

  async getVisit(masterId: string): Promise<NetworkVisitState | null> {
    const v = this.visits.get(masterId);
    if (!v) return null;
    return {
      networkVisitId: v.networkVisitId,
      status: v.status,
      vendorStatus: v.status.toLowerCase(),
      updatedAt: new Date().toISOString(),
    };
  }

  /**
   * Always untrusted — matching the common real-world case where a network
   * publishes no signature scheme at all. Keeps the platform honest.
   */
  verifyWebhook(): WebhookVerification {
    return { trusted: false, reason: "no_verification_available" };
  }

  normalizeEvent(rawBody: string): NormalizedEvent | null {
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      return null;
    }

    const masterId = typeof body["masterId"] === "string" ? body["masterId"] : null;
    const event = typeof body["event"] === "string" ? body["event"] : null;
    if (!masterId || !event) return null;

    // No event id and no timestamp in the payload — so the key is synthesised
    // from the body, exactly as it must be for real networks.
    const idempotencyKey = createHash("sha256").update(rawBody).digest("hex");

    const base = { masterId, idempotencyKey, raw: body };

    switch (event) {
      case "RX_WRITTEN":
        return {
          ...base,
          type: "prescription.written",
          status: "PRESCRIBED",
          prescriptions: Array.isArray(body["prescriptions"])
            ? (body["prescriptions"] as NonNullable<NormalizedEvent["prescriptions"]>)
            : [],
        };
      case "CONSULT_CONCLUDED":
        return {
          ...base,
          type: "visit.status_changed",
          status: body["outcome"] === "referred" ? "REFERRED" : "PRESCRIBED",
        };
      case "CONSULT_CANCELED":
        return { ...base, type: "visit.canceled", status: "CANCELED" };
      case "DOCTOR_CHAT":
        return {
          ...base,
          type: "message.from_provider",
          message: {
            body: String(body["content"] ?? ""),
            ...(typeof body["author"] === "string" ? { authorName: body["author"] } : {}),
          },
        };
      case "ORDER_SHIPPED":
        return {
          ...base,
          type: "order.shipped",
          order: {
            orderId: String(body["orderId"] ?? ""),
            ...(typeof body["carrier"] === "string" ? { carrier: body["carrier"] } : {}),
            ...(typeof body["tracking"] === "string" ? { tracking: body["tracking"] } : {}),
          },
        };
      case "PACKAGE_DELIVERED":
        return { ...base, type: "shipment.delivered" };
      default:
        return null;
    }
  }

  async sendPatientMessage(): Promise<{ ok: boolean }> {
    return { ok: true };
  }

  // -- test helpers --------------------------------------------------------

  /** Advance a visit and return the webhook the network would have sent. */
  advance(masterId: string, status: NormalizedVisitStatus): string | null {
    const v = this.visits.get(masterId);
    if (!v) return null;
    v.status = status;
    const event =
      status === "PRESCRIBED" ? "RX_WRITTEN"
      : status === "CANCELED" ? "CONSULT_CANCELED"
      : status === "REFERRED" ? "CONSULT_CONCLUDED"
      : "STATUS";
    return JSON.stringify({
      masterId,
      event,
      ...(status === "REFERRED" ? { outcome: "referred" } : {}),
    });
  }

  reset(): void {
    this.visits.clear();
    this.recent.clear();
  }

  private validate(s: VisitSubmission): string[] {
    const bad: string[] = [];
    if (!s.masterId) bad.push("masterId");
    if (!s.patient.firstName) bad.push("patient.firstName");
    if (!s.patient.lastName) bad.push("patient.lastName");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s.patient.dateOfBirth)) bad.push("patient.dateOfBirth");
    if (!/^\+[1-9]\d{6,14}$/.test(s.patient.phone)) bad.push("patient.phone (E.164)");
    if (!s.patient.email.includes("@")) bad.push("patient.email");
    if (!s.patient.address.country) bad.push("patient.address.country");
    if (!s.treatments.length) bad.push("treatments");
    if (!s.consents.length) bad.push("consents");
    return bad;
  }
}
