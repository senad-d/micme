import type { SetForeground, Signal } from "./contracts.ts";

type Priority = "foreground" | "retry" | "import";
type Release = () => void;
type Waiter = { priority: Priority; signal: Signal; grant: (release: Release) => void };

/** One inference lease at a time. Background callers relinquish it after each chunk. */
export class RecognitionQueue {
	private active = false;
	private foreground = false;
	private readonly queued: Waiter[] = [];

	setForeground(active: boolean) {
		this.foreground = active;
		this.dispatch();
	}

	acquire(priority: Priority, signal: Signal): Promise<Release> {
		if (signal.aborted) return Promise.reject(signal.reason);
		return new Promise((resolve, reject) => {
			const remove = () => {
				const i = this.queued.indexOf(waiter);
				if (i >= 0) this.queued.splice(i, 1);
				reject(signal.reason);
			};
			const waiter: Waiter = { priority, signal, grant: (release) => {
				signal.removeEventListener("abort", remove);
				resolve(release);
			} };
			signal.addEventListener("abort", remove, { once: true });
			this.queued.push(waiter);
			this.dispatch();
		});
	}

	private dispatch(): void {
		if (this.active) return;
		let next = this.queued.findIndex(({ priority }) => priority === "foreground");
		if (next < 0 && !this.foreground) {
			next = this.queued.findIndex(({ priority }) => priority === "retry");
			if (next < 0 && this.queued.length) next = 0;
		}
		if (next < 0) return;
		const [waiter] = this.queued.splice(next, 1);
		if (!waiter || waiter.signal.aborted) return this.dispatch();
		this.active = true;
		let released = false;
		waiter.grant(() => {
			if (released) return;
			released = true;
			this.active = false;
			this.dispatch();
		});
	}
}

export const recognitionQueue = new RecognitionQueue();
export const setForeground: SetForeground = (active) => recognitionQueue.setForeground(active);
