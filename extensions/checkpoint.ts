/**
 * /checkpoint
 *
 * Commit current git changes with an auto-generated message. Never pushes.
 *
 * 1. Run git status
 * 2. If the worktree is dirty, stage and commit
 * 3. Commit message summarizes the current diff (current session model, with a local fallback)
 */

import { uuidv7 } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const DIFF_CHAR_LIMIT = 24_000;
const SUBJECT_LIMIT = 72;

type GitResult = {
	stdout: string;
	stderr: string;
	code: number;
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

function clip(text: string, limit: number): string {
	if (text.length <= limit) return text;
	return `${text.slice(0, limit)}\n\n[truncated ${text.length - limit} characters]`;
}

function fallbackMessage(porcelain: string): string {
	const files = porcelain
		.split("\n")
		.map((line) => line.trimEnd())
		.filter(Boolean)
		.map((line) => line.slice(3).trim())
		.filter(Boolean);

	if (files.length === 0) return "Save local work";
	if (files.length === 1) return `Update ${files[0]}`;
	if (files.length === 2) return `Update ${files[0]} and ${files[1]}`;
	return `Update ${files[0]}, ${files[1]}, and ${files.length - 2} other file${files.length - 2 === 1 ? "" : "s"}`;
}

function sanitizeMessage(raw: string): string | undefined {
	let text = raw.trim();
	if (!text) return undefined;

	text = text.replace(/^```(?:\w+)?\s*/u, "").replace(/\s*```$/u, "").trim();
	text = text.replace(/^["'`]+|["'`]+$/gu, "").trim();
	if (!text) return undefined;

	const lines = text.split(/\r?\n/);
	let subject = (lines[0] ?? "").trim();
	if (subject.toLowerCase().startsWith("subject:")) {
		subject = subject.slice("subject:".length).trim();
	}
	subject = subject.replace(/^\*\s+/, "").replace(/^#{1,6}\s+/, "");
	if (subject.length > SUBJECT_LIMIT) {
		subject = `${subject.slice(0, SUBJECT_LIMIT - 1).trimEnd()}…`;
	}

	const body = lines
		.slice(1)
		.join("\n")
		.trim()
		.replace(/^(?:body|message):\s*/i, "")
		.trim();

	if (!subject) return undefined;
	return body ? `${subject}\n\n${body}` : subject;
}

async function generateMessage(
	ctx: ExtensionCommandContext,
	status: string,
	stat: string,
	diff: string,
): Promise<string | undefined> {
	const model = ctx.model;
	if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) return undefined;

	const prompt = [
		"Write a git commit message for the changes below.",
		"Output only the commit message.",
		"First line: imperative subject, max 72 characters, no trailing period.",
		"Optional body after a blank line, concise, wrap-friendly.",
		"No markdown fences, no quotes, no commentary, no Co-authored-by trailer.",
		"",
		"<git-status>",
		status.trim() || "(empty)",
		"</git-status>",
		"",
		"<git-diff-stat>",
		stat.trim() || "(empty)",
		"</git-diff-stat>",
		"",
		"<git-diff>",
		clip(diff, DIFF_CHAR_LIMIT) || "(empty)",
		"</git-diff>",
	].join("\n");

	const response = await ctx.modelRegistry.complete(
		model,
		{
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: prompt }],
					timestamp: Date.now(),
				},
			],
		},
		{
			cacheRetention: "none",
			sessionId: uuidv7(),
			maxTokens: 256,
		},
	);

	if (response.stopReason === "error") return undefined;

	const text = response.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n");

	return sanitizeMessage(text);
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("checkpoint", {
		description: "Commit local git changes with an auto-generated message (never pushes)",
		handler: async (args, ctx) => {
			const override = args.trim();

			const inside = await git(pi, ctx, ["rev-parse", "--is-inside-work-tree"]);
			if (inside.code !== 0 || firstLine(inside.stdout) !== "true") {
				notify(ctx, "Not a git repository", "warning");
				return;
			}

			const status = await git(pi, ctx, ["status"]);
			if (status.code !== 0) {
				notify(ctx, status.stderr.trim() || "git status failed", "error");
				return;
			}

			notify(ctx, status.stdout.trim() || "git status");

			const porcelain = await git(pi, ctx, ["status", "--porcelain"]);
			if (porcelain.code !== 0) {
				notify(ctx, porcelain.stderr.trim() || "git status --porcelain failed", "error");
				return;
			}

			if (!porcelain.stdout.trim()) {
				notify(ctx, "Working tree clean — nothing to commit");
				return;
			}

			const add = await git(pi, ctx, ["add", "-A"]);
			if (add.code !== 0) {
				notify(ctx, add.stderr.trim() || "git add failed", "error");
				return;
			}

			const staged = await git(pi, ctx, ["diff", "--cached", "--quiet"]);
			if (staged.code === 0) {
				notify(ctx, "No staged changes to commit", "warning");
				return;
			}

			let message = override ? sanitizeMessage(override) : undefined;
			if (!message) {
				notify(ctx, "Generating commit message…");
				const stat = await git(pi, ctx, ["diff", "--cached", "--stat"]);
				const diff = await git(pi, ctx, ["diff", "--cached"], 30_000);
				try {
					message = await generateMessage(ctx, status.stdout, stat.stdout, diff.stdout);
				} catch (error) {
					notify(
						ctx,
						`Commit message model call failed, using fallback: ${error instanceof Error ? error.message : String(error)}`,
						"warning",
					);
				}
				message ??= fallbackMessage(porcelain.stdout);
			}

			const commitArgs = ["commit", "-m", message];
			const commit = await git(pi, ctx, commitArgs, 60_000);
			if (commit.code !== 0) {
				notify(ctx, (commit.stderr || commit.stdout).trim() || "git commit failed", "error");
				return;
			}

			const log = await git(pi, ctx, ["log", "-1", "--oneline"]);
			const summary = firstLine(log.stdout) || firstLine(commit.stdout) || message;
			notify(ctx, `Committed ${summary} (not pushed)`);
		},
	});
}
