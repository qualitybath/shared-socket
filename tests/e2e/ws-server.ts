Bun.serve({
	port: 4174,
	fetch(req, server) {
		if (server.upgrade(req)) return;
		return new Response('OK');
	},
	websocket: {
		message(ws, message) {
			ws.send(message);
		},
	},
});
