import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { envFlag } from "./config.ts";
import { normalizeTranscript } from "./processes.ts";

export async function pasteOrSubmitTranscript(ctx: ExtensionContext, pi: ExtensionAPI, transcript: string) {
	const text = normalizeTranscript(transcript);
	if (!text) {
		ctx.ui.notify("No previous Micme transcript is available.", "warning");
		return;
	}

	if (envFlag("MICME_AUTO_SUBMIT")) {
		if (ctx.isIdle()) {
			pi.sendUserMessage(text);
		} else {
			pi.sendUserMessage(text, { deliverAs: "followUp" });
			ctx.ui.notify("Micme transcript queued as a follow-up message.", "info");
		}
		return;
	}

	const suffix = /\s$/.test(text) ? text : `${text} `;
	ctx.ui.pasteToEditor(suffix);
}
