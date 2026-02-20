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
			const _release = new Promise<void>((r) => {
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

		const _releasePromise = new Promise<void>((r) => {
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

	test('first instance becomes leader and creates real WebSocket', async () => {
		const ws = new SharedWebSocket('ws://example.com/chat');
		await new Promise((r) => setTimeout(r, 10));
		expect(createdWebSockets.length).toBe(1);
		expect(createdWebSockets[0].url).toBe('ws://example.com/chat');
		ws.close();
	});

	test('leader fires onopen when real WebSocket opens', async () => {
		const ws = new SharedWebSocket('ws://example.com/chat');
		const opened = new Promise<Event>((resolve) => {
			ws.onopen = resolve;
		});
		await new Promise((r) => setTimeout(r, 10));
		createdWebSockets[0].simulateOpen();
		const ev = await opened;
		expect(ev.type).toBe('open');
		expect(ws.readyState).toBe(SharedWebSocket.OPEN);
		ws.close();
	});

	test('leader forwards protocol from real WebSocket on open', async () => {
		const ws = new SharedWebSocket('ws://example.com/chat', ['graphql-ws']);
		await new Promise((r) => setTimeout(r, 10));
		createdWebSockets[0].protocol = 'graphql-ws';
		createdWebSockets[0].simulateOpen();
		await new Promise((r) => setTimeout(r, 10));
		expect(ws.protocol).toBe('graphql-ws');
		ws.close();
	});

	test('leader fires onmessage for incoming messages', async () => {
		const ws = new SharedWebSocket('ws://example.com/chat');
		await new Promise((r) => setTimeout(r, 10));
		createdWebSockets[0].simulateOpen();
		const msg = new Promise<MessageEvent>((resolve) => {
			ws.onmessage = resolve;
		});
		createdWebSockets[0].simulateMessage('hello');
		const ev = await msg;
		expect(ev.data).toBe('hello');
		ws.close();
	});

	test('leader fires onerror on WebSocket error', async () => {
		const ws = new SharedWebSocket('ws://example.com/chat');
		await new Promise((r) => setTimeout(r, 10));
		createdWebSockets[0].simulateOpen();
		const errored = new Promise<Event>((resolve) => {
			ws.onerror = resolve;
		});
		createdWebSockets[0].simulateError();
		const ev = await errored;
		expect(ev.type).toBe('error');
		ws.close();
	});

	test('leader fires onclose on WebSocket close', async () => {
		const ws = new SharedWebSocket('ws://example.com/chat');
		await new Promise((r) => setTimeout(r, 10));
		createdWebSockets[0].simulateOpen();
		const closed = new Promise<CloseEvent>((resolve) => {
			ws.onclose = resolve;
		});
		createdWebSockets[0].simulateClose(1000, 'bye', true);
		const ev = await closed;
		expect(ev.code).toBe(1000);
		expect(ev.reason).toBe('bye');
		expect(ws.readyState).toBe(SharedWebSocket.CLOSED);
		ws.close();
	});

	describe('follower behavior', () => {
		test('follower receives onopen broadcast from leader', async () => {
			const leader = new SharedWebSocket('ws://example.com/chat');
			await new Promise((r) => setTimeout(r, 10));

			const follower = new SharedWebSocket('ws://example.com/chat');
			const opened = new Promise<Event>((resolve) => {
				follower.onopen = resolve;
			});

			createdWebSockets[0].simulateOpen();
			await opened;
			expect(follower.readyState).toBe(SharedWebSocket.OPEN);

			leader.close();
			follower.close();
		});

		test('follower receives onmessage broadcast from leader', async () => {
			const leader = new SharedWebSocket('ws://example.com/chat');
			await new Promise((r) => setTimeout(r, 10));
			createdWebSockets[0].simulateOpen();

			const follower = new SharedWebSocket('ws://example.com/chat');
			await new Promise((r) => setTimeout(r, 10));

			const msg = new Promise<MessageEvent>((resolve) => {
				follower.onmessage = resolve;
			});
			createdWebSockets[0].simulateMessage('hello from server');
			await msg.then((ev) => {
				expect(ev.data).toBe('hello from server');
			});

			leader.close();
			follower.close();
		});

		test('follower receives onerror broadcast from leader', async () => {
			const leader = new SharedWebSocket('ws://example.com/chat');
			await new Promise((r) => setTimeout(r, 10));
			createdWebSockets[0].simulateOpen();

			const follower = new SharedWebSocket('ws://example.com/chat');
			await new Promise((r) => setTimeout(r, 10));

			const errored = new Promise<Event>((resolve) => {
				follower.onerror = resolve;
			});
			createdWebSockets[0].simulateError();
			await errored.then((ev) => {
				expect(ev.type).toBe('error');
			});

			leader.close();
			follower.close();
		});

		test('follower receives onclose broadcast from leader', async () => {
			const leader = new SharedWebSocket('ws://example.com/chat');
			await new Promise((r) => setTimeout(r, 10));
			createdWebSockets[0].simulateOpen();

			const follower = new SharedWebSocket('ws://example.com/chat');
			await new Promise((r) => setTimeout(r, 10));

			const closed = new Promise<CloseEvent>((resolve) => {
				follower.onclose = resolve;
			});
			createdWebSockets[0].simulateClose(1001, 'going away', false);
			await closed.then((ev) => {
				expect(ev.code).toBe(1001);
				expect(ev.reason).toBe('going away');
				expect(ev.wasClean).toBe(false);
			});

			leader.close();
			follower.close();
		});
	});

	test('late joiner receives current state and fires onopen if OPEN', async () => {
		const leader = new SharedWebSocket('ws://example.com/chat');
		await new Promise((r) => setTimeout(r, 10));
		createdWebSockets[0].protocol = 'graphql-ws';
		createdWebSockets[0].simulateOpen();
		await new Promise((r) => setTimeout(r, 10));

		const lateComer = new SharedWebSocket('ws://example.com/chat');
		const opened = new Promise<Event>((resolve) => {
			lateComer.onopen = resolve;
		});
		await opened;
		expect(lateComer.readyState).toBe(SharedWebSocket.OPEN);
		expect(lateComer.protocol).toBe('graphql-ws');

		leader.close();
		lateComer.close();
	});

	describe('send()', () => {
		test('leader sends directly on real WebSocket', async () => {
			const ws = new SharedWebSocket('ws://example.com/chat');
			await new Promise((r) => setTimeout(r, 10));
			createdWebSockets[0].simulateOpen();
			await new Promise((r) => setTimeout(r, 10));

			ws.send('hello');
			expect((createdWebSockets[0] as MockWebSocket).sent).toEqual(['hello']);
			ws.close();
		});

		test('follower send is forwarded to leader via channel', async () => {
			const leader = new SharedWebSocket('ws://example.com/chat');
			await new Promise((r) => setTimeout(r, 10));
			createdWebSockets[0].simulateOpen();

			const follower = new SharedWebSocket('ws://example.com/chat');
			await new Promise((r) => setTimeout(r, 50));

			follower.send('from follower');
			await new Promise((r) => setTimeout(r, 10));
			expect((createdWebSockets[0] as MockWebSocket).sent).toEqual([
				'from follower',
			]);

			leader.close();
			follower.close();
		});

		test('send throws InvalidStateError when not OPEN', () => {
			const ws = new SharedWebSocket('ws://example.com/chat');
			expect(() => ws.send('hello')).toThrow();
			ws.close();
		});

		test('send throws for non-string data', async () => {
			const ws = new SharedWebSocket('ws://example.com/chat');
			await new Promise((r) => setTimeout(r, 10));
			createdWebSockets[0].simulateOpen();
			await new Promise((r) => setTimeout(r, 10));

			expect(() => ws.send(new ArrayBuffer(4))).toThrow();
			expect(() => ws.send(new Blob(['hi']))).toThrow();
			ws.close();
		});
	});

	describe('close()', () => {
		test('close sets readyState to CLOSED and fires onclose', async () => {
			const ws = new SharedWebSocket('ws://example.com/chat');
			await new Promise((r) => setTimeout(r, 10));
			createdWebSockets[0].simulateOpen();
			await new Promise((r) => setTimeout(r, 10));

			const closed = new Promise<CloseEvent>((resolve) => {
				ws.onclose = resolve;
			});
			ws.close(1000, 'done');
			const ev = await closed;
			expect(ws.readyState).toBe(SharedWebSocket.CLOSED);
			expect(ev.code).toBe(1000);
			expect(ev.reason).toBe('done');
		});

		test('closing leader does not fire close on follower', async () => {
			const leader = new SharedWebSocket('ws://example.com/chat');
			await new Promise((r) => setTimeout(r, 10));
			createdWebSockets[0].simulateOpen();

			const follower = new SharedWebSocket('ws://example.com/chat');
			await new Promise((r) => setTimeout(r, 50));

			let followerCloseFired = false;
			follower.onclose = () => {
				followerCloseFired = true;
			};

			leader.close();
			await new Promise((r) => setTimeout(r, 50));
			expect(followerCloseFired).toBe(false);

			follower.close();
		});

		test('closing follower does not affect leader', async () => {
			const leader = new SharedWebSocket('ws://example.com/chat');
			await new Promise((r) => setTimeout(r, 10));
			createdWebSockets[0].simulateOpen();

			const follower = new SharedWebSocket('ws://example.com/chat');
			await new Promise((r) => setTimeout(r, 50));

			follower.close();
			expect(leader.readyState).toBe(SharedWebSocket.OPEN);

			leader.close();
		});

		test('close on already-closed instance is a no-op', () => {
			const ws = new SharedWebSocket('ws://example.com/chat');
			ws.close();
			ws.close();
			expect(ws.readyState).toBe(SharedWebSocket.CLOSED);
		});
	});

	describe('leader failover', () => {
		test('follower becomes leader and reconnects when leader closes', async () => {
			const leader = new SharedWebSocket('ws://example.com/chat');
			await new Promise((r) => setTimeout(r, 10));
			createdWebSockets[0].simulateOpen();

			const follower = new SharedWebSocket('ws://example.com/chat');
			await new Promise((r) => setTimeout(r, 50));

			const reopened = new Promise<Event>((resolve) => {
				follower.onopen = resolve;
			});

			leader.close();
			await new Promise((r) => setTimeout(r, 50));

			expect(createdWebSockets.length).toBe(2);
			createdWebSockets[1].simulateOpen();
			await reopened;
			expect(follower.readyState).toBe(SharedWebSocket.OPEN);

			follower.close();
		});
	});

	describe('addEventListener', () => {
		test('addEventListener("open") works alongside onopen', async () => {
			const ws = new SharedWebSocket('ws://example.com/chat');
			await new Promise((r) => setTimeout(r, 10));

			let handlerCalled = false;
			let listenerCalled = false;
			ws.onopen = () => {
				handlerCalled = true;
			};
			ws.addEventListener('open', () => {
				listenerCalled = true;
			});

			createdWebSockets[0].simulateOpen();
			await new Promise((r) => setTimeout(r, 10));
			expect(handlerCalled).toBe(true);
			expect(listenerCalled).toBe(true);
			ws.close();
		});

		test('addEventListener("message") receives data', async () => {
			const ws = new SharedWebSocket('ws://example.com/chat');
			await new Promise((r) => setTimeout(r, 10));
			createdWebSockets[0].simulateOpen();

			const received = new Promise<string>((resolve) => {
				ws.addEventListener('message', (ev) => {
					resolve((ev as MessageEvent).data);
				});
			});
			createdWebSockets[0].simulateMessage('test data');
			expect(await received).toBe('test data');
			ws.close();
		});
	});
});
