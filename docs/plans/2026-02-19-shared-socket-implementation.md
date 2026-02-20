# shared-socket Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a drop-in WebSocket API replacement that uses Web Locks for leader election so only one tab maintains the real connection, with events broadcast to all tabs via BroadcastChannel.

**Architecture:** Each `SharedWebSocket` instance enters a Web Lock queue scoped by URL. The lock winner creates the real native WebSocket and relays all events over BroadcastChannel. Followers listen on the channel and forward `send()` requests to the leader. On leader death the next lock winner reconnects automatically.

**Tech Stack:** TypeScript (tsc), Bun (test runner + package manager), Biome (linter/formatter), Playwright (E2E), Husky + lint-staged (git hooks). Zero runtime dependencies.

**Design doc:** `docs/plans/2026-02-19-shared-socket-design.md`

---

### Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `biome.json`
- Create: `bunfig.toml`
- Create: `.husky/pre-commit`
- Create: `src/index.ts`
- Create: `tests/unit/setup.ts`

**Step 1: Create package.json**

```json
{
	"name": "shared-socket",
	"version": "0.1.0",
	"description": "Drop-in WebSocket replacement with single-connection-per-URL across browser tabs",
	"type": "module",
	"main": "dist/index.js",
	"types": "dist/index.d.ts",
	"exports": {
		".": {
			"types": "./dist/index.d.ts",
			"import": "./dist/index.js"
		}
	},
	"files": [
		"dist"
	],
	"scripts": {
		"build": "tsc",
		"typecheck": "tsc --noEmit",
		"lint": "biome check",
		"lint:fix": "biome check --write",
		"format": "biome format --write",
		"test": "bun test tests/unit",
		"test:e2e": "playwright test",
		"test:all": "bun test tests/unit && playwright test",
		"prepublishOnly": "npm run build",
		"prepare": "husky"
	},
	"keywords": [
		"websocket",
		"shared",
		"tabs",
		"leader-election",
		"broadcast-channel",
		"web-locks"
	],
	"license": "MIT",
	"devDependencies": {
		"@biomejs/biome": "^2.4.3",
		"@playwright/test": "^1.58.2",
		"husky": "^9.1.7",
		"lint-staged": "^16.2.7",
		"serve": "^14.2.5",
		"typescript": "^5.9.3"
	},
	"sideEffects": false,
	"lint-staged": {
		"*.ts": [
			"biome check --write --no-errors-on-unmatched"
		]
	}
}
```

**Step 2: Create tsconfig.json**

```json
{
	"compilerOptions": {
		"target": "ES2022",
		"module": "ESNext",
		"moduleResolution": "bundler",
		"declaration": true,
		"declarationMap": true,
		"sourceMap": true,
		"outDir": "dist",
		"rootDir": "src",
		"strict": true,
		"esModuleInterop": true,
		"skipLibCheck": true,
		"forceConsistentCasingInFileNames": true,
		"lib": ["ES2022", "DOM", "DOM.Iterable"]
	},
	"include": ["src"],
	"exclude": ["node_modules", "dist", "tests"]
}
```

**Step 3: Create biome.json**

```json
{
	"$schema": "https://biomejs.dev/schemas/2.4.3/schema.json",
	"linter": {
		"enabled": true,
		"rules": {
			"recommended": true
		}
	},
	"formatter": {
		"enabled": true,
		"indentStyle": "tab"
	},
	"javascript": {
		"formatter": {
			"quoteStyle": "single"
		}
	}
}
```

**Step 4: Create bunfig.toml**

```toml
[test]
root = "."
preload = ["./tests/unit/setup.ts"]
```

**Step 5: Create placeholder files**

`src/index.ts`:
```ts
export {};
```

`tests/unit/setup.ts`:
```ts
// Global test setup — mocks are loaded per-test as needed
```

**Step 6: Install dependencies and set up husky**

Run: `cd /Volumes/Code/Projects/comlink-tab-election/shared-socket && bun install`
Run: `cd /Volumes/Code/Projects/comlink-tab-election/shared-socket && bunx husky`

**Step 7: Create .husky/pre-commit**

```sh
bunx lint-staged
bun run typecheck
bun test tests/unit
```

**Step 8: Verify setup**

Run: `cd /Volumes/Code/Projects/comlink-tab-election/shared-socket && bun run typecheck`
Expected: No errors

Run: `cd /Volumes/Code/Projects/comlink-tab-election/shared-socket && bun test tests/unit`
Expected: 0 tests, passes

**Step 9: Commit**

```bash
git add package.json tsconfig.json biome.json bunfig.toml .husky/pre-commit src/index.ts tests/unit/setup.ts bun.lock
git commit --no-gpg-sign -m "chore: scaffold shared-socket project"
```

---

### Task 2: Protocol Types

**Files:**
- Create: `src/protocol.ts`
- Modify: `src/index.ts`

**Step 1: Write the protocol types**

`src/protocol.ts`:
```ts
export enum ChannelMessageType {
	OPEN = 'open',
	MESSAGE = 'message',
	ERROR = 'error',
	CLOSE = 'close',
	SEND = 'send',
	CONNECTING = 'connecting',
	REQUEST_STATE = 'requestState',
	STATE = 'state',
}

export interface OpenMessage {
	type: ChannelMessageType.OPEN;
	protocol: string;
	extensions: string;
}

export interface DataMessage {
	type: ChannelMessageType.MESSAGE;
	data: string;
}

export interface ErrorMessage {
	type: ChannelMessageType.ERROR;
}

export interface CloseMessage {
	type: ChannelMessageType.CLOSE;
	code: number;
	reason: string;
	wasClean: boolean;
}

export interface SendMessage {
	type: ChannelMessageType.SEND;
	data: string;
	instanceId: string;
}

export interface ConnectingMessage {
	type: ChannelMessageType.CONNECTING;
}

export interface RequestStateMessage {
	type: ChannelMessageType.REQUEST_STATE;
	instanceId: string;
}

export interface StateMessage {
	type: ChannelMessageType.STATE;
	readyState: number;
	protocol: string;
	to: string;
}

export type AnyChannelMessage =
	| OpenMessage
	| DataMessage
	| ErrorMessage
	| CloseMessage
	| SendMessage
	| ConnectingMessage
	| RequestStateMessage
	| StateMessage;
```

**Step 2: Verify typecheck**

Run: `cd /Volumes/Code/Projects/comlink-tab-election/shared-socket && bun run typecheck`
Expected: No errors

**Step 3: Commit**

```bash
git add src/protocol.ts
git commit --no-gpg-sign -m "feat: add cross-tab channel message protocol types"
```

---

### Task 3: SharedWebSocket — Skeleton with Static Properties and Constructor

**Files:**
- Create: `src/shared-websocket.ts`
- Create: `tests/unit/shared-websocket.test.ts`
- Modify: `src/index.ts`

**Step 1: Create test mock setup at top of test file**

`tests/unit/shared-websocket.test.ts` — we need mocks for WebSocket, BroadcastChannel, and navigator.locks since these don't exist in Bun's runtime. Put the mocks at the top of the test file:

```ts
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

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

	constructor(url: string | URL, public protocols?: string | string[]) {
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
		if (this.closed) throw new DOMException('Channel is closed', 'InvalidStateError');
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
	queue: new Map<string, Array<{ resolve: (lock: unknown) => void; signal?: AbortSignal }>>(),
};

const mockLocks: LockManager = {
	request: (async (name: string, optionsOrCallback: any, maybeCallback?: any) => {
		const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
		const options = typeof optionsOrCallback === 'function' ? {} : optionsOrCallback;
		const signal = options?.signal as AbortSignal | undefined;
		const ifAvailable = options?.ifAvailable as boolean | undefined;

		if (signal?.aborted) throw new DOMException('Lock request aborted', 'AbortError');

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
	(globalThis as any).navigator = { ...(globalThis as any).navigator, locks: mockLocks };
});

afterEach(() => {
	MockBroadcastChannel.reset();
	resetLocks();
	createdWebSockets = [];
});
```

**Step 2: Write failing tests for constructor and static properties**

Append to test file:

```ts
// Lazy import so mocks are in place
async function importFresh() {
	// Clear module cache to pick up current mocks
	return await import('../../src/shared-websocket.ts');
}

describe('SharedWebSocket', () => {
	test('has static readyState constants matching WebSocket', async () => {
		const { SharedWebSocket } = await importFresh();
		expect(SharedWebSocket.CONNECTING).toBe(0);
		expect(SharedWebSocket.OPEN).toBe(1);
		expect(SharedWebSocket.CLOSING).toBe(2);
		expect(SharedWebSocket.CLOSED).toBe(3);
	});

	test('constructor sets url from string', async () => {
		const { SharedWebSocket } = await importFresh();
		const ws = new SharedWebSocket('ws://example.com/chat');
		expect(ws.url).toBe('ws://example.com/chat');
		ws.close();
	});

	test('constructor sets url from URL object', async () => {
		const { SharedWebSocket } = await importFresh();
		const ws = new SharedWebSocket(new URL('ws://example.com/chat'));
		expect(ws.url).toBe('ws://example.com/chat');
		ws.close();
	});

	test('initial readyState is CONNECTING', async () => {
		const { SharedWebSocket } = await importFresh();
		const ws = new SharedWebSocket('ws://example.com/chat');
		expect(ws.readyState).toBe(0);
		ws.close();
	});

	test('initial protocol is empty string', async () => {
		const { SharedWebSocket } = await importFresh();
		const ws = new SharedWebSocket('ws://example.com/chat');
		expect(ws.protocol).toBe('');
		ws.close();
	});

	test('extensions is always empty string', async () => {
		const { SharedWebSocket } = await importFresh();
		const ws = new SharedWebSocket('ws://example.com/chat');
		expect(ws.extensions).toBe('');
		ws.close();
	});

	test('bufferedAmount is always 0', async () => {
		const { SharedWebSocket } = await importFresh();
		const ws = new SharedWebSocket('ws://example.com/chat');
		expect(ws.bufferedAmount).toBe(0);
		ws.close();
	});
});
```

**Step 3: Run tests to verify they fail**

Run: `cd /Volumes/Code/Projects/comlink-tab-election/shared-socket && bun test tests/unit`
Expected: FAIL — SharedWebSocket not exported

**Step 4: Write SharedWebSocket skeleton**

`src/shared-websocket.ts`:
```ts
export class SharedWebSocket extends EventTarget {
	static readonly CONNECTING = 0 as const;
	static readonly OPEN = 1 as const;
	static readonly CLOSING = 2 as const;
	static readonly CLOSED = 3 as const;

	readonly url: string;

	private _readyState = SharedWebSocket.CONNECTING;
	private _protocol = '';
	private _instanceId = crypto.randomUUID();
	private _isLeader = false;
	private _ws: WebSocket | null = null;
	private _channel: BroadcastChannel;
	private _lockAbort = new AbortController();
	private _relinquish: (() => void) | null = null;
	private _protocols: string | string[] | undefined;
	private _closed = false;

	onopen: ((ev: Event) => void) | null = null;
	onmessage: ((ev: MessageEvent) => void) | null = null;
	onerror: ((ev: Event) => void) | null = null;
	onclose: ((ev: CloseEvent) => void) | null = null;

	binaryType: BinaryType = 'blob';

	get readyState(): number {
		return this._readyState;
	}

	get protocol(): string {
		return this._protocol;
	}

	get extensions(): string {
		return '';
	}

	get bufferedAmount(): number {
		return 0;
	}

	constructor(url: string | URL, protocols?: string | string[]) {
		super();
		this.url = typeof url === 'string' ? url : url.toString();
		this._protocols = protocols;
		this._channel = new BroadcastChannel(`shared-socket:${this.url}`);

		this._init();
	}

	private _init() {
		this._setupChannelListener();
		this._enterElection();
		this._requestState();
	}

	private _setupChannelListener() {
		// Implemented in Task 5
	}

	private _enterElection() {
		// Implemented in Task 4
	}

	private _requestState() {
		// Implemented in Task 6
	}

	send(_data: string): void {
		// Implemented in Task 7
	}

	close(_code?: number, _reason?: string): void {
		// Minimal implementation so tests can clean up
		this._closed = true;
		this._readyState = SharedWebSocket.CLOSED;
		this._lockAbort.abort();
		this._channel.close();
	}
}
```

Update `src/index.ts`:
```ts
export { SharedWebSocket } from './shared-websocket.js';
```

**Step 5: Run tests to verify they pass**

Run: `cd /Volumes/Code/Projects/comlink-tab-election/shared-socket && bun run typecheck && bun test tests/unit`
Expected: All 6 tests PASS, typecheck clean

**Step 6: Commit**

```bash
git add src/shared-websocket.ts src/index.ts tests/unit/shared-websocket.test.ts
git commit --no-gpg-sign -m "feat: add SharedWebSocket skeleton with static constants and constructor"
```

---

### Task 4: Leader Election — Lock Acquisition and WebSocket Creation

**Files:**
- Modify: `src/shared-websocket.ts`
- Modify: `tests/unit/shared-websocket.test.ts`

**Step 1: Write failing tests for leader election**

Append to the `describe('SharedWebSocket', ...)` block:

```ts
test('first instance becomes leader and creates real WebSocket', async () => {
	const { SharedWebSocket } = await importFresh();
	const ws = new SharedWebSocket('ws://example.com/chat');
	// Allow microtask for lock acquisition
	await new Promise((r) => setTimeout(r, 10));
	expect(createdWebSockets.length).toBe(1);
	expect(createdWebSockets[0].url).toBe('ws://example.com/chat');
	ws.close();
});

test('leader fires onopen when real WebSocket opens', async () => {
	const { SharedWebSocket } = await importFresh();
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
	const { SharedWebSocket } = await importFresh();
	const ws = new SharedWebSocket('ws://example.com/chat', ['graphql-ws']);
	await new Promise((r) => setTimeout(r, 10));
	createdWebSockets[0].protocol = 'graphql-ws';
	createdWebSockets[0].simulateOpen();
	await new Promise((r) => setTimeout(r, 10));
	expect(ws.protocol).toBe('graphql-ws');
	ws.close();
});

test('leader fires onmessage for incoming messages', async () => {
	const { SharedWebSocket } = await importFresh();
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
	const { SharedWebSocket } = await importFresh();
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
	const { SharedWebSocket } = await importFresh();
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
```

**Step 2: Run tests to verify they fail**

Run: `cd /Volumes/Code/Projects/comlink-tab-election/shared-socket && bun test tests/unit`
Expected: New tests FAIL — no WebSocket created, no events fired

**Step 3: Implement leader election**

Replace the `_enterElection` method in `src/shared-websocket.ts`:

```ts
private _enterElection() {
	navigator.locks
		.request(
			`shared-socket:${this.url}`,
			{ signal: this._lockAbort.signal },
			async () => {
				if (this._closed) return;
				this._isLeader = true;
				const keepLock = new Promise<void>((resolve) => {
					this._relinquish = () => resolve();
				});
				this._createWebSocket();
				await keepLock;
			},
		)
		.catch((err) => {
			if (err instanceof DOMException && err.name === 'AbortError') return;
			throw err;
		})
		.finally(() => {
			this._isLeader = false;
			this._ws = null;
		});
}

private _createWebSocket() {
	const ws = new WebSocket(this.url, this._protocols);

	ws.onopen = () => {
		if (this._closed) return;
		this._readyState = SharedWebSocket.OPEN;
		this._protocol = ws.protocol;
		this._broadcast({
			type: ChannelMessageType.OPEN,
			protocol: ws.protocol,
			extensions: ws.extensions,
		});
		const ev = new Event('open');
		this.onopen?.(ev);
		this.dispatchEvent(ev);
	};

	ws.onmessage = (e) => {
		if (this._closed) return;
		this._broadcast({
			type: ChannelMessageType.MESSAGE,
			data: e.data,
		});
		const ev = new MessageEvent('message', { data: e.data });
		this.onmessage?.(ev);
		this.dispatchEvent(ev);
	};

	ws.onerror = () => {
		if (this._closed) return;
		this._broadcast({ type: ChannelMessageType.ERROR });
		const ev = new Event('error');
		this.onerror?.(ev);
		this.dispatchEvent(ev);
	};

	ws.onclose = (e) => {
		if (this._closed) return;
		this._readyState = SharedWebSocket.CLOSED;
		this._broadcast({
			type: ChannelMessageType.CLOSE,
			code: e.code,
			reason: e.reason,
			wasClean: e.wasClean,
		});
		const ev = new CloseEvent('close', {
			code: e.code,
			reason: e.reason,
			wasClean: e.wasClean,
		});
		this.onclose?.(ev);
		this.dispatchEvent(ev);
	};

	this._ws = ws;
}

private _broadcast(msg: AnyChannelMessage) {
	try {
		this._channel.postMessage(msg);
	} catch (err) {
		if (err instanceof DOMException && err.name === 'InvalidStateError') {
			this._channel = new BroadcastChannel(`shared-socket:${this.url}`);
			this._setupChannelListener();
			this._channel.postMessage(msg);
		} else {
			throw err;
		}
	}
}
```

Add the import at top of `src/shared-websocket.ts`:
```ts
import { type AnyChannelMessage, ChannelMessageType } from './protocol.js';
```

**Step 4: Run tests to verify they pass**

Run: `cd /Volumes/Code/Projects/comlink-tab-election/shared-socket && bun run typecheck && bun test tests/unit`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add src/shared-websocket.ts tests/unit/shared-websocket.test.ts
git commit --no-gpg-sign -m "feat: implement leader election with Web Locks and WebSocket event forwarding"
```

---

### Task 5: Channel Listener — Followers Receive Broadcast Events

**Files:**
- Modify: `src/shared-websocket.ts`
- Modify: `tests/unit/shared-websocket.test.ts`

**Step 1: Write failing tests for follower event reception**

We need a helper that creates two instances where the first becomes leader. Append:

```ts
describe('follower behavior', () => {
	test('follower receives onopen broadcast from leader', async () => {
		const { SharedWebSocket } = await importFresh();
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
		const { SharedWebSocket } = await importFresh();
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
		const { SharedWebSocket } = await importFresh();
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
		const { SharedWebSocket } = await importFresh();
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
```

**Step 2: Run tests to verify they fail**

Run: `cd /Volumes/Code/Projects/comlink-tab-election/shared-socket && bun test tests/unit`
Expected: Follower tests FAIL — no channel listener dispatching events

**Step 3: Implement channel listener**

Replace `_setupChannelListener` in `src/shared-websocket.ts`:

```ts
private _setupChannelListener() {
	this._channel.onmessage = (ev: MessageEvent) => {
		if (this._closed) return;
		const msg = ev.data as AnyChannelMessage;

		switch (msg.type) {
			case ChannelMessageType.OPEN:
				this._readyState = SharedWebSocket.OPEN;
				this._protocol = msg.protocol;
				if (!this._isLeader) {
					const openEv = new Event('open');
					this.onopen?.(openEv);
					this.dispatchEvent(openEv);
				}
				break;

			case ChannelMessageType.MESSAGE:
				if (!this._isLeader) {
					const msgEv = new MessageEvent('message', { data: msg.data });
					this.onmessage?.(msgEv);
					this.dispatchEvent(msgEv);
				}
				break;

			case ChannelMessageType.ERROR:
				if (!this._isLeader) {
					const errEv = new Event('error');
					this.onerror?.(errEv);
					this.dispatchEvent(errEv);
				}
				break;

			case ChannelMessageType.CLOSE:
				this._readyState = SharedWebSocket.CLOSED;
				if (!this._isLeader) {
					const closeEv = new CloseEvent('close', {
						code: msg.code,
						reason: msg.reason,
						wasClean: msg.wasClean,
					});
					this.onclose?.(closeEv);
					this.dispatchEvent(closeEv);
				}
				break;

			case ChannelMessageType.CONNECTING:
				this._readyState = SharedWebSocket.CONNECTING;
				break;

			case ChannelMessageType.SEND:
				if (this._isLeader && this._ws?.readyState === WebSocket.OPEN) {
					this._ws.send(msg.data);
				}
				break;

			case ChannelMessageType.REQUEST_STATE:
				if (this._isLeader) {
					this._broadcast({
						type: ChannelMessageType.STATE,
						readyState: this._readyState,
						protocol: this._protocol,
						to: msg.instanceId,
					});
				}
				break;

			case ChannelMessageType.STATE:
				if (msg.to === this._instanceId && !this._isLeader) {
					const wasConnecting = this._readyState === SharedWebSocket.CONNECTING;
					this._readyState = msg.readyState;
					this._protocol = msg.protocol;
					if (wasConnecting && msg.readyState === SharedWebSocket.OPEN) {
						const openEv = new Event('open');
						this.onopen?.(openEv);
						this.dispatchEvent(openEv);
					}
				}
				break;
		}
	};
}
```

**Step 4: Run tests to verify they pass**

Run: `cd /Volumes/Code/Projects/comlink-tab-election/shared-socket && bun run typecheck && bun test tests/unit`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add src/shared-websocket.ts tests/unit/shared-websocket.test.ts
git commit --no-gpg-sign -m "feat: implement BroadcastChannel listener for follower event reception"
```

---

### Task 6: Late Joiner State Sync

**Files:**
- Modify: `src/shared-websocket.ts`
- Modify: `tests/unit/shared-websocket.test.ts`

**Step 1: Write failing test for late joiner**

```ts
test('late joiner receives current state and fires onopen if OPEN', async () => {
	const { SharedWebSocket } = await importFresh();
	const leader = new SharedWebSocket('ws://example.com/chat');
	await new Promise((r) => setTimeout(r, 10));
	createdWebSockets[0].protocol = 'graphql-ws';
	createdWebSockets[0].simulateOpen();
	// Wait for open events to settle
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
```

**Step 2: Run tests to verify it fails**

Run: `cd /Volumes/Code/Projects/comlink-tab-election/shared-socket && bun test tests/unit`
Expected: FAIL — late joiner never gets onopen

**Step 3: Implement _requestState**

Replace `_requestState` in `src/shared-websocket.ts`:

```ts
private _requestState() {
	this._broadcast({
		type: ChannelMessageType.REQUEST_STATE,
		instanceId: this._instanceId,
	});
}
```

Note: The leader's response handler is already in `_setupChannelListener` (the `REQUEST_STATE` and `STATE` cases). The `_requestState` call in `_init` broadcasts the request. The leader's channel listener receives it and responds with current state. The follower's channel listener receives the `STATE` message and fires `onopen` if appropriate.

**Step 4: Run tests to verify they pass**

Run: `cd /Volumes/Code/Projects/comlink-tab-election/shared-socket && bun run typecheck && bun test tests/unit`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add src/shared-websocket.ts tests/unit/shared-websocket.test.ts
git commit --no-gpg-sign -m "feat: implement late joiner state sync via requestState"
```

---

### Task 7: send() — Leader Direct, Follower via Channel

**Files:**
- Modify: `src/shared-websocket.ts`
- Modify: `tests/unit/shared-websocket.test.ts`

**Step 1: Write failing tests for send**

```ts
describe('send()', () => {
	test('leader sends directly on real WebSocket', async () => {
		const { SharedWebSocket } = await importFresh();
		const ws = new SharedWebSocket('ws://example.com/chat');
		await new Promise((r) => setTimeout(r, 10));
		createdWebSockets[0].simulateOpen();
		await new Promise((r) => setTimeout(r, 10));

		ws.send('hello');
		expect((createdWebSockets[0] as MockWebSocket).sent).toEqual(['hello']);
		ws.close();
	});

	test('follower send is forwarded to leader via channel', async () => {
		const { SharedWebSocket } = await importFresh();
		const leader = new SharedWebSocket('ws://example.com/chat');
		await new Promise((r) => setTimeout(r, 10));
		createdWebSockets[0].simulateOpen();

		const follower = new SharedWebSocket('ws://example.com/chat');
		await new Promise((r) => setTimeout(r, 50));

		follower.send('from follower');
		// Allow BroadcastChannel microtask delivery
		await new Promise((r) => setTimeout(r, 10));
		expect((createdWebSockets[0] as MockWebSocket).sent).toEqual(['from follower']);

		leader.close();
		follower.close();
	});

	test('send throws InvalidStateError when not OPEN', async () => {
		const { SharedWebSocket } = await importFresh();
		const ws = new SharedWebSocket('ws://example.com/chat');
		expect(() => ws.send('hello')).toThrow();
		ws.close();
	});
});
```

**Step 2: Run tests to verify they fail**

Run: `cd /Volumes/Code/Projects/comlink-tab-election/shared-socket && bun test tests/unit`
Expected: FAIL — send is a no-op

**Step 3: Implement send()**

Replace `send` in `src/shared-websocket.ts`:

```ts
send(data: string): void {
	if (this._readyState !== SharedWebSocket.OPEN) {
		throw new DOMException(
			"Failed to execute 'send' on 'WebSocket': Still in CONNECTING state.",
			'InvalidStateError',
		);
	}

	if (this._isLeader && this._ws) {
		this._ws.send(data);
	} else {
		this._broadcast({
			type: ChannelMessageType.SEND,
			data,
			instanceId: this._instanceId,
		});
	}
}
```

**Step 4: Run tests to verify they pass**

Run: `cd /Volumes/Code/Projects/comlink-tab-election/shared-socket && bun run typecheck && bun test tests/unit`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add src/shared-websocket.ts tests/unit/shared-websocket.test.ts
git commit --no-gpg-sign -m "feat: implement send() with leader direct send and follower channel forwarding"
```

---

### Task 8: close() — Per-Instance Cleanup and Leadership Release

**Files:**
- Modify: `src/shared-websocket.ts`
- Modify: `tests/unit/shared-websocket.test.ts`

**Step 1: Write failing tests for close**

```ts
describe('close()', () => {
	test('close sets readyState to CLOSED and fires onclose', async () => {
		const { SharedWebSocket } = await importFresh();
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
		const { SharedWebSocket } = await importFresh();
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
		const { SharedWebSocket } = await importFresh();
		const leader = new SharedWebSocket('ws://example.com/chat');
		await new Promise((r) => setTimeout(r, 10));
		createdWebSockets[0].simulateOpen();

		const follower = new SharedWebSocket('ws://example.com/chat');
		await new Promise((r) => setTimeout(r, 50));

		follower.close();
		expect(leader.readyState).toBe(SharedWebSocket.OPEN);

		leader.close();
	});

	test('close on already-closed instance is a no-op', async () => {
		const { SharedWebSocket } = await importFresh();
		const ws = new SharedWebSocket('ws://example.com/chat');
		ws.close();
		// Should not throw
		ws.close();
		expect(ws.readyState).toBe(SharedWebSocket.CLOSED);
	});
});
```

**Step 2: Run tests to verify they fail**

Run: `cd /Volumes/Code/Projects/comlink-tab-election/shared-socket && bun test tests/unit`
Expected: FAIL — close doesn't fire onclose event, etc.

**Step 3: Implement full close()**

Replace `close` in `src/shared-websocket.ts`:

```ts
close(code?: number, reason?: string): void {
	if (this._closed) return;
	this._closed = true;
	this._readyState = SharedWebSocket.CLOSED;

	if (this._isLeader) {
		this._ws?.close(code, reason);
		this._ws = null;
		this._relinquish?.();
		this._relinquish = null;
	}

	this._lockAbort.abort();
	this._channel.close();

	const ev = new CloseEvent('close', {
		code: code ?? 1000,
		reason: reason ?? '',
		wasClean: true,
	});
	this.onclose?.(ev);
	this.dispatchEvent(ev);
}
```

**Step 4: Run tests to verify they pass**

Run: `cd /Volumes/Code/Projects/comlink-tab-election/shared-socket && bun run typecheck && bun test tests/unit`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add src/shared-websocket.ts tests/unit/shared-websocket.test.ts
git commit --no-gpg-sign -m "feat: implement per-instance close() with leadership release"
```

---

### Task 9: Leader Failover — New Leader Reconnects

**Files:**
- Modify: `tests/unit/shared-websocket.test.ts`

This tests that when the leader closes, a follower takes over and creates a new WebSocket. The implementation should already work from the lock queue + `_enterElection`. This task verifies the flow.

**Step 1: Write the failover test**

```ts
describe('leader failover', () => {
	test('follower becomes leader and reconnects when leader closes', async () => {
		const { SharedWebSocket } = await importFresh();
		const leader = new SharedWebSocket('ws://example.com/chat');
		await new Promise((r) => setTimeout(r, 10));
		createdWebSockets[0].simulateOpen();

		const follower = new SharedWebSocket('ws://example.com/chat');
		await new Promise((r) => setTimeout(r, 50));

		const reopened = new Promise<Event>((resolve) => {
			follower.onopen = resolve;
		});

		// Leader closes — releases lock, follower should win and reconnect
		leader.close();
		await new Promise((r) => setTimeout(r, 50));

		// A second WebSocket should have been created by the new leader
		expect(createdWebSockets.length).toBe(2);
		createdWebSockets[1].simulateOpen();
		await reopened;
		expect(follower.readyState).toBe(SharedWebSocket.OPEN);

		follower.close();
	});

	test('new leader broadcasts connecting then open', async () => {
		const { SharedWebSocket } = await importFresh();
		const leader = new SharedWebSocket('ws://example.com/chat');
		await new Promise((r) => setTimeout(r, 10));
		createdWebSockets[0].simulateOpen();

		const follower1 = new SharedWebSocket('ws://example.com/chat');
		const follower2 = new SharedWebSocket('ws://example.com/chat');
		await new Promise((r) => setTimeout(r, 50));

		const states: number[] = [];
		const originalGetter = Object.getOwnPropertyDescriptor(
			Object.getPrototypeOf(follower2),
			'readyState',
		)!.get!;

		// Track readyState changes on follower2 by watching onopen
		follower2.addEventListener('open', () => {
			states.push(follower2.readyState);
		});

		// Leader closes, follower1 becomes leader
		leader.close();
		await new Promise((r) => setTimeout(r, 50));
		createdWebSockets[1].simulateOpen();
		await new Promise((r) => setTimeout(r, 50));

		// follower2 should have gotten OPEN state
		expect(states).toContain(SharedWebSocket.OPEN);

		follower1.close();
		follower2.close();
	});
});
```

**Step 2: Run tests**

Run: `cd /Volumes/Code/Projects/comlink-tab-election/shared-socket && bun test tests/unit`

If any fail, we need to add a `connecting` broadcast when a new leader wins. Add to `_enterElection`, right after `this._isLeader = true`:

```ts
this._broadcast({ type: ChannelMessageType.CONNECTING });
```

**Step 3: Run tests to verify they pass**

Run: `cd /Volumes/Code/Projects/comlink-tab-election/shared-socket && bun run typecheck && bun test tests/unit`
Expected: All tests PASS

**Step 4: Commit**

```bash
git add src/shared-websocket.ts tests/unit/shared-websocket.test.ts
git commit --no-gpg-sign -m "feat: verify leader failover with reconnection"
```

---

### Task 10: addEventListener Support for All Events

**Files:**
- Modify: `tests/unit/shared-websocket.test.ts`

The `EventTarget` base class + our `dispatchEvent` calls should already support `addEventListener`. This task adds tests to confirm.

**Step 1: Write tests for addEventListener**

```ts
describe('addEventListener', () => {
	test('addEventListener("open") works alongside onopen', async () => {
		const { SharedWebSocket } = await importFresh();
		const ws = new SharedWebSocket('ws://example.com/chat');
		await new Promise((r) => setTimeout(r, 10));

		let handlerCalled = false;
		let listenerCalled = false;
		ws.onopen = () => { handlerCalled = true; };
		ws.addEventListener('open', () => { listenerCalled = true; });

		createdWebSockets[0].simulateOpen();
		await new Promise((r) => setTimeout(r, 10));
		expect(handlerCalled).toBe(true);
		expect(listenerCalled).toBe(true);
		ws.close();
	});

	test('addEventListener("message") receives data', async () => {
		const { SharedWebSocket } = await importFresh();
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
```

**Step 2: Run tests to verify they pass**

Run: `cd /Volumes/Code/Projects/comlink-tab-election/shared-socket && bun test tests/unit`
Expected: PASS — EventTarget already handles this

**Step 3: Commit**

```bash
git add tests/unit/shared-websocket.test.ts
git commit --no-gpg-sign -m "test: verify addEventListener works for all event types"
```

---

### Task 11: Final Lint, Typecheck, Full Test Suite

**Files:**
- Possibly minor fixes across `src/` files

**Step 1: Run full lint**

Run: `cd /Volumes/Code/Projects/comlink-tab-election/shared-socket && bun run lint`
Fix any issues reported by Biome.

**Step 2: Run typecheck**

Run: `cd /Volumes/Code/Projects/comlink-tab-election/shared-socket && bun run typecheck`
Fix any type errors.

**Step 3: Run all unit tests**

Run: `cd /Volumes/Code/Projects/comlink-tab-election/shared-socket && bun test tests/unit`
Expected: All tests PASS

**Step 4: Commit any fixes**

```bash
git add -A
git commit --no-gpg-sign -m "chore: fix lint and type issues"
```

If no fixes needed, skip this commit.
