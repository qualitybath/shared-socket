# shared-socket

Drop-in WebSocket replacement that shares a single connection across browser tabs. Only one tab maintains the real WebSocket connection — all others send and receive through it transparently.

## Why

Every `new WebSocket(url)` opens a separate TCP connection. If a user has your app open in 5 tabs, that's 5 connections to the same server doing the same thing. `shared-socket` uses the [Web Locks API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API) to elect a single leader tab that holds the real connection, and [BroadcastChannel](https://developer.mozilla.org/en-US/docs/Web/API/BroadcastChannel) to relay events to all tabs.

## Install

```bash
npm install shared-socket
```

## Usage

Replace `WebSocket` with `SharedWebSocket` and pass a channel token (see [Security](#security)). The rest of the API is the same.

```ts
import { SharedWebSocket } from 'shared-socket';

// Instead of: const ws = new WebSocket('wss://example.com/feed');
const ws = new SharedWebSocket('wss://example.com/feed', undefined, {
  channelToken: sessionChannelToken, // supplied by your application, e.g. from the server
});

ws.onopen = () => {
  console.log('connected');
  ws.send('hello');
};

ws.onmessage = (event) => {
  console.log('received:', event.data);
};

ws.onclose = (event) => {
  console.log('closed:', event.code, event.reason);
};

ws.onerror = () => {
  console.log('error');
};
```

`addEventListener` works too:

```ts
ws.addEventListener('message', (event) => {
  console.log(event.data);
});
```

## How It Works

```
   Tab B (follower)        Tab A (leader)        Tab C (follower)
  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
  │ SharedWebSocket │    │ SharedWebSocket │    │ SharedWebSocket │
  │                 │    │                 │    │                 │
  │  onopen         │    │     Real WS     │    │  onopen         │
  │  onmessage      ├────┼──► connection ◄─┼────┤  onmessage      │
  │  onclose        │    │        │        │    │  onclose        │
  │  onerror        │    │        │        │    │  onerror        │
  └─────────────────┘    └────────┼────────┘    └─────────────────┘
   BroadcastChannel               │              BroadcastChannel
                                  │
                             ┌────▼────┐
                             │  Server │
                             └─────────┘

  events:  leader ──► all tabs
  send():  any tab ──► leader ──► server
```

1. The first tab to create a `SharedWebSocket` for a given URL acquires an exclusive [Web Lock](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API) and becomes the **leader**. It opens the real `WebSocket` connection.

2. Subsequent tabs for the same URL enter the lock queue and become **followers**. They communicate with the leader through a `BroadcastChannel`.

3. When the leader's WebSocket receives a message, it broadcasts the event to all followers. Every tab fires `onmessage`.

4. When any tab calls `send()`, the message reaches the real WebSocket — either directly (leader) or via BroadcastChannel relay (follower).

5. If the leader tab closes, the browser releases the lock. The next tab in the queue automatically becomes the new leader and reconnects.

## API

`SharedWebSocket` implements the same interface as the native [`WebSocket`](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket).

### Constructor

```ts
new SharedWebSocket(
  url: string | URL,
  protocols: string | string[] | undefined,
  options: { channelToken: string },
)
```

`options.channelToken` is required and must be a non-empty string. Every tab that should share the connection must pass the same value. The constructor throws a `TypeError` without it.

### Properties

| Property | Type | Description |
|----------|------|-------------|
| `url` | `string` | The URL passed to the constructor |
| `readyState` | `number` | Connection state (`CONNECTING`, `OPEN`, `CLOSING`, `CLOSED`) |
| `protocol` | `string` | Subprotocol selected by the server |
| `extensions` | `string` | Always `''` (v1) |
| `bufferedAmount` | `number` | Always `0` (v1) |
| `binaryType` | `BinaryType` | Accepted but ignored (v1) |

### Static Constants

```ts
SharedWebSocket.CONNECTING // 0
SharedWebSocket.OPEN       // 1
SharedWebSocket.CLOSING    // 2
SharedWebSocket.CLOSED     // 3
```

### Methods

#### `send(data: string): void`

Sends data through the WebSocket connection. Throws `DOMException` with `InvalidStateError` if `readyState` is not `OPEN`.

#### `close(code?: number, reason?: string): void`

Closes this instance only. Other tabs are unaffected. If this tab is the leader, the next tab takes over and reconnects.

### Events

| Event | Handler | Event Type | Description |
|-------|---------|------------|-------------|
| `open` | `onopen` | `Event` | Connection established |
| `message` | `onmessage` | `MessageEvent` | Message received (access data via `event.data`) |
| `error` | `onerror` | `Event` | Connection error |
| `close` | `onclose` | `CloseEvent` | Connection closed (access `code`, `reason`, `wasClean`) |

## Behavior Details

### Per-URL Isolation

Each unique URL gets its own independent shared connection. Two different URLs = two separate leader elections, two separate WebSocket connections.

```ts
const feed = new SharedWebSocket('wss://example.com/feed', undefined, options);
const chat = new SharedWebSocket('wss://example.com/chat', undefined, options);
// These are completely independent
```

### Leader Failover

When the leader tab is closed or crashes:

1. The browser releases the Web Lock
2. The next tab in the queue becomes the new leader
3. The new leader opens a fresh WebSocket connection
4. All remaining tabs receive `onopen` when the new connection is established

This happens automatically with no application code needed.

### close() is Per-Instance

Calling `close()` on one tab does not affect other tabs. If the leader calls `close()`, it releases leadership and the next tab reconnects.

```ts
// Tab A
const ws = new SharedWebSocket('wss://example.com/feed', undefined, options);
ws.close(); // Only Tab A is closed. Tab B continues normally.
```

### send() Throws When Not Connected

If `readyState` is not `OPEN`, `send()` throws an `InvalidStateError`. There is no message buffering during leader transitions.

### Late Joiners

If a tab creates a `SharedWebSocket` after the connection is already open, it receives the current state from the leader and fires `onopen` immediately.

## Security

Tabs coordinate over a `BroadcastChannel` named `shared-socket:<url>`. Any document on the same origin can open that channel, so every channel message is authenticated with HMAC-SHA256 under a key derived from `channelToken`, bound to the socket URL, and checked for freshness:

- Followers apply `open`, `message`, `error`, `close` and `connecting` events only from the current leader, in order. They accept a `state` reply only when it answers one of their own requests.
- The leader writes a follower's `send` to the real socket only if it is addressed to the leader's current term and has not been seen before.
- The leader never takes its own `readyState` or `protocol` from the channel.

`channelToken` must come from your application out of band, for example a high-entropy value issued by your server per session. Do not derive it from the URL or store it where untrusted same-origin code can read it. The library never posts it on the channel, stores it, or uses it in the lock name.

Channel messages are authenticated, not encrypted. The origin remains the trust boundary: a same-origin document can still see relayed frames on the channel, and script that can reach your page directly (for example by framing it) can use the socket as your code does. Do not treat socket messages as more trusted than your origin.

## Browser Requirements

- [Web Locks API](https://caniuse.com/web-locks) (Chrome 69+, Firefox 96+, Safari 15.4+)
- [BroadcastChannel](https://caniuse.com/broadcastchannel) (Chrome 54+, Firefox 38+, Safari 15.4+)
- [WebSocket](https://caniuse.com/websockets) (all modern browsers)
- [Web Crypto `crypto.subtle`](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto) (secure contexts, like Web Locks)

## Current Limitations (v1)

- **String messages only** — no `Blob` or `ArrayBuffer` support
- **`extensions`** always returns `''`
- **`bufferedAmount`** always returns `0`
- **`binaryType`** is accepted but ignored
- **No message buffering** during leader transitions — `send()` throws if not connected
- **`readyState`** on follower tabs is eventually consistent (synced via BroadcastChannel, not instant)

## Development

```bash
# Install dependencies
bun install

# Type check
bun run typecheck

# Run unit tests
bun test tests/unit

# Lint
bun run lint

# Build
bun run build
```

## License

MIT
