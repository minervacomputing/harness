// `asyncio.gather` of tasks that share an `asyncio.Semaphore(limit)`, as the Microsoft connectors look up
// several objects at once: at most `limit` run at a time, they start in order, the results keep the order
// of the items, and the first failure is the answer. Unlike gather, no task starts after one failed (gather
// leaves them running to no purpose; the call's requests are refused once it ended anyway).

export async function mapLimited<T, R>(items: readonly T[], limit: number, task: (item: T, index: number) => Promise<R>): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	let failed = false;
	const worker = async (): Promise<void> => {
		while (!failed && next < items.length) {
			const index = next++;
			try {
				results[index] = await task(items[index] as T, index);
			} catch (error) {
				failed = true;
				throw error;
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return results;
}
