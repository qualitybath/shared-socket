import { type AnyChannelMessage, ChannelMessageType } from './protocol.js';

export class SharedWebSocket extends EventTarget {
	static readonly CONNECTING = 0 as const;
	static readonly OPEN = 1 as const;
	static readonly CLOSING = 2 as const;
	static readonly CLOSED = 3 as const;

	readonly url: string;

	private _readyState: number = SharedWebSocket.CONNECTING;
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
						const msgEv = new MessageEvent('message', {
							data: msg.data,
						});
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
						const wasConnecting =
							this._readyState === SharedWebSocket.CONNECTING;
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

	private _enterElection() {
		navigator.locks
			.request(
				`shared-socket:${this.url}`,
				{ signal: this._lockAbort.signal },
				async () => {
					if (this._closed) return;
					this._isLeader = true;
					this._broadcast({
						type: ChannelMessageType.CONNECTING,
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

	private _requestState() {
		this._broadcast({
			type: ChannelMessageType.REQUEST_STATE,
			instanceId: this._instanceId,
		});
	}

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
		this._channel.close();
	}
}
