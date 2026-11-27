import { once } from "node:events";
import { createServer } from "node:http";

const MAX_REQUEST_BYTES = 64 * 1024;

/** Test-only provider for the isolated replay; never discovers an account or stores a request. */
export async function startLocalProvider(signal) {
	signal.throwIfAborted();
	const server = createServer({ requestTimeout: 5_000, headersTimeout: 5_000 }, serve);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const base = new URL(`http://127.0.0.1:${server.address().port}/v1`);
	let closing;
	const close = () => {
		signal.removeEventListener("abort", close);
		if (!closing) {
			closing = new Promise((resolve) => server.close(resolve));
			server.closeAllConnections();
		}
		return closing;
	};
	signal.addEventListener("abort", close, { once: true });
	if (signal.aborted) {
		await close();
		signal.throwIfAborted();
	}
	return { base, close };
}

async function serve(request, response) {
	const messages = request.url === "/v1/messages";
	if (request.method !== "POST" || (!messages && request.url !== "/v1/chat/completions")) {
		request.resume();
		send(response, 404, { error: "Unknown fixture route" });
		return;
	}
	try {
		const payload = await requestJson(request);
		const prompt = messages ? payload?.system : payload?.messages?.[0]?.content;
		const user = payload?.messages?.[messages ? 0 : 1];
		if (payload?.model !== "public-replay" || payload.stream !== false || typeof prompt !== "string"
			|| user?.role !== "user" || typeof user.content !== "string" || !user.content.trim()
			|| (messages && (payload.max_tokens !== 1024 || request.headers["anthropic-version"] !== "2023-06-01"))
			|| (!messages && payload.messages[0].role !== "system")) {
			send(response, 400, { error: "Invalid public replay request" });
			return;
		}
		const text = user.content.replace(/ +([,.!?;:])/g, "$1");
		send(response, 200, messages ? { stop_reason: "end_turn", content: [{ type: "text", text }] }
			: { choices: [{ finish_reason: "stop", message: { role: "assistant", content: text } }] });
	} catch {
		if (!response.destroyed) send(response, 400, { error: "Invalid public replay request" });
	}
}

async function requestJson(request) {
	const chunks = [];
	let size = 0;
	for await (const chunk of request) {
		size += chunk.length;
		if (size > MAX_REQUEST_BYTES) return null;
		chunks.push(chunk);
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function send(response, code, body) {
	response.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(body));
}
