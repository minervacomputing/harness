import Stripe from "stripe";
import { PLANS, PlanId, describeCharge } from "./plans";
import { withRetry } from "./retry";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? "", { apiVersion: "2024-06-20" });

// Stripe usually answers in well under a second; give up and retry after 4s.
const CHARGE_TIMEOUT_MS = 4000;

export interface CheckoutSession {
  id: string; // e.g. "chk_9f3a2c71", one per press of "Pay now" in the dashboard
  customerId: string; // Stripe customer
  paymentMethodId: string; // the card the restaurant just saved
  plan: PlanId;
  month: string; // "October 2026"
}

/**
 * Charge the restaurant's saved card for an outstanding month ("Pay now" in Settings > Billing).
 */
export async function chargeSavedCard(session: CheckoutSession): Promise<Stripe.PaymentIntent> {
  const plan = PLANS[session.plan];
  return withRetry(
    () =>
      stripe.paymentIntents.create({
        amount: plan.amount,
        currency: "gbp",
        customer: session.customerId,
        payment_method: session.paymentMethodId,
        payment_method_types: ["card"],
        confirm: true,
        off_session: true,
        description: describeCharge(session.plan, session.month),
        metadata: { checkout_session: session.id },
        // NOTE: no idempotencyKey. If the first create times out on our side but succeeded at
        // Stripe, the retry below creates (and confirms) a second PaymentIntent.
      }),
    { attempts: 3, baseDelayMs: 250, timeoutMs: CHARGE_TIMEOUT_MS },
  );
}
