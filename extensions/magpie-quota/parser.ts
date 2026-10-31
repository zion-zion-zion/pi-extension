export type QuotaErrorCode = "unreachable" | "request_timeout" | "http_error" | "invalid_response";

export class QuotaError extends Error {
	readonly code: QuotaErrorCode;
	readonly status?: number;

	constructor(code: QuotaErrorCode, message: string, status?: number) {
		super(message);
		this.name = "QuotaError";
		this.code = code;
		this.status = status;
	}
}

export interface QuotaWindow {
	label: string;
	/** 剩余百分比，0–100。footer 按剩余着色，和旧 codex-usage 一致。 */
	remaining: number;
	resetsAt?: number;
}

export interface QuotaAccount {
	user: string;
	plan?: string;
	/** magpie 标记的「上次实际应答的账号」。多账号时只有一张为 true。 */
	last: boolean;
	windows: QuotaWindow[];
	readAt?: number;
}

export interface QuotaSnapshot {
	accounts: QuotaAccount[];
	fetchedAt: number;
}

export function parseQuotasResponse(payload: unknown, fetchedAt: number): QuotaSnapshot {
	if (!isRecord(payload) || !Array.isArray(payload.data)) {
		throw new QuotaError("invalid_response", "Magpie quotas response is incompatible.");
	}

	const accounts: QuotaAccount[] = [];
	for (const item of payload.data) {
		const account = parseAccount(item);
		if (account) accounts.push(account);
	}
	if (accounts.length === 0) {
		throw new QuotaError("invalid_response", "Magpie quotas response has no accounts.");
	}
	return { accounts, fetchedAt };
}

function parseAccount(value: unknown): QuotaAccount | undefined {
	if (!isRecord(value) || !Array.isArray(value.windows)) return undefined;
	const user = typeof value.user === "string" ? value.user.trim() : "";
	if (!user) return undefined;

	const windows: QuotaWindow[] = [];
	for (const entry of value.windows) {
		const window = parseWindow(entry);
		if (window) windows.push(window);
	}
	if (windows.length === 0) return undefined;

	const plan = typeof value.plan === "string" && value.plan.trim() ? value.plan.trim() : undefined;
	const readAt = typeof value.readAt === "string" ? Date.parse(value.readAt) : undefined;
	return {
		user,
		plan,
		last: value.last === true,
		windows,
		readAt: readAt !== undefined && Number.isFinite(readAt) ? readAt : undefined,
	};
}

function parseWindow(value: unknown): QuotaWindow | undefined {
	if (!isRecord(value)) return undefined;
	const name = typeof value.name === "string" ? value.name.trim() : "";
	const remaining = finiteNumber(value.remaining);
	if (!name || remaining === undefined) return undefined;

	const resetsAt = typeof value.resetsAt === "string" ? Date.parse(value.resetsAt) : undefined;
	return {
		label: shortLabel(name),
		remaining: clamp(remaining, 0, 100),
		resetsAt: resetsAt !== undefined && Number.isFinite(resetsAt) ? resetsAt : undefined,
	};
}

/** "5 hours" → "5h"，"7 days" → "7d"；不认识的名字原样缩短空白。 */
export function shortLabel(name: string): string {
	const hours = /^(\d+)\s*hours?$/i.exec(name);
	if (hours) return `${hours[1]}h`;
	const days = /^(\d+)\s*days?$/i.exec(name);
	if (days) return `${days[1]}d`;
	return name.replace(/\s+/g, "");
}

/**
 * footer 上的短账号名。邮箱取 @ 前；「name · Team」取 Team 这类计划后缀，
 * 没有后缀时取名字本身。
 */
export function accountLabel(account: QuotaAccount): string {
	const user = account.user;
	const parts = user.split("·").map((part) => part.trim()).filter(Boolean);
	if (parts.length >= 2) return parts[parts.length - 1] ?? user;
	const at = user.indexOf("@");
	if (at > 0) return user.slice(0, at);
	return user;
}

/**
 * footer 只在 magpie 的 GPT 订阅模型上出现：
 * `auto/gpt*` 是路由组，`codex/gpt*` 是直接走 ChatGPT 订阅。
 * `01ai-tokenhub/gpt*` 走的是 key，不消耗这两张订阅卡。
 */
export function showsSubscriptionQuota(model: { provider?: string; id?: string } | undefined | null): boolean {
	if (!model || model.provider !== "magpie") return false;
	const id = model.id ?? "";
	return id.startsWith("auto/gpt") || id.startsWith("codex/gpt");
}

/**
 * 当前在用的那张卡。magpie 的 auto 路由每次请求才决定账号（有额度、且额度快重置的优先），
 * 请求前没有「将要用哪张」的字段；`last` 是它标记的上次实际应答账号，多张时取第一张。
 * 没有任何标记时退回第一张，避免 footer 空白。
 */
export function activeAccount(snapshot: QuotaSnapshot): QuotaAccount | undefined {
	return snapshot.accounts.find((account) => account.last) ?? snapshot.accounts[0];
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}
