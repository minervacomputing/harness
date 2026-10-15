// The fault suites' globalSetup (vitest.faults.config.ts): waits until the deployed image starts containers
// promptly before any test starts one. A deploy that pushes a new image only starts its rollout: for a few
// minutes after it, starts may queue unplaced (seen on CI's test instance, 2026-10-15: of a dozen starts, two
// were placed in the first three minutes, and the others failed the Sandbox's 90 s readiness). A deploy pushes
// a new image when container/ changed (scripts/image.ts). So waves of prepares go through the lab until
// one wave is prepared at once, each start (a replaced one included) within PROMPT_MS; a deploy that is still
// not there after BUDGET_MS fails the suites here, with what the last wave answered, instead of failing a
// dozen tests.

import { type Answer, destroyAll, lab } from "./lab.ts";

/** As many containers as a wave: some of what the suites start at once, on several hosts. */
const WAVE = 4;
/** A start that took longer is the rollout still going (prompt ones take 1 to 15 s). */
const PROMPT_MS = 30_000;
const BUDGET_MS = 12 * 60_000;

export default async function warm(): Promise<void> {
	const started = Date.now();
	let last: unknown = null;
	for (let wave = 1; ; wave++) {
		const answers = await Promise.all(
			Array.from({ length: WAVE }, (_, i) =>
				lab("prepare", { name: `warm-${started}-${wave}-${i}` }).then(
					(answer: Answer) => answer.prepared,
					(error: unknown) => ({ ok: false, message: String(error) }),
				),
			),
		);
		// A destroy the rollout holds up stays owed to the Sandbox's alarm; the next wave's cleanup tries it again.
		await destroyAll().catch((error: unknown) => console.info(String(error)));
		if (answers.every((prepared) => prepared.ok && prepared.ms.start <= PROMPT_MS)) {
			console.info(`The deployed image starts promptly (wave ${wave}, ${Math.round((Date.now() - started) / 1000)} s).`);
			return;
		}
		last = answers;
		if (Date.now() - started > BUDGET_MS) throw new Error(`The deployed image did not start containers promptly in ${BUDGET_MS / 60_000} minutes; the last wave: ${JSON.stringify(last)}`);
		console.info(`The deployed image is not starting containers promptly yet (wave ${wave}): ${JSON.stringify(answers)}`);
	}
}
