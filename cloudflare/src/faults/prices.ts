// The test build's prices (docs/plans/chunk-14b-design.md, The price table): the fake model's beside the configured route's,
// and time at round numbers, so that tests read their charges at a glance.

import type { PriceTable, RoutePrices } from "@minerva/contract/internal";
import { priceTable } from "../budget/prices.ts";
import { FAKE_MODEL_ID } from "../model/fake.ts";

/** The fake model's: 1 µ$ a token, in and out. */
export const FAKE_ROUTE_PRICES: RoutePrices = { provider: "fake", model: FAKE_MODEL_ID, input: 1_000_000, cachedInput: 1_000_000, cacheWrite: 1_000_000, output: 1_000_000 };

/** 1 µ$ a millisecond of container or script time, and 1,000 µ$ a script. */
export function faultPriceTable(route: RoutePrices | null): PriceTable {
	return { routes: [...priceTable(route).routes, FAKE_ROUTE_PRICES], container: { instance: "standard-1", perHour: 3_600_000 }, script: { perScript: 1_000, perHour: 3_600_000 } };
}
