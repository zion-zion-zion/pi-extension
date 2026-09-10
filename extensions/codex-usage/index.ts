import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { createUsageStore, describeUsageError, loadStatusCard } from "./client.ts";
import { isCodexAssistantMessage, shouldShowCodexUsage } from "./events.ts";
import { formatStatusBar, formatStatusCard, type QuotaPaint } from "./format.ts";
import { UsageError, type UsageSnapshot } from "./parser.ts";

const STATUS_KEY = "codex-usage";
const FOOTER_EVENT = "pi-footer:update-widget";
const ENTRY_TYPE = "codex-usage-status";
const REFRESHING_STATUS = "Refreshing Codex usage…";

interface StatusCardData {
	snapshot: UsageSnapshot;
	stale: boolean;
}

const ORANGE = "\x1b[38;5;208m";
const RESET_FG = "\x1b[39m";

function quotaPaint(theme: Theme): QuotaPaint {
	return {
		green: (text) => theme.fg("success", text),
		yellow: (text) => theme.fg("warning", text),
		orange: (text) => `${ORANGE}${text}${RESET_FG}`,
		red: (text) => theme.fg("error", text),
	};
}

class StatusCardView implements Component {
	constructor(private readonly data: StatusCardData) {}

	render(width: number): string[] {
		return formatStatusCard(this.data.snapshot, {
			width,
			now: Date.now(),
			stale: this.data.stale,
		});
	}

	invalidate(): void {}
}

export default function (pi: ExtensionAPI) {
	const store = createUsageStore();
	let currentCtx: ExtensionContext | undefined;

	const getAuth = (ctx: ExtensionContext) => ctx.modelRegistry.getProviderAuth("openai-codex");

	const isOfficialCodex = (ctx: ExtensionContext) => {
		const model = ctx.model;
		return shouldShowCodexUsage({
			model,
			isUsingOAuth: Boolean(model && ctx.modelRegistry.isUsingOAuth(model)),
		});
	};

	const hideStatus = (ctx: ExtensionContext | undefined) => {
		pi.events.emit(FOOTER_EVENT, { widgetId: STATUS_KEY, value: null });
		if (!ctx?.hasUI) return;
		ctx.ui.setStatus(STATUS_KEY, undefined);
	};

	const renderStatus = (ctx: ExtensionContext | undefined, text?: string) => {
		if (!ctx || !isOfficialCodex(ctx)) {
			hideStatus(ctx);
			return;
		}
		const value =
			text ??
			formatStatusBar(store.snapshot(), {
				stale: store.stale(),
				paint: quotaPaint(ctx.ui.theme),
			});
		pi.events.emit(FOOTER_EVENT, { widgetId: STATUS_KEY, value });
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(STATUS_KEY, value);
	};

	const refreshInBackground = (ctx: ExtensionContext) => {
		if (!isOfficialCodex(ctx)) {
			hideStatus(ctx);
			return;
		}
		void store
			.refresh(() => getAuth(ctx))
			.then(() => renderStatus(currentCtx))
			.catch(() => renderStatus(currentCtx));
	};

	pi.registerEntryRenderer<StatusCardData>(ENTRY_TYPE, (entry) => {
		const data = entry.data;
		if (!data?.snapshot) return undefined;
		return new StatusCardView(data);
	});

	pi.on("session_start", (_event, ctx) => {
		currentCtx = ctx;
		renderStatus(ctx);
		if (ctx.hasUI) refreshInBackground(ctx);
	});

	pi.on("model_select", (_event, ctx) => {
		currentCtx = ctx;
		renderStatus(ctx);
		if (ctx.hasUI) refreshInBackground(ctx);
	});

	pi.on("session_shutdown", () => {
		hideStatus(currentCtx);
		currentCtx = undefined;
	});

	pi.on("turn_end", (event, ctx) => {
		if (!ctx.hasUI || !isCodexAssistantMessage(event.message)) return;
		refreshInBackground(ctx);
	});

	pi.registerCommand("status", {
		description: "Show ChatGPT Codex 5-hour and weekly usage",
		handler: async (_args, ctx) => {
			currentCtx = ctx;
			renderStatus(ctx, REFRESHING_STATUS);
			try {
				const result = await loadStatusCard(store, () => getAuth(ctx));
				pi.appendEntry<StatusCardData>(ENTRY_TYPE, {
					snapshot: result.snapshot,
					stale: result.stale,
				});
				if (result.error) {
					ctx.ui.notify(describeUsageError(result.error), "warning");
				}
			} catch (error) {
				const usageError = error instanceof UsageError ? error : new UsageError("http_error", "Codex usage request failed.");
				ctx.ui.notify(describeUsageError(usageError), "error");
			} finally {
				renderStatus(ctx);
			}
		},
	});
}
