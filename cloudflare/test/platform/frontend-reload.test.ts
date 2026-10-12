// What the page does when a chunk of an older build is gone (frontend/src/lib/reload.ts): one reload, then
// nothing, so a chunk that is really missing cannot loop the page.

import { afterEach, beforeAll, describe, expect, test } from "vitest";

interface Reload {
	reloadOnce(deps?: { storage?: { getItem(k: string): string | null; setItem(k: string, v: string): void } | null; now?: () => number; reload?: () => void }): boolean;
	installPreloadErrorReload(): void;
	RELOAD_WINDOW_MS: number;
}
let lib: Reload;

beforeAll(async () => {
	// @ts-expect-error The frontend is outside this project's types; the vitest alias resolves it (vitest.platform.config.ts).
	lib = (await import("@/lib/reload.ts")) as Reload;
});

function memory(initial: Record<string, string> = {}) {
	const data = new Map(Object.entries(initial));
	return {
		data,
		getItem: (k: string) => data.get(k) ?? null,
		setItem: (k: string, v: string) => void data.set(k, v),
	};
}

describe("reloadOnce", () => {
	test("reloads the first time and not again within the window", () => {
		const storage = memory();
		let reloads = 0;
		const deps = (at: number) => ({ storage, now: () => at, reload: () => void reloads++ });
		expect(lib.reloadOnce(deps(1_000_000))).toBe(true);
		expect(lib.reloadOnce(deps(1_000_000 + 5_000))).toBe(false);
		expect(lib.reloadOnce(deps(1_000_000 + lib.RELOAD_WINDOW_MS - 1))).toBe(false);
		expect(reloads).toBe(1);
	});

	test("reloads again once the window has passed, and a failure inside the new window is refused", () => {
		const storage = memory();
		let reloads = 0;
		const deps = (at: number) => ({ storage, now: () => at, reload: () => void reloads++ });
		expect(lib.reloadOnce(deps(1_000_000))).toBe(true);
		expect(lib.reloadOnce(deps(1_000_000 + lib.RELOAD_WINDOW_MS))).toBe(true);
		expect(lib.reloadOnce(deps(1_000_000 + lib.RELOAD_WINDOW_MS + 1))).toBe(false);
		expect(reloads).toBe(2);
	});

	test("a stored time in the future, or one that is not a number, does not block the reload", () => {
		for (const stored of ["not a number", "", "-5", String(9_000_000)]) {
			const storage = memory({ "minerva-preload-reload-at": stored });
			let reloads = 0;
			expect(lib.reloadOnce({ storage, now: () => 1_000_000, reload: () => void reloads++ }), stored).toBe(true);
			expect(reloads).toBe(1);
		}
	});

	test("does not reload when storage is missing or throws, because nothing could stop a loop", () => {
		let reloads = 0;
		const reload = () => void reloads++;
		expect(lib.reloadOnce({ storage: null, now: () => 1, reload })).toBe(false);
		const broken = {
			getItem: () => {
				throw new Error("denied");
			},
			setItem: () => {
				throw new Error("denied");
			},
		};
		expect(lib.reloadOnce({ storage: broken, now: () => 1, reload })).toBe(false);
		const readOnly = { getItem: () => null, setItem: () => { throw new Error("quota"); } };
		expect(lib.reloadOnce({ storage: readOnly, now: () => 1, reload })).toBe(false);
		expect(reloads).toBe(0);
	});

	test("remembers the reload before it happens, so a reload that throws does not repeat", () => {
		const storage = memory();
		expect(() =>
			lib.reloadOnce({
				storage,
				now: () => 5_000_000,
				reload: () => {
					throw new Error("blocked");
				},
			}),
		).toThrow("blocked");
		expect(storage.data.get("minerva-preload-reload-at")).toBe("5000000");
	});
});

describe("installPreloadErrorReload", () => {
	const original = Object.getOwnPropertyDescriptor(globalThis, "window");
	afterEach(() => {
		if (original) Object.defineProperty(globalThis, "window", original);
		else delete (globalThis as { window?: unknown }).window;
	});

	test("listens for vite:preloadError on the window, reloads once and leaves the event uncancelled", () => {
		const target = new EventTarget();
		const storage = memory();
		let reloads = 0;
		Object.defineProperty(globalThis, "window", {
			configurable: true,
			value: {
				addEventListener: target.addEventListener.bind(target),
				sessionStorage: storage,
				location: { reload: () => void reloads++ },
			},
		});
		lib.installPreloadErrorReload();
		const first = new Event("vite:preloadError", { cancelable: true });
		target.dispatchEvent(first);
		const second = new Event("vite:preloadError", { cancelable: true });
		target.dispatchEvent(second);
		expect(reloads).toBe(1);
		// Not cancelled: the failed import still rejects, so the router's error view shows if the reload did not help.
		expect(first.defaultPrevented).toBe(false);
		expect(second.defaultPrevented).toBe(false);
	});
});
