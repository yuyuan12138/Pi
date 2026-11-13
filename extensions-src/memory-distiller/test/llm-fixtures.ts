/** Fake streamSimple factories for orchestration tests (kept out of helpers.ts so loader tests stay side-effect free). */
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { CRED_FIXTURE_TEXT } from "./helpers.js";

export { CRED_FIXTURE_TEXT };

function message(text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions" as AssistantMessage["api"],
		provider: "test",
		model: "test-model",
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } as AssistantMessage["usage"],
		stopReason,
		timestamp: Date.now(),
	};
}

export const GOOD_LLM_JSON = `[
	{"kind":"decision","claim":"The distiller writes atoms only after dedup and credential screening pass.","evidence":"after dedup","sources":[1]},
	{"kind":"preference","claim":"We prefer watermarked incremental reads so repeated runs never re-read old deltas.","evidence":"","sources":[2]}
]`;

export function fakeStreamSimpleFactory(opts?: { mode?: "good" | "garbage" | "error" }) {
	const mode = opts?.mode ?? "good";
	return () => {
		const stream = createAssistantMessageEventStream();
		if (mode === "good") stream.end(message(GOOD_LLM_JSON));
		else if (mode === "garbage") stream.end(message("no json here at all"));
		else stream.end(message(GOOD_LLM_JSON, "error"));
		return stream;
	};
}
