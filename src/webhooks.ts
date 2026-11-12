import { paypal } from "./paypal/gateway.js";
import * as db from "./db.js";
import * as svc from "./services/escrow.js";

/**
 * PayPal webhook receiver. Signature is verified with PayPal's verify-webhook-signature API
 * (needs PAYPAL_WEBHOOK_ID). Subscribe to: CHECKOUT.ORDER.APPROVED, PAYMENT.AUTHORIZATION.CREATED,
 * PAYMENT.AUTHORIZATION.VOIDED, PAYMENT.CAPTURE.COMPLETED, PAYMENT.CAPTURE.DENIED,
 * PAYMENT.PAYOUTSBATCH.SUCCESS, PAYMENT.PAYOUTSBATCH.DENIED,
 * CUSTOMER.DISPUTE.CREATED, CUSTOMER.DISPUTE.UPDATED, CUSTOMER.DISPUTE.RESOLVED
 */
export async function handlePayPalWebhook(headers: Record<string, any>, body: any) {
  const ok = await paypal().verifyWebhook(headers, body).catch(() => false);
  if (!ok) return { received: true, verified: false };

  const type: string = body?.event_type ?? "UNKNOWN";
  const r = body?.resource ?? {};
  let m = null;

  switch (type) {
    case "CHECKOUT.ORDER.APPROVED":
      // Buyer approved but may have closed the tab before the redirect: place the hold anyway.
      m = db.getMilestoneByOrder(r.id);
      if (m) await svc.onOrderApproved(r.id, "paypal webhook").catch(() => undefined);
      break;
    case "PAYMENT.AUTHORIZATION.CREATED":
    case "PAYMENT.AUTHORIZATION.VOIDED":
      m = db.getMilestoneByAuthorization(r.id);
      break;
    case "PAYMENT.CAPTURE.COMPLETED":
    case "PAYMENT.CAPTURE.DENIED":
      m = db.getMilestoneByCapture(r.id) ?? db.getMilestoneByAuthorization(r.supplementary_data?.related_ids?.authorization_id ?? "");
      break;
    case "CUSTOMER.DISPUTE.CREATED":
    case "CUSTOMER.DISPUTE.UPDATED":
    case "CUSTOMER.DISPUTE.RESOLVED": {
      // A buyer disputed a payment with PayPal. Match it to a milestone and answer with the verification record.
      const disputeId = r.dispute_id ?? r.id;
      const out = disputeId ? await svc.onPayPalDispute(disputeId).catch((e) => ({ matched: false, error: (e as Error).message })) : { matched: false };
      return { received: true, verified: true, type, ...out };
    }
    default:
      break;
  }
  if (m) {
    db.logEvent({ escrowId: m.escrowId, milestoneId: m.id, type: `WEBHOOK_${type}`, actor: "paypal", amount: null,
      message: `PayPal webhook ${type} (${body.id})`, data: { resourceId: r.id, status: r.status } });
  }
  return { received: true, verified: true, type, matched: !!m };
}
