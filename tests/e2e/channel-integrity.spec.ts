import { type BrowserContext, expect, type Page, test } from '@playwright/test';

/**
 * Security spec for the shared BroadcastChannel.
 *
 * These tests fail while a same-origin document that was not given the
 * application's channel token can forge channel events. They pass once:
 *
 * - `new SharedWebSocket(url, protocols, { channelToken })` keeps
 *   `channelToken` as an application-supplied secret. The library must not
 *   write that secret onto the channel, into localStorage, or into the
 *   Web Lock name. A value copied from a captured channel event must not
 *   authenticate a different event.
 * - The leader never takes readyState or protocol from a channel event,
 *   including a replay of an event the leader itself broadcast.
 * - MESSAGE, ERROR, CLOSE, OPEN, CONNECTING, STATE, and SEND events are
 *   applied or forwarded only when a holder of that socket's channelToken
 *   produced them. SEND is forwarded only onto the socket whose token
 *   matches, not onto a different URL's socket.
 *
 * `placeholder-channel-token` is an obvious placeholder, not a live secret.
 */

const TOKEN = 'placeholder-channel-token';
const OTHER_TOKEN = 'placeholder-channel-token-other';

function socketUrl(name: string) {
	return `ws://localhost:4174/${name}`;
}

async function openClient(
	context: BrowserContext,
	name: string,
	token: string = TOKEN,
): Promise<Page> {
	const page = await context.newPage();
	await page.goto('/blank.html');
	await page.evaluate(
		async ({ url, token }) => {
			const mod = await import('/index.js');
			const ws = new mod.SharedWebSocket(url, undefined, {
				channelToken: token,
			});
			const state = {
				messages: [] as string[],
				listenerMessages: [] as string[],
				events: [] as string[],
			};
			(window as unknown as { __ws: typeof ws; __state: typeof state }).__ws =
				ws;
			(window as unknown as { __state: typeof state }).__state = state;
			ws.addEventListener('message', (ev) => {
				state.listenerMessages.push(String((ev as MessageEvent).data));
			});
			ws.onopen = () => {
				state.events.push('open');
			};
			ws.onmessage = (ev) => {
				state.messages.push(String(ev.data));
				state.events.push(`message:${ev.data}`);
			};
			ws.onerror = () => {
				state.events.push('error');
			};
			ws.onclose = () => {
				state.events.push('close');
			};
		},
		{ url: socketUrl(name), token },
	);
	await expect
		.poll(
			async () =>
				page.evaluate(
					() =>
						(window as unknown as { __ws: { readyState: number } }).__ws
							.readyState,
				),
			{
				timeout: 5000,
			},
		)
		.toBe(1);
	return page;
}

async function openSpy(
	context: BrowserContext,
	names: string[],
): Promise<Page> {
	const page = await context.newPage();
	await page.goto('/blank.html');
	await page.evaluate((urls) => {
		const channels = new Map<string, BroadcastChannel>();
		const seen = new Map<string, unknown[]>();
		for (const url of urls) {
			const channel = new BroadcastChannel(`shared-socket:${url}`);
			const bucket: unknown[] = [];
			seen.set(url, bucket);
			channel.onmessage = (ev: MessageEvent) => {
				bucket.push(ev.data);
			};
			channels.set(url, channel);
		}
		(
			window as unknown as {
				__seen: Map<string, unknown[]>;
				__channels: Map<string, BroadcastChannel>;
			}
		).__seen = seen;
		(
			window as unknown as { __channels: Map<string, BroadcastChannel> }
		).__channels = channels;
	}, names.map(socketUrl));
	return page;
}

async function snapshot(page: Page) {
	return page.evaluate(() => {
		const state = (
			window as unknown as {
				__state: {
					messages: string[];
					listenerMessages: string[];
					events: string[];
				};
				__ws: { readyState: number; protocol: string };
			}
		).__state;
		const ws = (
			window as unknown as { __ws: { readyState: number; protocol: string } }
		).__ws;
		return {
			messages: [...state.messages],
			listenerMessages: [...state.listenerMessages],
			events: [...state.events],
			readyState: ws.readyState,
			protocol: ws.protocol,
		};
	});
}

async function seenEvents(spy: Page, name: string) {
	return spy.evaluate((url) => {
		const seen = (
			window as unknown as { __seen: Map<string, unknown[]> }
		).__seen.get(url);
		return seen ? seen.map((entry) => structuredClone(entry)) : [];
	}, socketUrl(name));
}

async function waitForSeen(spy: Page, name: string, needle: string) {
	await expect
		.poll(
			async () => {
				const events = await seenEvents(spy, name);
				return JSON.stringify(events).includes(needle);
			},
			{ timeout: 5000 },
		)
		.toBe(true);
}

/**
 * Post `overrides` on top of the newest observed event of the same type,
 * and copy every non-semantic field observed on the channel (so a token or
 * signature attached to a different event is replayed onto this one).
 */
async function forge(
	spy: Page,
	name: string,
	type: string,
	overrides: Record<string, unknown> = {},
) {
	return spy.evaluate(
		({ url, type, overrides }) => {
			const semantic = new Set([
				'type',
				'data',
				'protocol',
				'extensions',
				'code',
				'reason',
				'wasClean',
				'readyState',
				'to',
			]);
			const seen =
				(window as unknown as { __seen: Map<string, unknown[]> }).__seen.get(
					url,
				) ?? [];
			const sameType = seen.filter(
				(entry) =>
					!!entry &&
					typeof entry === 'object' &&
					(entry as { type?: string }).type === type,
			);
			const base: Record<string, unknown> = sameType.length
				? { ...(sameType[sameType.length - 1] as Record<string, unknown>) }
				: { type };
			for (const entry of seen) {
				if (!entry || typeof entry !== 'object') continue;
				for (const [key, value] of Object.entries(
					entry as Record<string, unknown>,
				)) {
					if (semantic.has(key)) continue;
					if (!(key in base)) base[key] = value;
				}
			}
			const forged = { ...base, ...overrides, type };
			(
				window as unknown as { __channels: Map<string, BroadcastChannel> }
			).__channels
				.get(url)
				?.postMessage(forged);
			return forged;
		},
		{ url: socketUrl(name), type, overrides },
	);
}

async function replay(spy: Page, name: string, type: string) {
	return spy.evaluate(
		({ url, type }) => {
			const seen =
				(window as unknown as { __seen: Map<string, unknown[]> }).__seen.get(
					url,
				) ?? [];
			const match = [...seen]
				.reverse()
				.find(
					(entry) =>
						!!entry &&
						typeof entry === 'object' &&
						(entry as { type?: string }).type === type,
				);
			if (!match) return null;
			(
				window as unknown as { __channels: Map<string, BroadcastChannel> }
			).__channels
				.get(url)
				?.postMessage(structuredClone(match));
			return structuredClone(match);
		},
		{ url: socketUrl(name), type },
	);
}

async function postRaw(
	spy: Page,
	name: string,
	message: Record<string, unknown>,
) {
	await spy.evaluate(
		({ url, message }) => {
			(
				window as unknown as { __channels: Map<string, BroadcastChannel> }
			).__channels
				.get(url)
				?.postMessage(message);
		},
		{ url: socketUrl(name), message },
	);
}

async function send(page: Page, data: string) {
	await page.evaluate((data) => {
		(window as unknown as { __ws: { send: (data: string) => void } }).__ws.send(
			data,
		);
	}, data);
}

async function settle() {
	await new Promise((resolve) => setTimeout(resolve, 600));
}

test.describe('shared channel integrity', () => {
	test('peers that were given the same channel token still relay a send', async ({
		context,
	}) => {
		const name = 'integrity-legit';
		const spy = await openSpy(context, [name]);
		const leader = await openClient(context, name);
		const follower = await openClient(context, name);

		await send(follower, 'legit-from-follower');

		await expect
			.poll(async () => (await snapshot(leader)).messages, { timeout: 5000 })
			.toContain('legit-from-follower');
		await expect
			.poll(async () => (await snapshot(follower)).messages, { timeout: 5000 })
			.toContain('legit-from-follower');
		await waitForSeen(spy, name, 'legit-from-follower');
	});

	test('an outsider send is not written, even when it copies observed fields and the public instance id', async ({
		context,
	}) => {
		const name = 'integrity-send';
		const spy = await openSpy(context, [name]);
		const leader = await openClient(context, name);
		const follower = await openClient(context, name);
		await send(follower, 'observed-send');
		await expect
			.poll(async () => (await snapshot(leader)).messages, { timeout: 5000 })
			.toContain('observed-send');
		await waitForSeen(spy, name, 'observed-send');

		await forge(spy, name, 'send', { data: 'forged-send-copied-fields' });
		await postRaw(spy, name, {
			type: 'send',
			data: 'forged-send-bare',
			instanceId: 'attacker-instance',
		});
		await settle();

		const leaderState = await snapshot(leader);
		const followerState = await snapshot(follower);
		expect(leaderState.messages).not.toContain('forged-send-copied-fields');
		expect(leaderState.messages).not.toContain('forged-send-bare');
		expect(followerState.messages).not.toContain('forged-send-copied-fields');
		expect(followerState.messages).not.toContain('forged-send-bare');
		expect(leaderState.messages).toContain('observed-send');
	});

	test('an outsider message event is not delivered to followers as a server frame', async ({
		context,
	}) => {
		const name = 'integrity-message';
		const spy = await openSpy(context, [name]);
		const leader = await openClient(context, name);
		const follower = await openClient(context, name);
		await send(leader, 'observed-frame');
		await expect
			.poll(async () => (await snapshot(follower)).messages, { timeout: 5000 })
			.toContain('observed-frame');
		await waitForSeen(spy, name, 'observed-frame');

		await forge(spy, name, 'message', { data: 'forged-server-frame' });
		await postRaw(spy, name, {
			type: 'message',
			data: 'forged-server-frame-bare',
		});
		await settle();

		const followerState = await snapshot(follower);
		const leaderState = await snapshot(leader);
		expect(followerState.messages).not.toContain('forged-server-frame');
		expect(followerState.messages).not.toContain('forged-server-frame-bare');
		expect(followerState.listenerMessages).not.toContain('forged-server-frame');
		expect(followerState.listenerMessages).not.toContain(
			'forged-server-frame-bare',
		);
		expect(leaderState.messages).not.toContain('forged-server-frame');
		expect(leaderState.messages).not.toContain('forged-server-frame-bare');
		expect(followerState.messages).toContain('observed-frame');
	});

	test('replaying connecting or posting close does not stall the leader, and close is not applied to a follower', async ({
		context,
	}) => {
		const name = 'integrity-close';
		const spy = await openSpy(context, [name]);
		const leader = await openClient(context, name);
		const follower = await openClient(context, name);
		await send(leader, 'before-stall');
		await waitForSeen(spy, name, 'before-stall');

		const connecting = await replay(spy, name, 'connecting');
		expect(connecting).not.toBeNull();
		await forge(spy, name, 'close', {
			code: 1000,
			reason: 'forged-close',
			wasClean: true,
		});
		await postRaw(spy, name, {
			type: 'close',
			code: 4000,
			reason: 'bare-close',
			wasClean: false,
		});
		await settle();

		const leaderState = await snapshot(leader);
		const followerState = await snapshot(follower);
		expect(leaderState.readyState).toBe(1);
		expect(followerState.readyState).toBe(1);
		expect(followerState.events).not.toContain('close');
		expect(leaderState.events).not.toContain('close');

		await send(leader, 'after-forged-close');
		await expect
			.poll(async () => (await snapshot(follower)).messages, { timeout: 5000 })
			.toContain('after-forged-close');
		expect((await snapshot(leader)).messages).toContain('after-forged-close');
	});

	test('a connecting event does not move an open leader or follower back to CONNECTING', async ({
		context,
	}) => {
		const name = 'integrity-connecting';
		const spy = await openSpy(context, [name]);
		const leader = await openClient(context, name);
		const follower = await openClient(context, name);
		await send(follower, 'before-connecting');
		await waitForSeen(spy, name, 'before-connecting');

		await forge(spy, name, 'connecting');
		await postRaw(spy, name, { type: 'connecting' });
		await settle();

		expect((await snapshot(leader)).readyState).toBe(1);
		expect((await snapshot(follower)).readyState).toBe(1);
		await send(leader, 'after-forged-connecting');
		await expect
			.poll(async () => (await snapshot(leader)).messages, { timeout: 5000 })
			.toContain('after-forged-connecting');
	});

	test('an outsider open event does not rewrite protocol or fire a second open', async ({
		context,
	}) => {
		const name = 'integrity-open';
		const spy = await openSpy(context, [name]);
		const leader = await openClient(context, name);
		const follower = await openClient(context, name);
		await send(leader, 'before-open-forge');
		await waitForSeen(spy, name, 'before-open-forge');
		const followerOpensBefore = (await snapshot(follower)).events.filter(
			(event) => event === 'open',
		).length;

		await forge(spy, name, 'open', {
			protocol: 'forged-protocol',
			extensions: 'forged-extension',
		});
		await postRaw(spy, name, {
			type: 'open',
			protocol: 'bare-forged-protocol',
			extensions: '',
		});
		await settle();

		const leaderState = await snapshot(leader);
		const followerState = await snapshot(follower);
		expect(leaderState.protocol).toBe('');
		expect(followerState.protocol).toBe('');
		expect(leaderState.readyState).toBe(1);
		expect(followerState.readyState).toBe(1);
		expect(
			followerState.events.filter((event) => event === 'open'),
		).toHaveLength(followerOpensBefore);
	});

	test('an outsider error event is not delivered to a follower', async ({
		context,
	}) => {
		const name = 'integrity-error';
		const spy = await openSpy(context, [name]);
		const leader = await openClient(context, name);
		const follower = await openClient(context, name);
		await send(leader, 'before-error');
		await waitForSeen(spy, name, 'before-error');

		await forge(spy, name, 'error');
		await postRaw(spy, name, { type: 'error' });
		await settle();

		expect((await snapshot(follower)).events).not.toContain('error');
		expect((await snapshot(leader)).events).not.toContain('error');
		expect((await snapshot(leader)).readyState).toBe(1);
	});

	test('an outsider state event does not rewrite a joined follower', async ({
		context,
	}) => {
		const name = 'integrity-state';
		const spy = await openSpy(context, [name]);
		const leader = await openClient(context, name);
		const follower = await openClient(context, name);
		await waitForSeen(spy, name, 'requestState');
		const events = await seenEvents(spy, name);
		const request = [...events]
			.reverse()
			.find(
				(entry) =>
					!!entry &&
					typeof entry === 'object' &&
					(entry as { type?: string }).type === 'requestState',
			) as { instanceId?: string } | undefined;
		expect(request?.instanceId).toBeTruthy();

		await forge(spy, name, 'state', {
			to: request?.instanceId,
			readyState: 3,
			protocol: 'forged-protocol',
		});
		await settle();

		const followerState = await snapshot(follower);
		expect(followerState.readyState).toBe(1);
		expect(followerState.protocol).toBe('');
		await send(follower, 'after-forged-state');
		await expect
			.poll(async () => (await snapshot(leader)).messages, { timeout: 5000 })
			.toContain('after-forged-state');
	});

	test('a SharedWebSocket constructed without the application token cannot write on the socket', async ({
		context,
	}) => {
		const name = 'integrity-no-token';
		const leader = await openClient(context, name);
		const intruder = await context.newPage();
		await intruder.goto('/blank.html');
		const attempt = await intruder.evaluate(async (url) => {
			const mod = await import('/index.js');
			try {
				const ws = new mod.SharedWebSocket(url);
				const opened = await new Promise<boolean>((resolve) => {
					const timer = setTimeout(() => resolve(ws.readyState === 1), 1000);
					ws.onopen = () => {
						clearTimeout(timer);
						resolve(true);
					};
				});
				let sendOutcome = 'not-called';
				try {
					ws.send('intruder-without-token');
					sendOutcome = 'called';
				} catch (error) {
					sendOutcome = `threw:${error instanceof Error ? error.name : 'unknown'}`;
				}
				return { constructed: true, opened, sendOutcome };
			} catch (error) {
				return {
					constructed: false,
					opened: false,
					sendOutcome: `constructor-threw:${error instanceof Error ? error.name : 'unknown'}`,
				};
			}
		}, socketUrl(name));
		await settle();

		expect(
			(await snapshot(leader)).messages,
			JSON.stringify(attempt),
		).not.toContain('intruder-without-token');
		await send(leader, 'leader-still-open');
		await expect
			.poll(async () => (await snapshot(leader)).messages, { timeout: 5000 })
			.toContain('leader-still-open');
	});

	test('a SharedWebSocket constructed with a different token cannot write or receive frames', async ({
		context,
	}) => {
		const name = 'integrity-wrong-token';
		const leader = await openClient(context, name);
		const follower = await openClient(context, name);
		const intruder = await context.newPage();
		await intruder.goto('/blank.html');
		await intruder.evaluate(
			async ({ url, token }) => {
				const mod = await import('/index.js');
				const ws = new mod.SharedWebSocket(url, undefined, {
					channelToken: token,
				});
				const received: string[] = [];
				(
					window as unknown as { __intruderMessages: string[] }
				).__intruderMessages = received;
				ws.addEventListener('message', (ev) => {
					received.push(String((ev as MessageEvent).data));
				});
				ws.onmessage = (ev) => {
					received.push(String(ev.data));
				};
				const opened = await new Promise<boolean>((resolve) => {
					const timer = setTimeout(() => resolve(ws.readyState === 1), 1000);
					ws.onopen = () => {
						clearTimeout(timer);
						resolve(true);
					};
				});
				(window as unknown as { __intruderOpened: boolean }).__intruderOpened =
					opened;
				try {
					ws.send('intruder-wrong-token');
				} catch {
					// readyState was not OPEN, or send was rejected locally
				}
			},
			{ url: socketUrl(name), token: OTHER_TOKEN },
		);

		await send(follower, 'private-frame');
		await expect
			.poll(async () => (await snapshot(leader)).messages, { timeout: 5000 })
			.toContain('private-frame');
		await settle();

		const intruderMessages = await intruder.evaluate(
			() =>
				(window as unknown as { __intruderMessages: string[] })
					.__intruderMessages,
		);
		expect((await snapshot(leader)).messages).not.toContain(
			'intruder-wrong-token',
		);
		expect((await snapshot(follower)).messages).not.toContain(
			'intruder-wrong-token',
		);
		expect(intruderMessages).not.toContain('private-frame');
		expect(intruderMessages).not.toContain('intruder-wrong-token');
	});

	test('a send captured on one socket is not written on a socket with a different token', async ({
		context,
	}) => {
		const nameA = 'integrity-cross-a';
		const nameB = 'integrity-cross-b';
		const spy = await openSpy(context, [nameA, nameB]);
		const leaderA = await openClient(context, nameA, TOKEN);
		const followerA = await openClient(context, nameA, TOKEN);
		const leaderB = await openClient(context, nameB, OTHER_TOKEN);
		await openClient(context, nameB, OTHER_TOKEN);

		await send(followerA, 'captured-on-a');
		await expect
			.poll(async () => (await snapshot(leaderA)).messages, { timeout: 5000 })
			.toContain('captured-on-a');
		await waitForSeen(spy, nameA, 'captured-on-a');

		const moved = await spy.evaluate(
			({ urlA, urlB }) => {
				const seen =
					(window as unknown as { __seen: Map<string, unknown[]> }).__seen.get(
						urlA,
					) ?? [];
				const sendEvent = [...seen]
					.reverse()
					.find(
						(entry) =>
							!!entry &&
							typeof entry === 'object' &&
							(entry as { type?: string }).type === 'send',
					);
				if (!sendEvent) return false;
				(
					window as unknown as { __channels: Map<string, BroadcastChannel> }
				).__channels
					.get(urlB)
					?.postMessage(structuredClone(sendEvent));
				(
					window as unknown as { __channels: Map<string, BroadcastChannel> }
				).__channels
					.get(urlB)
					?.postMessage({
						...(sendEvent as Record<string, unknown>),
						data: 'mutated-onto-b',
					});
				return true;
			},
			{ urlA: socketUrl(nameA), urlB: socketUrl(nameB) },
		);
		expect(moved).toBe(true);
		await settle();

		const socketB = await snapshot(leaderB);
		expect(socketB.messages).not.toContain('captured-on-a');
		expect(socketB.messages).not.toContain('mutated-onto-b');
		await send(leaderB, 'b-still-works');
		await expect
			.poll(async () => (await snapshot(leaderB)).messages, { timeout: 5000 })
			.toContain('b-still-works');
	});
});
