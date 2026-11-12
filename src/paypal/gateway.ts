import { config, paypalMode } from "../config.js";
import { DemoPayPalGateway } from "./demo.js";
import { PayPalRestGateway } from "./rest.js";

export interface CreateOrderInput {
  referenceId: string; // milestone id
  requestId: string; // PayPal-Request-Id: same id = same order on retry
  amount: number;
  currency: string;
  description: string;
  returnUrl: string;
  cancelUrl: string;
}

export interface PayPalGateway {
  readonly mode: "sandbox" | "demo";
  /** Orders v2, intent=AUTHORIZE: funds are held, not taken. */
  createOrder(i: CreateOrderInput): Promise<{ orderId: string; approvalUrl: string }>;
  /** After buyer approval: place the authorization hold. */
  authorizeOrder(orderId: string): Promise<{ authorizationId: string; expiresAt: string | null; status: string }>;
  /** Release: capture the held authorization. */
  captureAuthorization(authorizationId: string, amount: number, currency: string, invoiceId: string):
    Promise<{ captureId: string; status: string }>;
  /** Refund before capture: void the hold; buyer is never charged. */
  voidAuthorization(authorizationId: string): Promise<void>;
  /** Re-place an expiring hold (PayPal honor period is 3 days, valid up to 29). */
  reauthorize(authorizationId: string, amount: number, currency: string): Promise<{ authorizationId: string; expiresAt: string | null }>;
  /** Payouts API: send freelancer's share to their PayPal account. */
  createPayout(i: { senderBatchId: string; receiverEmail: string; amount: number; currency: string; note: string }):
    Promise<{ payoutBatchId: string; status: string }>;
  verifyWebhook(headers: Record<string, string | string[] | undefined>, body: unknown): Promise<boolean>;
  /** Disputes API: a buyer dispute / chargeback, linked to our capture ids. */
  getDispute(disputeId: string): Promise<PayPalDispute>;
  /** Disputes API: send evidence (multipart, `input` JSON part). */
  provideEvidence(disputeId: string, evidence: { type: "PROOF_OF_FULFILLMENT" | "OTHER"; notes: string }): Promise<void>;
}

export interface PayPalDispute {
  id: string;
  status: string; // e.g. WAITING_FOR_SELLER_RESPONSE, UNDER_REVIEW, RESOLVED
  reason: string; // e.g. MERCHANDISE_OR_SERVICE_NOT_RECEIVED
  amount: number | null;
  currency: string | null;
  /** Seller-side transaction ids — for us, PayPal capture ids. */
  transactionIds: string[];
}

let instance: PayPalGateway | null = null;
export function paypal(): PayPalGateway {
  if (!instance) instance = paypalMode() === "sandbox" ? new PayPalRestGateway(config.paypal) : new DemoPayPalGateway();
  return instance;
}
/** test hook */
export function setPayPalGateway(g: PayPalGateway) { instance = g; }
