// Prices in pence, GBP, VAT included. Keep in sync with the Pricing page in the wiki and Stripe prices.
export type PlanId = "starter" | "pro" | "annual_pro";

export const PLANS: Record<PlanId, { name: string; amount: number; interval: "month" | "year"; lookupKey: string }> = {
  starter: { name: "Tably Starter", amount: 2900, interval: "month", lookupKey: "tably_starter_monthly" },
  pro: { name: "Tably Pro", amount: 7900, interval: "month", lookupKey: "tably_pro_monthly" },
  annual_pro: { name: "Tably Pro", amount: 79000, interval: "year", lookupKey: "tably_pro_annual" },
};

export function describeCharge(plan: PlanId, month: string): string {
  return `${PLANS[plan].name} — ${month}`;
}
