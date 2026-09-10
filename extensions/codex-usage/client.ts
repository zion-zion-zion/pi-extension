import { parseUsageResponse, UsageError, type UsageSnapshot } from "./parser.ts";

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const JWT_AUTH_CLAIM = "https://api.openai.com/auth";
const DEFAULT_TIMEOUT_MS = 10_000;

export interface ProviderAuthLike {
	auth?: {
		apiKey?: string;
	};
}

export type GetProviderAuth = () => Promise<ProviderAuthLike | undefined>;

export interface UsageStoreOptions {
	now?: () => number;
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
}

export interface UsageStore {
	refresh(getAuth: GetProviderAuth): Promise<UsageSnapshot>;
	snapshot(): UsageSnapshot | undefined;
	stale(): boolean;
}

export function extractAccountId(token: string): string {
	const parts = token.split(".");
	if (parts.length !== 3) {
		throw new UsageError("invalid_token", "Codex OAuth token is invalid.");
	}

	let payload: unknown;
	try {
		payload = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8"));
	} catch {
		throw new UsageError("invalid_token", "Codex OAuth token is invalid.");
	}

	if (!isRecord(payload)) {
		throw new UsageError("invalid_token", "Codex OAuth token is invalid.");
	}

	const auth = payload[JWT_AUTH_CLAIM];
	const accountId = isRecord(auth) ? auth.chatgpt_account_id : undefined;
	if (typeof accountId !== "string" || accountId.length === 0) {
		throw new UsageError("invalid_token", "Codex OAuth token is invalid.");
	}
	return accountId;
}

export function createUsageStore(options: UsageStoreOptions = {}): UsageStore {
	const now = options.now ?? Date.now;
	const fetchImpl = options.fetchImpl ?? fetch;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	let latestSnapshot: UsageSnapshot | undefined;
	let isStale = false;
	let refreshInFlight: Promise<UsageSnapshot> | undefined;

	const refresh = (getAuth: GetProviderAuth): Promise<UsageSnapshot> => {
		if (refreshInFlight) return refreshInFlight;

		refreshInFlight = (async () => {
			try {
				const snapshot = await fetchUsageSnapshot({ getAuth, now, fetchImpl, timeoutMs });
				latestSnapshot = snapshot;
				isStale = false;
				return snapshot;
			} catch (error) {
				if (latestSnapshot) isStale = true;
				throw toUsageError(error);
			}
		})().finally(() => {
			refreshInFlight = undefined;
		});

		return refreshInFlight;
	};

	return {
		refresh,
		snapshot: () => latestSnapshot,
		stale: () => isStale,
	};
}

export async function loadStatusCard(
	store: UsageStore,
	getAuth: GetProviderAuth,
): Promise<{ snapshot: UsageSnapshot; stale: boolean; error?: UsageError }> {
	try {
		const snapshot = await store.refresh(getAuth);
		return { snapshot, stale: false };
	} catch (error) {
		const usageError = toUsageError(error);
		const snapshot = store.snapshot();
		if (snapshot) return { snapshot, stale: true, error: usageError };
		throw usageError;
	}
}

export function describeUsageError(error: UsageError): string {
	switch (error.code) {
		case "not_authenticated":
			return "Codex is not logged in. Run /login openai-codex.";
		case "invalid_token":
		case "unauthorized":
			return "Codex OAuth is invalid. Run /logout openai-codex, then log in again.";
		case "request_timeout":
			return "Codex usage request timed out. Check the network, then retry /status.";
		case "http_error":
			return error.status
				? `Codex usage request failed (${error.status}). Check the network, then retry /status.`
				: "Codex usage request failed. Check the network, then retry /status.";
		case "invalid_response":
			return "Codex usage response is incompatible. Upgrade the extension or Pi.";
	}
}

async function fetchUsageSnapshot(input: {
	getAuth: GetProviderAuth;
	now: () => number;
	fetchImpl: typeof fetch;
	timeoutMs: number;
}): Promise<UsageSnapshot> {
	let auth: ProviderAuthLike | undefined;
	try {
		auth = await input.getAuth();
	} catch {
		throw new UsageError("invalid_token", "Codex OAuth is invalid.");
	}
	const token = auth?.auth?.apiKey;
	if (!token) {
		throw new UsageError("not_authenticated", "Codex is not logged in.");
	}

	const accountId = extractAccountId(token);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), input.timeoutMs);
	timer.unref?.();

	let response: Response;
	try {
		response = await input.fetchImpl(USAGE_URL, {
			method: "GET",
			headers: {
				Authorization: `Bearer ${token}`,
				"ChatGPT-Account-ID": accountId,
				Accept: "application/json",
			},
			signal: controller.signal,
		});
	} catch (error) {
		throw toUsageError(error);
	} finally {
		clearTimeout(timer);
	}

	if (response.status === 401 || response.status === 403) {
		throw new UsageError("unauthorized", "Codex usage request was unauthorized.", response.status);
	}
	if (!response.ok) {
		throw new UsageError("http_error", `Codex usage request failed (${response.status}).`, response.status);
	}

	let payload: unknown;
	try {
		payload = await response.json();
	} catch {
		throw new UsageError("invalid_response", "Codex usage response is incompatible.");
	}

	return parseUsageResponse(payload, input.now());
}

function toUsageError(error: unknown): UsageError {
	if (error instanceof UsageError) return error;
	if (isAbortError(error)) {
		return new UsageError("request_timeout", "Codex usage request timed out.");
	}
	return new UsageError("http_error", "Codex usage request failed.");
}

function isAbortError(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	const name = "name" in error ? String(error.name) : "";
	return name === "AbortError" || name === "TimeoutError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
