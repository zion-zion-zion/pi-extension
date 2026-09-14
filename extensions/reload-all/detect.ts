/**
 * 从 `herdr pane read <pane> --source visible --format text` 的渲染文本里，
 * 判断目标窗口的输入框是否为空。
 *
 * 判据与依据见 docs/superpowers/specs/2026-09-14-reload-all-design.md 「编辑器占用检测」：
 * 取屏幕上最后两条「整行皆为 ─ 且长度 ≥ MIN_RULE_LEN」的横线，作为输入框的上、下边线，
 * 两条边线之间即输入框内容区。
 *
 * 三种结果里只有 `empty` 允许发送；`unknown` 按「跳过」处理（fail-safe）——
 * 宁可漏发，也不能把 `/reload` 粘到别人未提交的草稿后面当普通消息发出去。
 */

export type EditorState = "empty" | "occupied" | "unknown";

const RULE_CHAR = "─";
const MIN_RULE_LEN = 20;
/**
 * 下边线之后允许的最大行数。
 *
 * 实测：普通状态 footer 占 2 行；若斜杠命令补全弹窗打开，会多出补全项那一行；
 * 若还装了额外状态扩展（例如 `[微信 ⏸ 未连接]`），可到 4 行。这里留到 6 行。
 * 放宽它的代价是把「对话里的两条分隔线」误认为编辑器边框；上限取得过大才会引入这个风险。
 */
const MAX_LINES_AFTER_RULE = 6;

function isRule(line: string): boolean {
	const trimmed = line.trim();
	if (trimmed.length < MIN_RULE_LEN) return false;
	for (const ch of trimmed) {
		if (ch !== RULE_CHAR) return false;
	}
	return true;
}

export function detectEditorState(screen: string): EditorState {
	const lines = screen.split(/\r?\n/);

	// 末尾空行不计入，避免渲染留白被当成「下边线之后还有内容」。
	let end = lines.length - 1;
	while (end >= 0 && lines[end]!.trim() === "") end -= 1;
	if (end < 0) return "unknown";

	// 自下而上取最后两条边线：rules[0] 是下边线，rules[1] 是上边线。
	const rules: number[] = [];
	for (let i = end; i >= 0 && rules.length < 2; i -= 1) {
		if (isRule(lines[i]!)) rules.push(i);
	}
	if (rules.length < 2) return "unknown";

	const bottom = rules[0]!;
	const top = rules[1]!;

	// 下边线必须贴近屏幕底部，否则可能选到了对话正文里的两条分隔线。
	if (end - bottom > MAX_LINES_AFTER_RULE) return "unknown";

	for (let i = top + 1; i < bottom; i += 1) {
		if (lines[i]!.trim() !== "") return "occupied";
	}
	return "empty";
}
