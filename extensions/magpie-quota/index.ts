import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { createQuotaStore, describeQuotaError } from "./client.ts";
import { formatCard, formatFooter, type QuotaPaint } from "./format.ts";
import { QuotaError, showsSubscriptionQuota, type QuotaSnapshot } from "./parser.ts";

const WIDGET_ID = "magpie-quota";
const STATUS_KEY = "magpie-quota";
const FOOTER_EVENT = "pi-footer:update-widget";
const REFRESH_MS = 60_000;
const OFFLINE = "magpie 未连接";

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

export default function (pi: ExtensionAPI) {
	const store = createQuotaStore();
	let currentCtx: ExtensionContext | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;

	const publish = (ctx: ExtensionContext | undefined, value: string | undefined) => {
		pi.events.emit(FOOTER_EVENT, { widgetId: WIDGET_ID, value: value ?? null });
		if (!ctx?.hasUI) return;
		ctx.ui.setStatus(STATUS_KEY, value);
	};

	const watching = (ctx: ExtensionContext | undefined) => showsSubscriptionQuota(ctx?.model);

	const render = (ctx: ExtensionContext | undefined) => {
		if (!watching(ctx)) {
			publish(ctx, undefined);
			return;
		}
		const snapshot = store.snapshot();
		if (!snapshot) {
			publish(ctx, undefined);
			return;
		}
		const paint = ctx?.hasUI ? quotaPaint(ctx.ui.theme) : undefined;
		publish(ctx, formatFooter(snapshot, { stale: store.stale(), paint }));
	};

	const refresh = (ctx: ExtensionContext | undefined) => {
		if (!watching(ctx)) {
			publish(ctx, undefined);
			return;
		}
		void store
			.refresh()
			.then(() => render(currentCtx))
			.catch((error: unknown) => {
				if (store.snapshot()) {
					render(currentCtx);
					return;
				}
				const quotaError = error instanceof QuotaError ? error : new QuotaError("unreachable", "Magpie is not reachable.");
				publish(ctx, quotaError.code === "unreachable" ? OFFLINE : describeQuotaError(quotaError));
			});
	};

	const startTimer = () => {
		if (timer) return;
		timer = setInterval(() => refresh(currentCtx), REFRESH_MS);
		timer.unref?.();
	};

	pi.on("session_start", (_event, ctx) => {
		currentCtx = ctx;
		render(ctx);
		refresh(ctx);
		startTimer();
	});

	pi.on("model_select", (_event, ctx) => {
		currentCtx = ctx;
		render(ctx);
		refresh(ctx);
	});

	pi.on("session_shutdown", () => {
		if (timer) clearInterval(timer);
		timer = undefined;
		publish(currentCtx, undefined);
		currentCtx = undefined;
	});

	pi.registerCommand("quota", {
		description: "显示 magpie 里各订阅账号的剩余额度",
		handler: async (_args, ctx) => {
			currentCtx = ctx;
			try {
				const snapshot = await store.refresh();
				ctx.ui.notify(formatCard(snapshot, Date.now(), false).join("\n"), "info");
			} catch (error) {
				const snapshot: QuotaSnapshot | undefined = store.snapshot();
				const quotaError = error instanceof QuotaError ? error : new QuotaError("unreachable", "Magpie is not reachable.");
				if (snapshot) {
					ctx.ui.notify(`${formatCard(snapshot, Date.now(), true).join("\n")}\n${describeQuotaError(quotaError)}`, "warning");
				} else {
					ctx.ui.notify(describeQuotaError(quotaError), "error");
				}
			} finally {
				render(ctx);
			}
		},
	});
}
