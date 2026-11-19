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

/** Fields every channel message carries: its sender and the sender's message counter. */
interface Envelope {
	instanceId: string;
	seq: number;
}

/** Fields of messages only the leader produces. `epoch` identifies one leadership term. */
interface LeaderEnvelope extends Envelope {
	epoch: number;
}

export interface OpenMessage extends LeaderEnvelope {
	type: ChannelMessageType.OPEN;
	protocol: string;
	extensions: string;
}

export interface DataMessage extends LeaderEnvelope {
	type: ChannelMessageType.MESSAGE;
	data: string;
}

export interface ErrorMessage extends LeaderEnvelope {
	type: ChannelMessageType.ERROR;
}

export interface CloseMessage extends LeaderEnvelope {
	type: ChannelMessageType.CLOSE;
	code: number;
	reason: string;
	wasClean: boolean;
}

export interface ConnectingMessage extends LeaderEnvelope {
	type: ChannelMessageType.CONNECTING;
}

export interface StateMessage extends LeaderEnvelope {
	type: ChannelMessageType.STATE;
	readyState: number;
	protocol: string;
	to: string;
	nonce: string;
}

/** Sent by a follower to the leader identified by `to` and `epoch`. */
export interface SendMessage extends Envelope {
	type: ChannelMessageType.SEND;
	data: string;
	to: string;
	epoch: number;
}

export interface RequestStateMessage extends Envelope {
	type: ChannelMessageType.REQUEST_STATE;
	nonce: string;
}

export type LeaderMessage =
	| OpenMessage
	| DataMessage
	| ErrorMessage
	| CloseMessage
	| ConnectingMessage
	| StateMessage;

export type AnyChannelMessage =
	| LeaderMessage
	| SendMessage
	| RequestStateMessage;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
	? Omit<T, K>
	: never;

/** A message before the sender fills in its envelope fields. */
export type OutgoingMessage = DistributiveOmit<
	AnyChannelMessage,
	'instanceId' | 'seq'
>;
