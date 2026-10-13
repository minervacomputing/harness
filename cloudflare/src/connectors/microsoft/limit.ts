// A task per item with at most `limit` running at a time, as the Microsoft connectors look up several objects
// at once: tasks start in order, the results keep the order of the items, and the first failure is the answer.
// No task starts after one failed (the call's requests are refused once it ended anyway).

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
