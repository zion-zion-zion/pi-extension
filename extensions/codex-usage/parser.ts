export type UsageErrorCode =
	| "not_authenticated"
	| "invalid_token"
	| "request_timeout"
	| "unauthorized"
	| "http_error"
	| "invalid_response";

export class UsageError extends Error {
	readonly code: UsageErrorCode;
	readonly status?: number;

	constructor(code: UsageErrorCode, message: string, status?: number) {
		super(message);
		this.name = "UsageError";
		this.code = code;
		this.status = status;
	}
}

export interface UsageWindow {
	usedPercent: number;
	resetAt?: number;
	windowMinutes?: number;
}

export interface UsageSnapshot {
	planType?: string;
	fiveHour?: UsageWindow;
	weekly?: UsageWindow;
	fetchedAt: number;
}

const FIVE_HOUR_MINUTES = 300;
const WEEKLY_MINUTES = 10_080;
const WINDOW_TOLERANCE_MINUTES = 30;

export function parseUsageResponse(payload: unknown, fetchedAt: number): UsageSnapshot {
	if (!isRecord(payload)) {
		throw new UsageError("invalid_response", "Codex usage response is incompatible.");
	}

	const windows = collectWindows(payload);
	let fiveHour: UsageWindow | undefined;
	let weekly: UsageWindow | undefined;

	for (const candidate of windows) {
		if (!candidate.window) continue;
		const kind = classifyWindow(candidate);
		if (kind === "fiveHour" && !fiveHour) fiveHour = candidate.window;
		else if (kind === "weekly" && !weekly) weekly = candidate.window;
	}

	if (!fiveHour || !weekly) {
		for (const candidate of windows) {
			if (!candidate.window) continue;
			if (!fiveHour && candidate.fallback === "fiveHour") fiveHour = candidate.window;
			else if (!weekly && candidate.fallback === "weekly") weekly = candidate.window;
		}
	}

	if (!fiveHour && !weekly) {
		throw new UsageError("invalid_response", "Codex usage data is unavailable.");
	}

	return {
		planType: readPlanType(payload),
		fiveHour,
		weekly,
		fetchedAt,
	};
}

interface WindowCandidate {
	window?: UsageWindow;
	fallback?: "fiveHour" | "weekly";
}

function collectWindows(payload: Record<string, unknown>): WindowCandidate[] {
	const candidates: WindowCandidate[] = [];
	const seen = new Set<unknown>();

	const visit = (value: unknown, keyHint?: string) => {
		if (!isRecord(value) || seen.has(value)) return;
		seen.add(value);

		const parsed = parseWindow(value);
		if (parsed || looksLikeWindow(value)) {
			candidates.push({
				window: parsed,
				fallback: fallbackFromKey(keyHint),
			});
		}

		for (const [key, nested] of Object.entries(value)) {
			if (isRecord(nested) || Array.isArray(nested)) visit(nested, key);
		}
	};

	visit(payload);
	return candidates;
}

function parseWindow(value: Record<string, unknown>): UsageWindow | undefined {
	const usedPercent = readUsedPercent(value);
	if (usedPercent === undefined) return undefined;

	const window: UsageWindow = { usedPercent };
	const windowMinutes = readWindowMinutes(value);
	if (windowMinutes !== undefined) window.windowMinutes = windowMinutes;
	const resetAt = readResetAt(value);
	if (resetAt !== undefined) window.resetAt = resetAt;
	return window;
}

function looksLikeWindow(value: Record<string, unknown>): boolean {
	return (
		hasOwn(value, "used_percent") ||
		hasOwn(value, "usedPercent") ||
		hasOwn(value, "window_minutes") ||
		hasOwn(value, "windowMinutes") ||
		hasOwn(value, "window_duration_mins") ||
		hasOwn(value, "resets_at") ||
		hasOwn(value, "resetsAt")
	);
}

function classifyWindow(candidate: WindowCandidate): "fiveHour" | "weekly" | "unknown" {
	const minutes = candidate.window?.windowMinutes;
	if (minutes === undefined) return "unknown";
	if (Math.abs(minutes - FIVE_HOUR_MINUTES) <= WINDOW_TOLERANCE_MINUTES) return "fiveHour";
	if (Math.abs(minutes - WEEKLY_MINUTES) <= WINDOW_TOLERANCE_MINUTES) return "weekly";
	return "unknown";
}

function fallbackFromKey(key?: string): "fiveHour" | "weekly" | undefined {
	if (!key) return undefined;
	const normalized = key.toLowerCase().replace(/[^a-z]/g, "");
	if (normalized === "primary" || normalized === "primarywindow") return "fiveHour";
	if (normalized === "secondary" || normalized === "secondarywindow") return "weekly";
	return undefined;
}

function readPlanType(payload: Record<string, unknown>): string | undefined {
	const direct = asNonEmptyString(payload.plan_type) ?? asNonEmptyString(payload.planType);
	if (direct) return direct;

	for (const nested of Object.values(payload)) {
		if (!isRecord(nested)) continue;
		const fromNested = asNonEmptyString(nested.plan_type) ?? asNonEmptyString(nested.planType);
		if (fromNested) return fromNested;
	}
	return undefined;
}

function readUsedPercent(value: Record<string, unknown>): number | undefined {
	const raw = value.used_percent ?? value.usedPercent;
	if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
	return clamp(raw, 0, 100);
}

function readWindowMinutes(value: Record<string, unknown>): number | undefined {
	const raw = value.window_minutes ?? value.windowMinutes ?? value.window_duration_mins;
	if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return undefined;
	return raw;
}

function readResetAt(value: Record<string, unknown>): number | undefined {
	const raw = value.resets_at ?? value.resetsAt ?? value.reset_at ?? value.resetAt;
	if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return undefined;
	return raw < 1e12 ? Math.round(raw * 1000) : Math.round(raw);
}

function asNonEmptyString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed ? trimmed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(value, key);
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}
