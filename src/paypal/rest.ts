import { randomUUID } from "node:crypto";
import type { CreateOrderInput, PayPalDispute, PayPalGateway } from "./gateway.js";

type Cfg = { clientId: string; clientSecret: string; baseUrl: string; webhookId: string };

export class PayPalApiError extends Error {
  constructor(public status: number, public debugId: string | null, public body: unknown, msg: string) {
    super(msg);
  }
}

/**
 * Thin, typed client for the PayPal REST APIs used by ProofPay:
 *   - OAuth2 client-credentials
 *   - Orders v2 (create, authorize)
 *   - Payments v2 (capture / void / reauthorize authorization)
 *   - Payouts v1
 *   - Webhook signature verification
 * Every mutating call sends a PayPal-Request-Id for idempotent retries.
 */
export class PayPalRestGateway implements PayPalGateway {
  readonly mode = "sandbox" as const;
  private token: { value: string; expiresAt: number } | null = null;

  constructor(private cfg: Cfg) {}

  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt - 60_000) return this.token.value;
    const basic = Buffer.from(`${this.cfg.clientId}:${this.cfg.clientSecret}`).toString("base64");
    const res = await fetch(`${this.cfg.baseUrl}/v1/oauth2/token`, {
      method: "POST",
      headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
    });
    if (!res.ok) throw new PayPalApiError(res.status, null, await res.text(), "PayPal OAuth failed — check PAYPAL_CLIENT_ID/SECRET");
    const j: any = await res.json();
    this.token = { value: j.access_token, expiresAt: Date.now() + j.expires_in * 1000 };
    return this.token.value;
  }

  private async call<T = any>(method: string, path: string, body?: unknown, requestId?: string): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${await this.accessToken()}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    };
    if (method !== "GET") headers["PayPal-Request-Id"] = requestId ?? randomUUID();
    const res = await fetch(`${this.cfg.baseUrl}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    const parsed = text ? JSON.parse(text) : {};
    if (!res.ok) {
      const detail = parsed?.details?.[0]?.description ?? parsed?.message ?? res.statusText;
      throw new PayPalApiError(res.status, res.headers.get("paypal-debug-id"), parsed, `PayPal ${method} ${path} → ${res.status}: ${detail}`);
    }
    return parsed as T;
  }

  async createOrder(i: CreateOrderInput) {
    const order = await this.call("POST", "/v2/checkout/orders", {
      intent: "AUTHORIZE",
      purchase_units: [{
        reference_id: i.referenceId,
        custom_id: i.referenceId,
        description: i.description.slice(0, 127),
        amount: { currency_code: i.currency, value: i.amount.toFixed(2) },
      }],
      payment_source: {
        paypal: {
          experience_context: {
            brand_name: "ProofPay Escrow",
            user_action: "CONTINUE",
            shipping_preference: "NO_SHIPPING",
            return_url: i.returnUrl,
            cancel_url: i.cancelUrl,
          },
        },
      },
    }, i.requestId);
    const link = (order.links ?? []).find((l: any) => l.rel === "payer-action" || l.rel === "approve");
    if (!link) throw new Error("PayPal order has no approval link");
    return { orderId: order.id as string, approvalUrl: link.href as string };
  }

  async authorizeOrder(orderId: string) {
    const r = await this.call("POST", `/v2/checkout/orders/${orderId}/authorize`, {}, `auth-${orderId}`);
    const a = r.purchase_units?.[0]?.payments?.authorizations?.[0];
    if (!a) throw new Error("Authorize returned no authorization");
    return { authorizationId: a.id as string, expiresAt: (a.expiration_time as string) ?? null, status: a.status as string };
  }

  async captureAuthorization(authorizationId: string, amount: number, currency: string, invoiceId: string) {
    const r = await this.call("POST", `/v2/payments/authorizations/${authorizationId}/capture`, {
      amount: { currency_code: currency, value: amount.toFixed(2) },
      invoice_id: invoiceId,
      final_capture: true,
      note_to_payer: "Released by ProofPay after verified delivery",
    }, `cap-${authorizationId}`);
    return { captureId: r.id as string, status: r.status as string };
  }

  async voidAuthorization(authorizationId: string) {
    await this.call("POST", `/v2/payments/authorizations/${authorizationId}/void`, undefined, `void-${authorizationId}`);
  }

  async reauthorize(authorizationId: string, amount: number, currency: string) {
    const r = await this.call("POST", `/v2/payments/authorizations/${authorizationId}/reauthorize`, {
      amount: { currency_code: currency, value: amount.toFixed(2) },
    });
    return { authorizationId: r.id as string, expiresAt: (r.expiration_time as string) ?? null };
  }

  async createPayout(i: { senderBatchId: string; receiverEmail: string; amount: number; currency: string; note: string }) {
    const r = await this.call("POST", "/v1/payments/payouts", {
      sender_batch_header: {
        sender_batch_id: i.senderBatchId,
        email_subject: "You've been paid via ProofPay",
        email_message: i.note,
      },
      items: [{
        recipient_type: "EMAIL",
        receiver: i.receiverEmail,
        amount: { value: i.amount.toFixed(2), currency: i.currency },
        note: i.note,
        sender_item_id: i.senderBatchId,
      }],
    }, `payout-${i.senderBatchId}`);
    return { payoutBatchId: r.batch_header.payout_batch_id as string, status: r.batch_header.batch_status as string };
  }

  async getDispute(disputeId: string): Promise<PayPalDispute> {
    const d = await this.call("GET", `/v1/customer/disputes/${encodeURIComponent(disputeId)}`);
    return {
      id: d.dispute_id,
      status: d.status,
      reason: d.reason,
      amount: d.dispute_amount?.value != null ? Number(d.dispute_amount.value) : null,
      currency: d.dispute_amount?.currency_code ?? null,
      transactionIds: (d.disputed_transactions ?? []).map((t: any) => t.seller_transaction_id).filter(Boolean),
    };
  }

  async provideEvidence(disputeId: string, evidence: { type: "PROOF_OF_FULFILLMENT" | "OTHER"; notes: string }) {
    // multipart/form-data with a JSON part named "input"; fetch sets the boundary itself.
    const form = new FormData();
    form.append("input", new Blob([JSON.stringify({
      evidences: [{ evidence_type: evidence.type, evidence_info: {}, notes: evidence.notes.slice(0, 2000) }],
    })], { type: "application/json" }));
    const res = await fetch(`${this.cfg.baseUrl}/v1/customer/disputes/${encodeURIComponent(disputeId)}/provide-evidence`, {
      method: "POST",
      headers: { Authorization: `Bearer ${await this.accessToken()}`, "PayPal-Request-Id": `evidence-${disputeId}` },
      body: form,
    });
    if (!res.ok) {
      const body = await res.text();
      throw new PayPalApiError(res.status, res.headers.get("paypal-debug-id"), body, `PayPal provide-evidence → ${res.status}: ${body.slice(0, 300)}`);
    }
  }

  async verifyWebhook(headers: Record<string, string | string[] | undefined>, body: unknown) {
    if (!this.cfg.webhookId) return false;
    const h = (k: string) => String(headers[k] ?? "");
    const r = await this.call("POST", "/v1/notifications/verify-webhook-signature", {
      auth_algo: h("paypal-auth-algo"),
      cert_url: h("paypal-cert-url"),
      transmission_id: h("paypal-transmission-id"),
      transmission_sig: h("paypal-transmission-sig"),
      transmission_time: h("paypal-transmission-time"),
      webhook_id: this.cfg.webhookId,
      webhook_event: body,
    });
    return r.verification_status === "SUCCESS";
  }
}
