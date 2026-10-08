/*
按稳定键串行执行异步任务，并保证单次失败不会阻断同键后续任务。
xhwsd@qq.com 2026-9-10
*/

/** 不同键可并行、同一键严格按提交顺序执行的轻量任务队列。 */
export class KeyedTaskQueue {
	private readonly tails = new Map<string, Promise<void>>();

	/** 提交任务并返回该任务自身的结果；队列尾只负责顺序和失败隔离。 */
	run<T>(key: string, operation: () => Promise<T>): Promise<T> {
		const previous = this.tails.get(key) ?? Promise.resolve();
		const queued = previous.then(operation);
		const tail = queued.then(() => undefined, () => undefined);
		this.tails.set(key, tail);
		void tail.then(() => {
			if (this.tails.get(key) === tail) {
				this.tails.delete(key);
			}
		});
		return queued;
	}
}
