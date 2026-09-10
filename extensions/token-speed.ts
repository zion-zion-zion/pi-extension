/**
 * 显示上一次回答的 token 生成速度（解码速度，tok/s）。
 *
 * 测量：从第一个流式 delta（排除 TTFT / 预填充）到流结束。
 * Token 数优先用 provider 报告的 usage.output；没有则按字符估算（带 ~）。
 *
 * 通过 pi-footer 的 Event Value widget 显示：Widget ID = token_speed。
 * /speed 可查看详细统计。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const WIDGET_ID = "token_speed";
const UPDATE_CHANNEL = "pi-footer:update-widget";
const LIVE_THROTTLE_MS = 500;
const MIN_DURATION_MS = 100;

interface CallStats {
  tokens: number;
  estimated: boolean;
  ms: number;
}

interface RespStats {
  tokens: number;
  ms: number;
  calls: number;
}

function estimateTokens(str: string): number {
  let t = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    // CJK 大致 1 字 ≈ 1 token；其它按 4 字符 1 token
    if (
      (c >= 0x2e80 && c <= 0x9fff) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xff00 && c <= 0xffef)
    ) {
      t += 1;
    } else {
      t += 0.25;
    }
  }
  return t;
}

function fmtSpeed(n: number): string {
  return n >= 100 ? Math.round(n).toString() : n.toFixed(1);
}

function fmtTok(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n));
}

function speedText(tokens: number, ms: number, estimated = false): string | null {
  const sec = ms / 1000;
  if (sec <= 0.05 || tokens <= 0) return null;
  return `${estimated ? "~" : ""}${fmtSpeed(tokens / sec)} tok/s`;
}

export default function (pi: ExtensionAPI) {
  let callStart = 0;
  let firstDelta = 0;
  let doneAt = 0;
  let charsEst = 0;

  let respTokens = 0;
  let respMs = 0;
  let respCalls = 0;
  let ttftMs = 0;

  let sessTokens = 0;
  let sessMs = 0;
  let sessCalls = 0;

  let lastCall: CallStats | null = null;
  let lastResp: RespStats | null = null;
  let lastLiveEmit = 0;

  function publish(value: string | null) {
    pi.events.emit(UPDATE_CHANNEL, { widgetId: WIDGET_ID, value });
  }

  pi.on("agent_start", () => {
    respTokens = 0;
    respMs = 0;
    respCalls = 0;
    ttftMs = 0;
  });

  pi.on("message_update", (event) => {
    const e = event.assistantMessageEvent;
    const now = Date.now();

    if (e.type === "start") {
      callStart = now;
      firstDelta = 0;
      doneAt = 0;
      charsEst = 0;
      lastLiveEmit = 0;
      return;
    }

    if (e.type === "done") {
      doneAt = now;
      return;
    }

    if (e.type !== "text_delta" && e.type !== "thinking_delta" && e.type !== "toolcall_delta") {
      return;
    }

    if (!firstDelta) {
      firstDelta = now;
      if (!ttftMs && callStart) ttftMs = firstDelta - callStart;
    }
    charsEst += estimateTokens(e.delta);

    const sec = (now - firstDelta) / 1000;
    if (sec >= 0.5 && now - lastLiveEmit >= LIVE_THROTTLE_MS) {
      lastLiveEmit = now;
      publish(`~${fmtSpeed(charsEst / sec)} tok/s`);
    }
  });

  pi.on("message_end", (event) => {
    if (event.message.role !== "assistant") return;

    const now = Date.now();
    const end = doneAt || now;
    const start = firstDelta || callStart || now;
    const ms = end - start;
    const exact = event.message.usage?.output ?? 0;
    const estimated = exact <= 0;
    const tokens = exact > 0 ? exact : Math.round(charsEst);
    if (tokens <= 0 || ms < MIN_DURATION_MS) return;

    lastCall = { tokens, estimated, ms };
    respTokens += tokens;
    respMs += ms;
    respCalls += 1;
    sessTokens += tokens;
    sessMs += ms;
    sessCalls += 1;

    const text = speedText(tokens, ms, estimated);
    if (text) publish(text);
  });

  pi.on("agent_settled", () => {
    if (respCalls > 0 && respMs > 0) {
      lastResp = { tokens: respTokens, ms: respMs, calls: respCalls };
      const text = speedText(respTokens, respMs);
      if (text) publish(text);
    }
  });

  pi.registerCommand("speed", {
    description: "Token 生成速度统计",
    handler: async (_args, ctx) => {
      const lines: string[] = [];
      if (lastResp) {
        const s = speedText(lastResp.tokens, lastResp.ms);
        lines.push(
          `上一次回答: ${s} · ${fmtTok(lastResp.tokens)} tok / ${(lastResp.ms / 1000).toFixed(1)}s / ${lastResp.calls} 次调用`,
        );
      } else {
        lines.push("上一次回答: 暂无数据");
      }
      if (lastCall) {
        const s = speedText(lastCall.tokens, lastCall.ms, lastCall.estimated) ?? "n/a";
        lines.push(
          `最后一次 LLM 调用: ${s} · ${fmtTok(lastCall.tokens)} tok / ${(lastCall.ms / 1000).toFixed(1)}s${lastCall.estimated ? "（估算值）" : ""}`,
        );
      }
      if (ttftMs) lines.push(`首 token 延迟 (TTFT): ${(ttftMs / 1000).toFixed(2)}s`);
      if (sessCalls > 0) {
        lines.push(
          `本次会话生成均值: ${speedText(sessTokens, sessMs)} · 共 ${fmtTok(sessTokens)} tok / ${sessCalls} 次调用`,
        );
      }
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
