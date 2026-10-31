/**
 * 在 pi-footer 里显示上下文用量：`210k/500k (42%)`，不带进度条。
 *
 * 为什么要单独写一个扩展：pi-footer 自带的 context-bar 一定带进度条，
 * context / context-length 又是分开的两个值，拼不出「已用/上限 (百分比)」。
 * 这里用 Event Value widget（Widget ID = context_usage）发布格式化后的整串。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const WIDGET_ID = "context_usage";
const UPDATE_CHANNEL = "pi-footer:update-widget";

function trimZero(value: number): string {
  return (Math.round(value * 10) / 10).toFixed(1).replace(/\.0$/, "");
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${trimZero(n / 1_000_000)}M`;
  if (n >= 1_000) return `${trimZero(n / 1_000)}k`;
  return String(Math.round(n));
}

export default function (pi: ExtensionAPI) {
  let last: string | null = null;

  function publish(value: string | null) {
    if (value === last) return;
    last = value;
    pi.events.emit(UPDATE_CHANNEL, { widgetId: WIDGET_ID, value });
  }

  function refresh(ctx: { getContextUsage?: () => { tokens: number | null; contextWindow: number; percent: number | null } | undefined }) {
    const usage = ctx.getContextUsage?.();
    if (!usage || usage.tokens === null || !usage.contextWindow) {
      publish(null);
      return;
    }
    const percent = usage.percent ?? (usage.tokens / usage.contextWindow) * 100;
    publish(`${fmtTokens(usage.tokens)}/${fmtTokens(usage.contextWindow)} (${Math.round(percent)}%)`);
  }

  pi.on("session_start", (_event, ctx) => refresh(ctx));
  pi.on("turn_end", (_event, ctx) => refresh(ctx));
  pi.on("agent_settled", (_event, ctx) => refresh(ctx));
  pi.on("model_select", (_event, ctx) => refresh(ctx));
}
