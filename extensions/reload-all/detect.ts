/**
 * 从 `herdr pane read <pane> --source visible --format text` 的渲染文本里，
 * 判断目标窗口的输入框是否为空。
 *
 * 判据：pi-pretty-tui 把输入框画成贴在屏幕底部的圆角框
 *
 *     ╭──────────╮
 *     │ <内容>   │
 *     ╰──────────╯
 *     ✦ 模型 • …          ← footer
 *
 * 自下而上找第一条以 `╰` 起笔、以 `╯` 收笔的行当底边，它上方紧邻的 `╭ … ╮`
 * 当顶边，中间的 `│ … │` 行即内容区。左右缩进不影响判定。
 *
 * 三种结果里只有 `empty` 允许发送；`unknown` 按「跳过」处理（fail-safe）——
 * 宁可漏发，也不能把 `/reload` 粘到别人未提交的草稿后面当普通消息发出去。
 */

export type EditorState = "empty" | "occupied" | "unknown";

/**
 * 底边之后允许的最大行数：footer 占 1 到数行。
 * 底边必须贴近屏幕底部，否则可能选到了对话正文里的圆角框。
 */
const MAX_LINES_AFTER_BOX = 6;

/** 一条边：去掉缩进后以开角开头、以收角结尾，中间至少 20 个 `─`。 */
function isEdge(line: string, open: string, close: string): boolean {
	const trimmed = line.trim();
	return (
		trimmed.length >= 22 &&
		trimmed.startsWith(open) &&
		trimmed.endsWith(close) &&
		trimmed.slice(1, -1).split("").every((ch) => ch === "─")
	);
}

/** 内容行：去掉缩进后以 `│` 开头并以 `│` 结尾，返回两边之间的正文。 */
function contentBetween(line: string): string | undefined {
	const trimmed = line.trim();
	if (trimmed.length < 2 || !trimmed.startsWith("│") || !trimmed.endsWith("│")) return undefined;
	return trimmed.slice(1, -1);
}

export function detectEditorState(screen: string): EditorState {
	const lines = screen.split(/\r?\n/);

	// 末尾空行不计入，避免渲染留白被当成「底边之后还有内容」。
	let end = lines.length - 1;
	while (end >= 0 && lines[end]!.trim() === "") end -= 1;
	if (end < 0) return "unknown";

	let bottom = -1;
	for (let i = end; i >= 0; i -= 1) {
		if (isEdge(lines[i]!, "╰", "╯")) {
			bottom = i;
			break;
		}
	}
	if (bottom < 0 || end - bottom > MAX_LINES_AFTER_BOX) return "unknown";

	let top = -1;
	for (let i = bottom - 1; i >= 0; i -= 1) {
		if (isEdge(lines[i]!, "╭", "╮")) {
			top = i;
			break;
		}
		// 顶边之前只该有内容行；遇到别的行说明这对框不完整。
		if (contentBetween(lines[i]!) === undefined) return "unknown";
	}
	if (top < 0 || top === bottom - 1) return "unknown";

	for (let i = top + 1; i < bottom; i += 1) {
		const content = contentBetween(lines[i]!);
		if (content === undefined) return "unknown";
		if (content.trim() !== "") return "occupied";
	}
	return "empty";
}
