import { describe, expect, it, vi } from "vitest";
import { withRetry, TimeoutError } from "../src/billing/retry";

describe("withRetry", () => {
  it("retries a timeout and returns the second result", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new TimeoutError("slow"))
      .mockResolvedValueOnce("ok");
    await expect(withRetry(fn, { attempts: 3, baseDelayMs: 1, timeoutMs: 50 })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does not retry a card decline", async () => {
    const fn = vi.fn().mockRejectedValue({ type: "StripeCardError" });
    await expect(withRetry(fn, { attempts: 3, baseDelayMs: 1, timeoutMs: 50 })).rejects.toBeTruthy();
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
