import {
	importChannelKey,
	signChannelMessage,
	verifyChannelMessage,
} from './channel-auth.js';
import {
	type AnyChannelMessage,
	ChannelMessageType,
	type LeaderMessage,
	type OutgoingMessage,
	type SendMessage,
	type StateMessage,
} from './protocol.js';

const MAX_PENDING_STATE_REQUESTS = 8;

export interface SharedWebSocketOptions {
	/**
	 * Secret shared by every document of the application that may use this
	 * socket. It must reach the application out of band (for example from the
	 * server, per session); every channel message is authenticated with it.
	 */
	channelToken: string;
}

function rethrowAsync(err: unknown) {
	setTimeout(() => {
		throw err;
	});
}

export class SharedWebSocket extends EventTarget {
	static readonly CONNECTING = 0 as const;
	static readonly OPEN = 1 as const;
	static readonly CLOSING = 2 as const;
	static readonly CLOSED = 3 as const;

	readonly CONNECTING = 0 as const;
	readonly OPEN = 1 as const;
	readonly CLOSING = 2 as const;
	readonly CLOSED = 3 as const;

	readonly url: string;

	private _readyState: number = SharedWebSocket.CONNECTING;
	private _protocol = '';
	private _instanceId = crypto.randomUUID();
	private _isLeader = false;
	private _ws: WebSocket | null = null;
	private _channel: BroadcastChannel;
	private _key: Promise<CryptoKey>;
	private _lockAbort = new AbortController();
	private _relinquish: (() => void) | null = null;
	private _protocols: string | string[] | undefined;
	private _closed = false;

	private _seq = 0;
	private _epoch = 0;
	private _leaderId: string | null = null;
	private _leaderEpoch = 0;
	private _leaderSeq = 0;
	private _stateNonces = new Set<string>();
	private _stateHint: string | null = null;
	private _sendSeqs = new Map<string, number>();
	private _inbox: Promise<void> = Promise.resolve();
	private _outbox: Promise<void> = Promise.resolve();

	onopen: ((this: WebSocket, ev: Event) => any) | null = null;
	onmessage: ((this: WebSocket, ev: MessageEvent) => any) | null = null;
	onerror: ((this: WebSocket, ev: Event) => any) | null = null;
	onclose: ((this: WebSocket, ev: CloseEvent) => any) | null = null;

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

	constructor(
		url: string | URL,
		protocols?: string | string[],
		options?: SharedWebSocketOptions,
	) {
		super();
		const channelToken = options?.channelToken;
		if (typeof channelToken !== 'string' || channelToken.length === 0) {
			throw new TypeError(
				"Failed to construct 'SharedWebSocket': options.channelToken must be a non-empty string.",
			);
		}
		this.url = typeof url === 'string' ? url : url.toString();
		this._protocols = protocols;
		this._key = importChannelKey(channelToken);
		this._channel = new BroadcastChannel(`shared-socket:${this.url}`);

		this._init();
	}

	private _init() {
		this._setupChannelListener();
		this._enterElection();
		this._requestState();
	}

	private _setupChannelListener() {
		this._channel.onmessage = (ev: MessageEvent) => {
			if (this._closed) return;
			const raw: unknown = ev.data;
			this._inbox = this._inbox
				.then(async () => {
					const msg = await verifyChannelMessage(
						await this._key,
						this.url,
						raw,
					);
					if (msg && !this._closed) {
						this._handleMessage(msg as unknown as AnyChannelMessage);
					}
				})
				.catch(rethrowAsync);
		};
	}

	private _handleMessage(msg: AnyChannelMessage) {
		if (
			typeof msg.instanceId !== 'string' ||
			msg.instanceId === this._instanceId ||
			!Number.isSafeInteger(msg.seq) ||
			msg.seq <= 0
		) {
			return;
		}

		switch (msg.type) {
			case ChannelMessageType.OPEN:
			case ChannelMessageType.MESSAGE:
			case ChannelMessageType.ERROR:
			case ChannelMessageType.CLOSE:
			case ChannelMessageType.CONNECTING:
				if (this._acceptFromLeader(msg)) this._applyLeaderEvent(msg);
				break;

			case ChannelMessageType.STATE:
				this._handleState(msg);
				break;

			case ChannelMessageType.SEND:
				this._handleSend(msg);
				break;

			case ChannelMessageType.REQUEST_STATE:
				if (this._isLeader && typeof msg.nonce === 'string') {
					this._broadcast({
						type: ChannelMessageType.STATE,
						epoch: this._epoch,
						readyState: this._readyState,
						protocol: this._protocol,
						to: msg.instanceId,
						nonce: msg.nonce,
					});
				}
				break;
		}
	}

	/**
	 * Accepts an event only from the current leader's term, in order, or from
	 * a newer term. The leader is its own source of truth and accepts none.
	 */
	private _acceptFromLeader(msg: LeaderMessage): boolean {
		if (this._isLeader || !Number.isFinite(msg.epoch)) return false;

		if (this._leaderId === null) {
			const hint = `${msg.instanceId}:${msg.epoch}`;
			if (hint !== this._stateHint) {
				this._stateHint = hint;
				this._requestState();
			}
			return false;
		}

		if (msg.epoch > this._leaderEpoch) {
			this._adoptLeader(msg);
			return true;
		}

		if (
			msg.instanceId !== this._leaderId ||
			msg.epoch !== this._leaderEpoch ||
			msg.seq <= this._leaderSeq
		) {
			return false;
		}
		this._leaderSeq = msg.seq;
		return true;
	}

	private _adoptLeader(msg: LeaderMessage) {
		this._leaderId = msg.instanceId;
		this._leaderEpoch = msg.epoch;
		this._leaderSeq = msg.seq;
		this._stateNonces.clear();
		this._stateHint = null;
	}

	private _applyLeaderEvent(msg: LeaderMessage) {
		switch (msg.type) {
			case ChannelMessageType.OPEN: {
				this._readyState = SharedWebSocket.OPEN;
				this._protocol = msg.protocol;
				const openEv = new Event('open');
				this.onopen?.(openEv);
				this.dispatchEvent(openEv);
				break;
			}

			case ChannelMessageType.MESSAGE: {
				const msgEv = new MessageEvent('message', {
					data: msg.data,
				});
				this.onmessage?.(msgEv);
				this.dispatchEvent(msgEv);
				break;
			}

			case ChannelMessageType.ERROR: {
				const errEv = new Event('error');
				this.onerror?.(errEv);
				this.dispatchEvent(errEv);
				break;
			}

			case ChannelMessageType.CLOSE: {
				this._readyState = SharedWebSocket.CLOSED;
				const closeEv = new CloseEvent('close', {
					code: msg.code,
					reason: msg.reason,
					wasClean: msg.wasClean,
				});
				this.onclose?.(closeEv);
				this.dispatchEvent(closeEv);
				break;
			}

			case ChannelMessageType.CONNECTING:
				this._readyState = SharedWebSocket.CONNECTING;
				break;
		}
	}

	/** Only a reply to one of this instance's own outstanding requests is applied. */
	private _handleState(msg: StateMessage) {
		if (
			this._isLeader ||
			msg.to !== this._instanceId ||
			typeof msg.nonce !== 'string' ||
			!this._stateNonces.has(msg.nonce) ||
			!Number.isFinite(msg.epoch) ||
			msg.epoch < this._leaderEpoch
		) {
			return;
		}
		if (
			msg.epoch === this._leaderEpoch &&
			(msg.instanceId !== this._leaderId || msg.seq <= this._leaderSeq)
		) {
			return;
		}

		this._adoptLeader(msg);
		const wasConnecting = this._readyState === SharedWebSocket.CONNECTING;
		this._readyState = msg.readyState;
		this._protocol = msg.protocol;
		if (wasConnecting && msg.readyState === SharedWebSocket.OPEN) {
			const openEv = new Event('open');
			this.onopen?.(openEv);
			this.dispatchEvent(openEv);
		}
	}

	/** Forwards a follower's send only if it targets this leader's current term and is new. */
	private _handleSend(msg: SendMessage) {
		if (
			!this._isLeader ||
			msg.to !== this._instanceId ||
			msg.epoch !== this._epoch ||
			typeof msg.data !== 'string'
		) {
			return;
		}
		const lastSeq = this._sendSeqs.get(msg.instanceId) ?? 0;
		if (msg.seq <= lastSeq) return;
		this._sendSeqs.set(msg.instanceId, msg.seq);

		if (this._ws?.readyState === WebSocket.OPEN) {
			this._ws.send(msg.data);
		}
	}

	private _enterElection() {
		navigator.locks
			.request(
				`shared-socket:${this.url}`,
				{ signal: this._lockAbort.signal },
				async () => {
					if (this._closed) return;
					this._isLeader = true;
					this._epoch = Math.max(Date.now(), this._leaderEpoch + 1);
					this._leaderId = this._instanceId;
					this._leaderEpoch = this._epoch;
					this._leaderSeq = 0;
					this._sendSeqs.clear();
					this._broadcast({
						type: ChannelMessageType.CONNECTING,
						epoch: this._epoch,
					});
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
				epoch: this._epoch,
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
				epoch: this._epoch,
				data: e.data,
			});
			const ev = new MessageEvent('message', { data: e.data });
			this.onmessage?.(ev);
			this.dispatchEvent(ev);
		};

		ws.onerror = () => {
			if (this._closed) return;
			this._broadcast({ type: ChannelMessageType.ERROR, epoch: this._epoch });
			const ev = new Event('error');
			this.onerror?.(ev);
			this.dispatchEvent(ev);
		};

		ws.onclose = (e) => {
			if (this._closed) return;
			this._readyState = SharedWebSocket.CLOSED;
			this._broadcast({
				type: ChannelMessageType.CLOSE,
				epoch: this._epoch,
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

	/** Signing is asynchronous, so messages are queued to keep their order. */
	private _broadcast(msg: OutgoingMessage) {
		const full = { ...msg, instanceId: this._instanceId, seq: ++this._seq };
		this._outbox = this._outbox
			.then(async () => {
				this._post(await signChannelMessage(await this._key, this.url, full));
			})
			.catch(rethrowAsync);
	}

	private _post(msg: unknown) {
		try {
			this._channel.postMessage(msg);
		} catch (err) {
			if (err instanceof DOMException && err.name === 'InvalidStateError') {
				if (this._closed) return;
				this._channel = new BroadcastChannel(`shared-socket:${this.url}`);
				this._setupChannelListener();
				this._channel.postMessage(msg);
			} else {
				throw err;
			}
		}
	}

	private _requestState() {
		const nonce = crypto.randomUUID();
		this._stateNonces.add(nonce);
		if (this._stateNonces.size > MAX_PENDING_STATE_REQUESTS) {
			const oldest = this._stateNonces.values().next().value;
			if (oldest !== undefined) this._stateNonces.delete(oldest);
		}
		this._broadcast({ type: ChannelMessageType.REQUEST_STATE, nonce });
	}

	send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
		if (this._readyState !== SharedWebSocket.OPEN) {
			throw new DOMException(
				"Failed to execute 'send' on 'WebSocket': Still in CONNECTING state.",
				'InvalidStateError',
			);
		}

		if (typeof data !== 'string') {
			throw new DOMException(
				"Failed to execute 'send' on 'SharedWebSocket': Only string data is supported in v1.",
				'InvalidStateError',
			);
		}

		if (this._isLeader && this._ws) {
			this._ws.send(data);
		} else if (this._leaderId !== null) {
			this._broadcast({
				type: ChannelMessageType.SEND,
				data,
				to: this._leaderId,
				epoch: this._leaderEpoch,
			});
		}
	}

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

		// Fire event before cleanup so handlers can still inspect state
		const ev = new CloseEvent('close', {
			code: code ?? 1000,
			reason: reason ?? '',
			wasClean: true,
		});
		this.onclose?.(ev);
		this.dispatchEvent(ev);

		this._lockAbort.abort();
		this._outbox = this._outbox.finally(() => this._channel.close());
	}
}
