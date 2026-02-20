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
		if (this._closed) return;
		this._closed = true;
		this._readyState = SharedWebSocket.CLOSED;
		this._lockAbort.abort();
		this._channel.close();
	}
}
