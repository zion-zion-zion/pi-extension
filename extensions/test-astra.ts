/**
 * /test-astra —— 一条命令，自动发送一句固定的用户消息：
 *
 *   without websearching, what's the newest version of google gemini model?
 *
 * 设计文档：docs/superpowers/specs/2026-09-18-test-astra-design.md
 *
 * 用 pi.sendUserMessage()（不是 sendMessage()）：发的是「用户消息」，出现在
 * transcript 里、必然触发一轮 turn，和手打这句话效果一致。
 *
 * 忙碌时（正在流式输出）sendUserMessage 不带 deliverAs 会抛错，所以排队成
 * followUp，本轮结束后自动送达；空闲时直接发送。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MESSAGE =
	"without websearching, what's the newest version of google gemini model?";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("test-astra", {
		description: "Send the test-astra question as a user message",
		handler: async (_args, ctx) => {
			if (!ctx.isIdle()) {
				pi.sendUserMessage(MESSAGE, { deliverAs: "followUp" });
				ctx.ui.notify("test-astra: agent busy, queued as follow-up", "info");
				return;
			}
			pi.sendUserMessage(MESSAGE);
		},
	});
}
