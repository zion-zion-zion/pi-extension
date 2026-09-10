/**
 * /commits
 *
 * Show the current branch's commit history in a picker.
 * Enter a commit for `git show --stat`. Does not talk to the LLM.
 */

import { copyToClipboard, DynamicBorder } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	Container,
	Key,
	matchesKey,
	SelectList,
	type SelectItem,
	type SelectListTheme,
	Spacer,
	Text,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;
const LIST_VISIBLE = 16;
const DETAIL_VISIBLE = 18;
const LOG_FORMAT = "%H%x1f%h%x1f%cI%x1f%an%x1f%s%x1f%D";
const COMPLETIONS = ["20", "50", "100", "200", "all"];

type GitResult = {
	stdout: string;
	stderr: string;
	code: number;
};

type Commit = {
	hash: string;
	short: string;
	iso: string;
	author: string;
	subject: string;
};

type Meta = {
	branch: string;
	headHash: string;
	headShort: string;
	shown: number;
	upstream?: string;
	ahead?: number;
	behind?: number;
};

function notify(ctx: ExtensionCommandContext, message: string, level: "info" | "warning" | "error" = "info") {
	if (ctx.hasUI) ctx.ui.notify(message, level);
}

async function git(pi: ExtensionAPI, ctx: ExtensionCommandContext, args: string[], timeout = 15_000): Promise<GitResult> {
	return pi.exec("git", args, { cwd: ctx.cwd, timeout });
}

function firstLine(text: string): string {
	return text.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? "";
}

function parseLimit(args: string): number {
	const raw = args.trim().toLowerCase();
	if (!raw) return DEFAULT_LIMIT;
	if (raw === "all") return MAX_LIMIT;
	const n = Number.parseInt(raw, 10);
	if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
	return Math.min(n, MAX_LIMIT);
}

function relativeTime(iso: string): string {
	const t = Date.parse(iso);
	if (!Number.isFinite(t)) return iso.slice(0, 10);
	const sec = Math.max(0, Math.round((Date.now() - t) / 1000));
	if (sec < 60) return `${sec}s`;
	const min = Math.round(sec / 60);
	if (min < 60) return `${min}m`;
	const hr = Math.round(min / 60);
	if (hr < 24) return `${hr}h`;
	const day = Math.round(hr / 24);
	if (day < 30) return `${day}d`;
	const month = Math.round(day / 30);
	if (month < 12) return `${month}mo`;
	return `${Math.round(month / 12)}y`;
}

function parseLog(stdout: string): Commit[] {
	const commits: Commit[] = [];
	for (const line of stdout.split(/\r?\n/)) {
		if (!line.trim()) continue;
		const [hash, short, iso, author, subject] = line.split("\x1f");
		if (!hash || !short) continue;
		commits.push({
			hash,
			short,
			iso: iso ?? "",
			author: author ?? "",
			subject: subject ?? "(no subject)",
		});
	}
	return commits;
}

function toItems(commits: Commit[], headHash: string): SelectItem[] {
	return commits.map((c) => ({
		value: c.hash,
		label: c.hash === headHash ? `* ${c.short}` : c.short,
		description: `${relativeTime(c.iso)} · ${c.author} · ${c.subject}`,
	}));
}

function headerText(meta: Meta): string {
	const parts = [`${meta.branch} @ ${meta.headShort}`, `${meta.shown} commits`];
	if (meta.upstream) {
		if (meta.ahead || meta.behind) {
			const bits: string[] = [];
			if (meta.ahead) bits.push(`↑${meta.ahead}`);
			if (meta.behind) bits.push(`↓${meta.behind}`);
			parts.push(`${meta.upstream} ${bits.join(" ")}`.trim());
		} else {
			parts.push(meta.upstream);
		}
	}
	return parts.join("  ·  ");
}

function selectTheme(theme: Theme): SelectListTheme {
	return {
		selectedPrefix: (text) => theme.fg("accent", text),
		selectedText: (text) => theme.fg("accent", text),
		description: (text) => theme.fg("muted", text),
		scrollInfo: (text) => theme.fg("muted", text),
		noMatch: (text) => theme.fg("muted", text),
	};
}

function isCopyKey(data: string): boolean {
	return matchesKey(data, "y");
}

async function copyHash(ctx: ExtensionCommandContext, hash: string) {
	try {
		await copyToClipboard(hash);
		notify(ctx, `Copied ${hash.slice(0, 7)}`);
	} catch (error) {
		notify(ctx, error instanceof Error ? error.message : "Copy failed", "error");
	}
}

async function loadMeta(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<Meta | undefined> {
	const inside = await git(pi, ctx, ["rev-parse", "--is-inside-work-tree"]);
	if (inside.code !== 0 || firstLine(inside.stdout) !== "true") {
		notify(ctx, "Not a git repository", "warning");
		return;
	}

	const branchResult = await git(pi, ctx, ["rev-parse", "--abbrev-ref", "HEAD"]);
	const headResult = await git(pi, ctx, ["rev-parse", "HEAD"]);
	if (headResult.code !== 0) {
		notify(ctx, headResult.stderr.trim() || "No commits yet", "warning");
		return;
	}

	const branchName = firstLine(branchResult.stdout) || "HEAD";
	const headHash = firstLine(headResult.stdout);
	const meta: Meta = {
		branch: branchName === "HEAD" ? "detached HEAD" : branchName,
		headHash,
		headShort: headHash.slice(0, 7),
		shown: 0,
	};

	const upstream = await git(pi, ctx, ["rev-parse", "--abbrev-ref", "@{upstream}"]);
	if (upstream.code === 0) {
		meta.upstream = firstLine(upstream.stdout);
		const counts = await git(pi, ctx, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]);
		if (counts.code === 0) {
			const [behind, ahead] = firstLine(counts.stdout).split(/\s+/);
			meta.behind = Number.parseInt(behind ?? "0", 10) || 0;
			meta.ahead = Number.parseInt(ahead ?? "0", 10) || 0;
		}
	}

	return meta;
}

async function loadCommits(pi: ExtensionAPI, ctx: ExtensionCommandContext, limit: number): Promise<Commit[] | undefined> {
	const log = await git(pi, ctx, ["log", `-n${limit}`, `--pretty=format:${LOG_FORMAT}`], 20_000);
	if (log.code !== 0) {
		notify(ctx, log.stderr.trim() || "git log failed", "error");
		return;
	}
	const commits = parseLog(log.stdout);
	if (commits.length === 0) {
		notify(ctx, "No commits on this branch", "warning");
		return;
	}
	return commits;
}

async function loadShow(pi: ExtensionAPI, ctx: ExtensionCommandContext, hash: string): Promise<string> {
	const shown = await git(pi, ctx, ["show", "--stat", "--format=fuller", "--no-color", hash], 20_000);
	if (shown.code !== 0) return shown.stderr.trim() || "git show failed";
	return (shown.stdout || shown.stderr).trim() || "(empty)";
}

function overlayOptions() {
	return {
		overlay: true as const,
		overlayOptions: {
			anchor: "center" as const,
			width: "92%",
			minWidth: 56,
			maxHeight: "80%",
		},
	};
}

function showFallback(ctx: ExtensionCommandContext, meta: Meta, commits: Commit[]) {
	const lines = [headerText(meta), ...commits.slice(0, 20).map((c) => `${c.short}  ${relativeTime(c.iso)}  ${c.subject}`)];
	if (commits.length > 20) lines.push(`… ${commits.length - 20} more`);
	notify(ctx, lines.join("\n"));
}

async function pickCommit(
	ctx: ExtensionCommandContext,
	meta: Meta,
	commits: Commit[],
	selectedHash?: string,
): Promise<string | undefined> {
	return ctx.ui.custom<string | undefined>((tui, theme, _kb, done) => {
		const container = new Container();
		const border = (s: string) => theme.fg("accent", s);
		const list = new SelectList(toItems(commits, meta.headHash), Math.min(LIST_VISIBLE, commits.length), selectTheme(theme), {
			minPrimaryColumnWidth: 10,
			maxPrimaryColumnWidth: 12,
		});
		if (selectedHash) {
			const idx = commits.findIndex((c) => c.hash === selectedHash);
			if (idx >= 0) list.setSelectedIndex(idx);
		}

		list.onSelect = (item) => done(item.value);
		list.onCancel = () => done(undefined);

		container.addChild(new DynamicBorder(border));
		container.addChild(new Text(theme.fg("accent", theme.bold(headerText(meta))), 1, 0));
		container.addChild(new Spacer(1));
		container.addChild(list);
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("dim", "  Enter 详情  ·  y 复制 hash  ·  Esc 关闭"), 1, 0));
		container.addChild(new DynamicBorder(border));

		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleMouse: (event) => list.handleMouse(event),
			handleInput: (data: string) => {
				if (isCopyKey(data)) {
					const item = list.getSelectedItem();
					if (item) void copyHash(ctx, item.value);
					return;
				}
				list.handleInput(data);
				tui.requestRender();
			},
		};
	}, overlayOptions());
}

async function showDetail(
	ctx: ExtensionCommandContext,
	commit: Commit,
	body: string,
): Promise<void> {
	await ctx.ui.custom<void>((tui, theme, _kb, done) => {
		const container = new Container();
		const border = (s: string) => theme.fg("accent", s);
		let offset = 0;
		let wrapped: string[] = [];
		let lastWidth = 0;

		const title = `${commit.short}  ${commit.subject}`;
		const footer = "  ↑↓ 滚动  ·  y 复制 hash  ·  Esc 返回";

		const rebuild = (width: number) => {
			if (width !== lastWidth) {
				const inner = Math.max(8, width - 2);
				wrapped = wrapTextWithAnsi(body, inner);
				lastWidth = width;
				offset = Math.min(offset, Math.max(0, wrapped.length - DETAIL_VISIBLE));
			}

			container.clear();
			container.addChild(new DynamicBorder(border));
			container.addChild(new Text(theme.fg("accent", theme.bold(truncateToWidth(title, Math.max(8, width - 2)))), 1, 0));
			container.addChild(new Spacer(1));

			const slice = wrapped.slice(offset, offset + DETAIL_VISIBLE);
			container.addChild(new Text(slice.join("\n") || "(empty)", 1, 0));

			const more = wrapped.length > DETAIL_VISIBLE ? `  ${offset + 1}-${Math.min(offset + slice.length, wrapped.length)}/${wrapped.length}` : "";
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("dim", footer + more), 1, 0));
			container.addChild(new DynamicBorder(border));
		};

		return {
			render: (width: number) => {
				rebuild(width);
				return container.render(width);
			},
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				if (isCopyKey(data)) {
					void copyHash(ctx, commit.hash);
					return;
				}
				if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter)) {
					done(undefined);
					return;
				}
				const maxOffset = Math.max(0, wrapped.length - DETAIL_VISIBLE);
				if (matchesKey(data, Key.up)) offset = Math.max(0, offset - 1);
				else if (matchesKey(data, Key.down)) offset = Math.min(maxOffset, offset + 1);
				else if (matchesKey(data, Key.home)) offset = 0;
				else if (matchesKey(data, Key.end)) offset = maxOffset;
				else if (matchesKey(data, Key.space)) offset = Math.min(maxOffset, offset + DETAIL_VISIBLE - 1);
				tui.requestRender();
			},
		};
	}, overlayOptions());
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("commits", {
		description: "查看当前分支的提交历史",
		getArgumentCompletions: (prefix) => {
			const filtered = COMPLETIONS.filter((value) => value.startsWith(prefix.trim().toLowerCase()));
			return filtered.map((value) => ({ value, label: value }));
		},
		handler: async (args, ctx) => {
			const limit = parseLimit(args);
			const meta = await loadMeta(pi, ctx);
			if (!meta) return;

			const commits = await loadCommits(pi, ctx, limit);
			if (!commits) return;
			meta.shown = commits.length;

			if (ctx.mode !== "tui") {
				showFallback(ctx, meta, commits);
				return;
			}

			const byHash = new Map(commits.map((c) => [c.hash, c]));
			let selected = commits[0]?.hash;

			while (true) {
				const hash = await pickCommit(ctx, meta, commits, selected);
				if (!hash) return;
				selected = hash;
				const commit = byHash.get(hash);
				if (!commit) return;
				const body = await loadShow(pi, ctx, hash);
				await showDetail(ctx, commit, body);
			}
		},
	});
}
