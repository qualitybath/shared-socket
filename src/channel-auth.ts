const DOMAIN = 'shared-socket/v1';
const MAC_BYTES = 32;
const encoder = new TextEncoder();

export function importChannelKey(token: string): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		'raw',
		encoder.encode(token),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign', 'verify'],
	);
}

async function encodeValue(value: unknown): Promise<[string, Uint8Array]> {
	if (typeof value === 'string') return ['s', encoder.encode(value)];
	if (typeof value === 'number' || typeof value === 'boolean') {
		return [typeof value, encoder.encode(String(value))];
	}
	if (value === null) return ['null', new Uint8Array()];
	if (value instanceof ArrayBuffer)
		return ['ArrayBuffer', new Uint8Array(value)];
	if (ArrayBuffer.isView(value)) {
		return [
			value.constructor.name,
			new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
		];
	}
	if (typeof Blob !== 'undefined' && value instanceof Blob) {
		return [`Blob:${value.type}`, new Uint8Array(await value.arrayBuffer())];
	}
	throw new TypeError('Unsupported channel message value');
}

/**
 * Length-prefixed encoding of the URL and every field except `mac`, so the
 * tag binds each field (and the field set itself) to one socket URL.
 */
async function canonicalBytes(
	url: string,
	msg: Record<string, unknown>,
): Promise<Uint8Array<ArrayBuffer>> {
	const parts: Uint8Array[] = [encoder.encode(DOMAIN), encoder.encode(url)];
	for (const key of Object.keys(msg).sort()) {
		if (key === 'mac') continue;
		const [tag, bytes] = await encodeValue(msg[key]);
		parts.push(encoder.encode(key), encoder.encode(tag), bytes);
	}

	let total = 0;
	for (const part of parts) total += 4 + part.byteLength;
	const out = new Uint8Array(total);
	const view = new DataView(out.buffer);
	let offset = 0;
	for (const part of parts) {
		view.setUint32(offset, part.byteLength);
		offset += 4;
		out.set(part, offset);
		offset += part.byteLength;
	}
	return out;
}

function toBase64(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
	const binary = atob(text);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

export async function signChannelMessage<T extends object>(
	key: CryptoKey,
	url: string,
	msg: T,
): Promise<T & { mac: string }> {
	const mac = await crypto.subtle.sign(
		'HMAC',
		key,
		await canonicalBytes(url, msg as Record<string, unknown>),
	);
	return { ...msg, mac: toBase64(new Uint8Array(mac)) };
}

/** Returns the message if its tag verifies under `key` for `url`, otherwise null. */
export async function verifyChannelMessage(
	key: CryptoKey,
	url: string,
	raw: unknown,
): Promise<Record<string, unknown> | null> {
	try {
		if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
		const msg = raw as Record<string, unknown>;
		if (typeof msg.mac !== 'string') return null;
		const mac = fromBase64(msg.mac);
		if (mac.byteLength !== MAC_BYTES) return null;
		const ok = await crypto.subtle.verify(
			'HMAC',
			key,
			mac,
			await canonicalBytes(url, msg),
		);
		return ok ? msg : null;
	} catch {
		return null;
	}
}
