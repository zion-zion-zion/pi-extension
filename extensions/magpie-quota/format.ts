import { accountLabel, activeAccount, type QuotaAccount, type QuotaSnapshot, type QuotaWindow } from "./parser.ts";

export type QuotaColor = "green" | "yellow" | "orange" | "red";

export type QuotaPaint = Record<QuotaColor, (text: string) => string>;

export interface FooterOptions {
	stale?: boolean;
	paint?: QuotaPaint;
}

export function quotaColor(remaining: number): QuotaColor {
	if (remaining >= 50) return "green";
	if (remaining >= 25) return "yellow";
	if (remaining >= 10) return "orange";
	return "red";
}

/** 底部常驻：只显示当前在用的那张卡，`Team 5h 83% · 7d 50%`。 */
export function formatFooter(snapshot: QuotaSnapshot | undefined, options: FooterOptions = {}): string | undefined {
	if (!snapshot) return undefined;
	const account = activeAccount(snapshot);
	if (!account) return undefined;
	const text = formatAccount(account, options.paint);
	return options.stale ? `${text} ⚠` : text;
}

/** `/quota` 卡片：每个账号一行，带重置时间。 */
export function formatCard(snapshot: QuotaSnapshot, now: number, stale: boolean): string[] {
	const lines = snapshot.accounts.map((account) => formatAccountLine(account, now));
	const age = stale ? `⚠ ${formatFetchedAgo(snapshot.fetchedAt, now)}` : formatFetchedAgo(snapshot.fetchedAt, now);
	lines.push(age);
	return lines;
}

export function formatResetRemaining(resetsAt: number | undefined, now: number): string | undefined {
	if (resetsAt === undefined) return undefined;
	const remainingMs = resetsAt - now;
	if (remainingMs <= 0) return "已重置";

	const totalMinutes = Math.floor(remainingMs / 60_000);
	const days = Math.floor(totalMinutes / (24 * 60));
	const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
	const minutes = totalMinutes % 60;

	if (days > 0) return hours > 0 ? `${days}天${hours}小时` : `${days}天`;
	if (hours > 0) return minutes > 0 ? `${hours}小时${minutes}分` : `${hours}小时`;
	return `${Math.max(1, minutes)}分`;
}

function formatAccount(account: QuotaAccount, paint?: QuotaPaint): string {
	const windows = account.windows.map((window) => formatWindow(window, paint)).join(" · ");
	return `${accountLabel(account)} ${windows}`;
}

function formatAccountLine(account: QuotaAccount, now: number): string {
	const windows = account.windows
		.map((window) => {
			const reset = formatResetRemaining(window.resetsAt, now);
			const core = `${window.label} ${Math.round(window.remaining)}%`;
			return reset ? `${core}（${reset}后重置）` : core;
		})
		.join("   ");
	const plan = account.plan ? ` · ${account.plan}` : "";
	return `${account.user}${plan}    ${windows}`;
}

function formatWindow(window: QuotaWindow, paint?: QuotaPaint): string {
	const percent = `${Math.round(window.remaining)}%`;
	const colored = paint ? paint[quotaColor(window.remaining)](percent) : percent;
	return `${window.label} ${colored}`;
}

function formatFetchedAgo(fetchedAt: number, now: number): string {
	const delta = Math.max(0, now - fetchedAt);
	if (delta < 45_000) return "刚刚更新";
	if (delta < 3_600_000) return `${Math.max(1, Math.floor(delta / 60_000))} 分钟前更新`;
	if (delta < 86_400_000) return `${Math.max(1, Math.floor(delta / 3_600_000))} 小时前更新`;
	return `${Math.max(1, Math.floor(delta / 86_400_000))} 天前更新`;
}
