import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { SharedWebSocket } from '../../src/shared-websocket.js';

// --- Mocks ---

class MockWebSocket extends EventTarget {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;

	readyState = MockWebSocket.CONNECTING;
	url: string;
	protocol = '';
	extensions = '';
	bufferedAmount = 0;
	binaryType: BinaryType = 'blob';
	onopen: ((ev: Event) => void) | null = null;
	onmessage: ((ev: MessageEvent) => void) | null = null;
	onerror: ((ev: Event) => void) | null = null;
	onclose: ((ev: CloseEvent) => void) | null = null;

	sent: string[] = [];

	constructor(
		url: string | URL,
		public protocols?: string | string[],
	) {
		super();
		this.url = typeof url === 'string' ? url : url.toString();
	}

	send(data: string) {
		this.sent.push(data);
	}

	close(_code?: number, _reason?: string) {
		this.readyState = MockWebSocket.CLOSED;
	}

	// Test helpers to simulate server events
	simulateOpen() {
		this.readyState = MockWebSocket.OPEN;
		const ev = new Event('open');
		this.onopen?.(ev);
		this.dispatchEvent(ev);
	}

	simulateMessage(data: string) {
		const ev = new MessageEvent('message', { data });
		this.onmessage?.(ev);
		this.dispatchEvent(ev);
	}

	simulateError() {
		const ev = new Event('error');
		this.onerror?.(ev);
		this.dispatchEvent(ev);
	}

	simulateClose(code = 1000, reason = '', wasClean = true) {
		this.readyState = MockWebSocket.CLOSED;
		const ev = new CloseEvent('close', { code, reason, wasClean });
		this.onclose?.(ev);
		this.dispatchEvent(ev);
	}
}

class MockBroadcastChannel extends EventTarget {
	static channels = new Map<string, Set<MockBroadcastChannel>>();

	name: string;
	onmessage: ((ev: MessageEvent) => void) | null = null;
	closed = false;

	constructor(name: string) {
		super();
		this.name = name;
		const set = MockBroadcastChannel.channels.get(name) ?? new Set();
		set.add(this);
		MockBroadcastChannel.channels.set(name, set);
	}

	postMessage(data: unknown) {
		if (this.closed)
			throw new DOMException('Channel is closed', 'InvalidStateError');
		const others = MockBroadcastChannel.channels.get(this.name);
		if (!others) return;
		for (const ch of others) {
			if (ch === this || ch.closed) continue;
			const ev = new MessageEvent('message', { data });
			queueMicrotask(() => {
				ch.onmessage?.(ev);
				ch.dispatchEvent(ev);
			});
		}
	}

	close() {
		this.closed = true;
		const set = MockBroadcastChannel.channels.get(this.name);
		set?.delete(this);
	}

	static reset() {
		MockBroadcastChannel.channels.clear();
	}
}

// Mock navigator.locks — simple exclusive lock with queue
const lockState = {
	held: new Map<string, { resolve: () => void }>(),
	queue: new Map<
		string,
		Array<{ resolve: (lock: unknown) => void; signal?: AbortSignal }>
	>(),
};

const mockLocks: LockManager = {
	request: (async (
		name: string,
		optionsOrCallback: any,
		maybeCallback?: any,
	) => {
		const callback =
			typeof optionsOrCallback === 'function'
				? optionsOrCallback
				: maybeCallback;
		const options =
			typeof optionsOrCallback === 'function' ? {} : optionsOrCallback;
		const signal = options?.signal as AbortSignal | undefined;
		const ifAvailable = options?.ifAvailable as boolean | undefined;

		if (signal?.aborted)
			throw new DOMException('Lock request aborted', 'AbortError');

		if (ifAvailable) {
			if (lockState.held.has(name)) return await callback(null);
			const release = new Promise<void>((r) => {
				lockState.held.set(name, { resolve: r });
			});
			try {
				return await callback({ name, mode: 'exclusive' });
			} finally {
				lockState.held.delete(name);
			}
		}

		if (lockState.held.has(name)) {
			await new Promise<unknown>((resolve, reject) => {
				const entry = { resolve, signal };
				const q = lockState.queue.get(name) ?? [];
				q.push(entry);
				lockState.queue.set(name, q);
				signal?.addEventListener('abort', () => {
					const queue = lockState.queue.get(name);
					if (queue) {
						const idx = queue.indexOf(entry);
						if (idx !== -1) queue.splice(idx, 1);
					}
					reject(new DOMException('Lock request aborted', 'AbortError'));
				});
			});
		}

		const releasePromise = new Promise<void>((r) => {
			lockState.held.set(name, { resolve: r });
		});

		try {
			return await callback({ name, mode: 'exclusive' });
		} finally {
			lockState.held.delete(name);
			const q = lockState.queue.get(name);
			if (q && q.length > 0) {
				const next = q.shift()!;
				next.resolve({ name, mode: 'exclusive' });
			}
		}
	}) as LockManager['request'],
	query: async () => ({ held: [], pending: [] }),
};

function resetLocks() {
	lockState.held.clear();
	lockState.queue.clear();
}

let createdWebSockets: MockWebSocket[] = [];

beforeEach(() => {
	MockBroadcastChannel.reset();
	resetLocks();
	createdWebSockets = [];
	(globalThis as any).WebSocket = class extends MockWebSocket {
		constructor(url: string | URL, protocols?: string | string[]) {
			super(url, protocols);
			createdWebSockets.push(this);
		}
	};
	(globalThis as any).WebSocket.CONNECTING = 0;
	(globalThis as any).WebSocket.OPEN = 1;
	(globalThis as any).WebSocket.CLOSING = 2;
	(globalThis as any).WebSocket.CLOSED = 3;
	(globalThis as any).BroadcastChannel = MockBroadcastChannel;
	(globalThis as any).navigator = {
		...(globalThis as any).navigator,
		locks: mockLocks,
	};
});

afterEach(() => {
	MockBroadcastChannel.reset();
	resetLocks();
	createdWebSockets = [];
});

describe('SharedWebSocket', () => {
	test('has static readyState constants matching WebSocket', () => {
		expect(SharedWebSocket.CONNECTING).toBe(0);
		expect(SharedWebSocket.OPEN).toBe(1);
		expect(SharedWebSocket.CLOSING).toBe(2);
		expect(SharedWebSocket.CLOSED).toBe(3);
	});

	test('constructor sets url from string', () => {
		const ws = new SharedWebSocket('ws://example.com/chat');
		expect(ws.url).toBe('ws://example.com/chat');
		ws.close();
	});

	test('constructor sets url from URL object', () => {
		const ws = new SharedWebSocket(new URL('ws://example.com/chat'));
		expect(ws.url).toBe('ws://example.com/chat');
		ws.close();
	});

	test('initial readyState is CONNECTING', () => {
		const ws = new SharedWebSocket('ws://example.com/chat');
		expect(ws.readyState).toBe(0);
		ws.close();
	});

	test('initial protocol is empty string', () => {
		const ws = new SharedWebSocket('ws://example.com/chat');
		expect(ws.protocol).toBe('');
		ws.close();
	});

	test('extensions is always empty string', () => {
		const ws = new SharedWebSocket('ws://example.com/chat');
		expect(ws.extensions).toBe('');
		ws.close();
	});

	test('bufferedAmount is always 0', () => {
		const ws = new SharedWebSocket('ws://example.com/chat');
		expect(ws.bufferedAmount).toBe(0);
		ws.close();
	});
});
