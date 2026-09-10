/**
 * Opt+Enter immediately interrupts the current reply when there is no pending
 * tool work. Plain Enter stays on the built-in steering path.
 *
 * Follow-up remains available via Ctrl+Q on Windows/WSL. On macOS this
 * extension takes over Alt+Enter / Option+Enter.
 */
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";

type ContentBlock = {
	type?: string;
	id?: string;
};

type SessionMessage = {
	role?: string;
	content?: string | ContentBlock[];
	toolCallId?: string;
};

const inFlightToolIds = new Set<string>();
let streamingAssistant: SessionMessage | undefined;
let delivering = false;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function messageFromEntry(entry: SessionEntry): SessionMessage | undefined {
	if (!isRecord(entry) || entry.type !== "message") return undefined;
	const message = entry.message;
	if (!isRecord(message) || typeof message.role !== "string") return undefined;
	return message as SessionMessage;
}

function toolCallIds(message: SessionMessage | undefined): string[] {
	if (!message || message.role !== "assistant" || !Array.isArray(message.content)) {
		return [];
	}
	return message.content
		.filter((block): block is ContentBlock & { id: string } => {
			return isRecord(block) && block.type === "toolCall" && typeof block.id === "string";
		})
		.map((block) => block.id);
}

function hasPendingToolCalls(ctx: ExtensionContext): boolean {
	if (inFlightToolIds.size > 0) return true;

	const completed = new Set<string>();
	const messages: SessionMessage[] = [];

	for (const entry of ctx.sessionManager.getBranch()) {
		const message = messageFromEntry(entry);
		if (message) messages.push(message);
	}
	if (streamingAssistant) messages.push(streamingAssistant);

	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (!message) continue;

		if (message.role === "toolResult" && typeof message.toolCallId === "string") {
			completed.add(message.toolCallId);
			continue;
		}

		if (message.role !== "assistant") continue;

		const ids = toolCallIds(message);
		if (ids.length === 0) return false;
		return ids.some((id) => !completed.has(id));
	}

	return false;
}

async function waitUntilIdle(ctx: ExtensionContext, timeoutMs = 15_000): Promise<void> {
	const started = Date.now();
	while (!ctx.isIdle()) {
		if (Date.now() - started > timeoutMs) {
			throw new Error("Timed out waiting for the current reply to abort");
		}
		await new Promise((resolve) => setTimeout(resolve, 30));
	}
}

function editorText(ctx: ExtensionContext): string {
	return ctx.ui.getEditorText().trim();
}

async function interruptAndSend(pi: ExtensionAPI, ctx: ExtensionContext, text: string): Promise<void> {
	if (delivering) return;
	delivering = true;
	ctx.ui.setEditorText("");
	if (ctx.hasUI) {
		ctx.ui.notify("Interrupted current reply to send immediately", "info");
	}
	try {
		ctx.abort();
		await waitUntilIdle(ctx);
		pi.sendUserMessage(text, { expandPromptTemplates: true });
	} catch (error) {
		if (ctx.hasUI) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		}
		if (!ctx.ui.getEditorText().trim()) {
			ctx.ui.setEditorText(text);
		}
	} finally {
		delivering = false;
	}
}

export default function (pi: ExtensionAPI) {
	const resetTurnState = () => {
		inFlightToolIds.clear();
		streamingAssistant = undefined;
	};

	pi.on("session_start", () => {
		delivering = false;
		resetTurnState();
	});
	pi.on("session_shutdown", () => {
		delivering = false;
		resetTurnState();
	});
	pi.on("agent_start", resetTurnState);
	pi.on("agent_end", resetTurnState);

	pi.on("tool_execution_start", (event) => {
		inFlightToolIds.add(event.toolCallId);
	});
	pi.on("tool_execution_end", (event) => {
		inFlightToolIds.delete(event.toolCallId);
	});
	pi.on("message_update", (event) => {
		if (event.message?.role === "assistant") {
			streamingAssistant = event.message as SessionMessage;
		}
	});
	pi.on("message_end", (event) => {
		if (event.message?.role === "assistant") {
			streamingAssistant = event.message as SessionMessage;
		}
	});

	pi.registerShortcut("alt+enter", {
		description: "Interrupt current reply and send immediately when no tools are pending",
		handler: async (ctx) => {
			const text = editorText(ctx);
			if (!text) return;

			if (ctx.isIdle()) {
				ctx.ui.setEditorText("");
				pi.sendUserMessage(text, { expandPromptTemplates: true });
				return;
			}

			if (hasPendingToolCalls(ctx)) {
				ctx.ui.setEditorText("");
				pi.sendUserMessage(text, {
					deliverAs: "steer",
					expandPromptTemplates: true,
				});
				if (ctx.hasUI) {
					ctx.ui.notify("Tools still running; queued as steering", "info");
				}
				return;
			}

			await interruptAndSend(pi, ctx, text);
		},
	});
}
