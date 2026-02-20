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
