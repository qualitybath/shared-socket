# shared-socket Design

Drop-in WebSocket API replacement that uses leader election to maintain a single connection across browser tabs. All tabs receive events and can send messages through the shared connection.

## Public API

`SharedWebSocket` mimics the native `WebSocket` interface:

```ts
class SharedWebSocket extends EventTarget {
  constructor(url: string | URL, protocols?: string | string[])

  // Read-only properties
  readonly url: string
  readonly readyState: number        // eventually consistent with real connection
  readonly protocol: string          // negotiated protocol, synced from leader
  readonly extensions: string        // always '' in v1
  readonly bufferedAmount: number    // always 0 in v1
  binaryType: BinaryType             // accepted but ignored in v1

  // Event handlers
  onopen: ((ev: Event) => void) | null
  onmessage: ((ev: MessageEvent) => void) | null
  onerror: ((ev: Event) => void) | null
  onclose: ((ev: CloseEvent) => void) | null

  // Methods
  send(data: string): void           // throws if readyState !== OPEN
  close(code?: number, reason?: string): void  // per-instance only

  // Static constants
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
}
```

Each instance is independent. Multiple instances to the same URL in the same tab both work -- they each enter the lock queue and receive events independently.

## Architecture

Standalone library using Web Locks API + BroadcastChannel directly. No dependencies on tab-election or tab-link.

### Leader Election

Each instance requests an exclusive Web Lock named `shared-socket:${url}`. The browser queues these -- only one wins at a time. The winner creates the real WebSocket and holds the lock via an unresolved promise until `close()` or tab death.

### Cross-Tab Protocol

BroadcastChannel named `shared-socket:${url}`. All instances for a given URL listen on the same channel.

```ts
type ChannelMessage =
  // Leader -> all followers
  | { type: 'open'; protocol: string; extensions: string }
  | { type: 'message'; data: string }
  | { type: 'error' }
  | { type: 'close'; code: number; reason: string; wasClean: boolean }

  // Follower -> leader
  | { type: 'send'; data: string; instanceId: string }

  // New leader -> all followers (on takeover)
  | { type: 'connecting' }

  // Any follower -> leader (on join)
  | { type: 'requestState'; instanceId: string }

  // Leader -> specific follower (response to requestState)
  | { type: 'state'; readyState: number; protocol: string; to: string }
```

## Flows

### Leader Transition

1. Leader tab dies -> browser releases lock
2. Next instance wins lock, becomes leader
3. New leader broadcasts `{ type: 'connecting' }` -- all followers set readyState to CONNECTING
4. New leader creates native WebSocket to same URL with same protocols
5. On open -> broadcasts `{ type: 'open' }` -- all followers set readyState to OPEN and fire onopen

### Late Joiner

1. New instance enters lock queue, starts listening on BroadcastChannel
2. Sends `{ type: 'requestState', instanceId }` to leader
3. Leader responds with current readyState and protocol
4. If readyState is OPEN, the new instance fires onopen locally

### send()

- Leader: calls `ws.send(data)` directly on the real WebSocket
- Follower: broadcasts `{ type: 'send', data, instanceId }` -- leader picks it up and forwards to real WebSocket

### close() (Per-Instance)

- Fires local onclose event, sets readyState to CLOSED
- Stops listening on BroadcastChannel
- If leader: closes real WebSocket, releases lock (resolves keepLock promise)
- If follower: aborts lock queue entry via AbortController
- Close is NOT broadcast -- only affects the calling instance

## Error Handling

- `send()` throws `DOMException` with `InvalidStateError` if readyState !== OPEN
- Leader's WebSocket onerror -> broadcasts `{ type: 'error' }` to all followers
- BroadcastChannel `InvalidStateError` -> recreate channel transparently
- Follower send() while leader transitioning -> message lost (matches native WS behavior)

## Constraints (v1)

- String messages only (no Blob/ArrayBuffer)
- `extensions` always empty string
- `bufferedAmount` always 0
- `binaryType` accepted but ignored

## Testing

- **Unit tests (Bun):** Mock WebSocket, BroadcastChannel, navigator.locks. Test event dispatching, readyState management, send routing, close cleanup.
- **E2E tests (Playwright):** Multi-tab scenarios -- leader election, failover, cross-tab messaging, late joiner state sync.

## Project Structure

```
shared-socket/
  src/
    index.ts              # exports SharedWebSocket
    shared-websocket.ts   # main class
    protocol.ts           # message types
  tests/
    unit/
      setup.ts
      shared-websocket.test.ts
    e2e/
      ...
  package.json
  tsconfig.json
  biome.json
```

## Stack

Matches tab-link: TypeScript with tsc, Bun test runner, Playwright for E2E, Biome for linting/formatting, Husky + lint-staged for git hooks. Zero runtime dependencies.
