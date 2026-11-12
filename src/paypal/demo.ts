import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import type { CreateOrderInput, PayPalDispute, PayPalGateway } from "./gateway.js";

/**
 * Offline simulator with the same contract and state rules as the real PayPal flow
 * (an order must be approved before it can be authorized, a voided hold can't be captured, etc.).
 * Used automatically when PAYPAL_CLIENT_ID/SECRET are not set, so the project runs anywhere.
 *
 * State lives in memory. After a server restart, ids it doesn't know are treated as valid
 * (the database is the source of truth), so a dev-server reload doesn't break funded milestones.
 */
type Order = { id: string; amount: number; currency: string; approved: boolean; authorizationId?: string };
type Auth = { id: string; orderId: string; amount: number; status: "CREATED" | "CAPTURED" | "VOIDED" };

const id = (p: string) => `${p}${randomUUID().replace(/-/g, "").slice(0, 17).toUpperCase()}`;
const expiry = () => new Date(Date.now() + 29 * 24 * 3600 * 1000).toISOString();

export class DemoPayPalGateway implements PayPalGateway {
  readonly mode = "demo" as const;
  orders = new Map<string, Order>();
  auths = new Map<string, Auth>();
  private byRequestId = new Map<string, string>();

  async createOrder(i: CreateOrderInput) {
    const existing = this.byRequestId.get(i.requestId);
    const o: Order = (existing && this.orders.get(existing)) || { id: id("DEMO"), amount: i.amount, currency: i.currency, approved: false };
    this.orders.set(o.id, o);
    this.byRequestId.set(i.requestId, o.id);
    return { orderId: o.id, approvalUrl: `${config.publicBaseUrl}/demo-checkout/${o.id}` };
  }

  approve(orderId: string) {
    const o = this.orders.get(orderId) ?? { id: orderId, amount: Infinity, currency: "USD", approved: false };
    o.approved = true;
    this.orders.set(orderId, o);
  }

  async authorizeOrder(orderId: string) {
    const o = this.orders.get(orderId);
    if (!o) throw new Error(`ORDER_NOT_FOUND ${orderId}`);
    if (!o.approved) throw new Error("ORDER_NOT_APPROVED: payer has not approved the order");
    if (o.authorizationId) {
      const a = this.auths.get(o.authorizationId)!;
      return { authorizationId: a.id, expiresAt: expiry(), status: a.status };
    }
    const a: Auth = { id: id("AUTH"), orderId, amount: o.amount, status: "CREATED" };
    this.auths.set(a.id, a);
    o.authorizationId = a.id;
    return { authorizationId: a.id, expiresAt: expiry(), status: "CREATED" };
  }

  private auth(authorizationId: string, amount: number) {
    let a = this.auths.get(authorizationId);
    if (!a) { // unknown after a restart: trust the database
      a = { id: authorizationId, orderId: "", amount, status: "CREATED" };
      this.auths.set(a.id, a);
    }
    return a;
  }

  async captureAuthorization(authorizationId: string, amount: number) {
    const a = this.auth(authorizationId, amount);
    if (a.status === "VOIDED") throw new Error("AUTHORIZATION_VOIDED");
    if (amount > a.amount + 1e-9) throw new Error("AMOUNT_EXCEEDS_AUTHORIZATION");
    a.status = "CAPTURED";
    return { captureId: id("CAP"), status: "COMPLETED" };
  }

  async voidAuthorization(authorizationId: string) {
    const a = this.auth(authorizationId, Infinity);
    if (a.status === "CAPTURED") throw new Error("AUTHORIZATION_ALREADY_CAPTURED");
    a.status = "VOIDED";
  }

  async reauthorize(authorizationId: string) {
    return { authorizationId, expiresAt: expiry() };
  }

  async createPayout() {
    return { payoutBatchId: id("PB"), status: "SUCCESS" };
  }

  async verifyWebhook() {
    return true;
  }

  disputes = new Map<string, PayPalDispute & { evidence: string[] }>();
  /** Simulates a buyer opening a PayPal dispute against a capture (demo/test only). */
  simulateDispute(captureId: string, amount: number, currency: string, reason = "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED") {
    const d = { id: id("PP-D-"), status: "WAITING_FOR_SELLER_RESPONSE", reason, amount, currency, transactionIds: [captureId], evidence: [] as string[] };
    this.disputes.set(d.id, d);
    return d.id;
  }

  async getDispute(disputeId: string) {
    const d = this.disputes.get(disputeId);
    if (!d) throw new Error("DISPUTE_NOT_FOUND");
    return d;
  }

  async provideEvidence(disputeId: string, evidence: { notes: string }) {
    const d = this.disputes.get(disputeId);
    if (!d) throw new Error("DISPUTE_NOT_FOUND");
    d.evidence.push(evidence.notes);
    d.status = "UNDER_REVIEW";
  }
}
