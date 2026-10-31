import { parseQuotasResponse, QuotaError, type QuotaSnapshot } from "./parser.ts";

export const DEFAULT_QUOTAS_URL = "http://127.0.0.1:3425/v1/magpie/quotas";
const DEFAULT_TIMEOUT_MS = 3_000;

export interface QuotaStoreOptions {
	now?: () => number;
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
	url?: string;
}

export interface QuotaStore {
	refresh(): Promise<QuotaSnapshot>;
	snapshot(): QuotaSnapshot | undefined;
	stale(): boolean;
}

export function createQuotaStore(options: QuotaStoreOptions = {}): QuotaStore {
	const now = options.now ?? Date.now;
	const fetchImpl = options.fetchImpl ?? fetch;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const url = options.url ?? DEFAULT_QUOTAS_URL;

	let latest: QuotaSnapshot | undefined;
	let isStale = false;
	let inFlight: Promise<QuotaSnapshot> | undefined;

	const refresh = (): Promise<QuotaSnapshot> => {
		if (inFlight) return inFlight;

		inFlight = (async () => {
			try {
				const snapshot = await fetchQuotas({ url, now, fetchImpl, timeoutMs });
				latest = snapshot;
				isStale = false;
				return snapshot;
			} catch (error) {
				if (latest) isStale = true;
				throw toQuotaError(error);
			}
		})().finally(() => {
			inFlight = undefined;
		});

		return inFlight;
	};

	return {
		refresh,
		snapshot: () => latest,
		stale: () => isStale,
	};
}

export async function fetchQuotas(options: {
	url: string;
	now: () => number;
	fetchImpl: typeof fetch;
	timeoutMs: number;
}): Promise<QuotaSnapshot> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), options.timeoutMs);
	try {
		const response = await options.fetchImpl(options.url, { signal: controller.signal });
		if (!response.ok) {
			throw new QuotaError("http_error", `Magpie quotas request failed (${response.status}).`, response.status);
		}
		let payload: unknown;
		try {
			payload = await response.json();
		} catch {
			throw new QuotaError("invalid_response", "Magpie quotas response is incompatible.");
		}
		return parseQuotasResponse(payload, options.now());
	} catch (error) {
		throw toQuotaError(error);
	} finally {
		clearTimeout(timer);
	}
}

export function describeQuotaError(error: QuotaError): string {
	switch (error.code) {
		case "unreachable":
			return "连不上 magpie。确认菜单栏里的 magpie 正在运行。";
		case "request_timeout":
			return "读取 magpie 额度超时。";
		case "http_error":
			return error.status ? `magpie 额度接口返回 ${error.status}。` : "magpie 额度接口请求失败。";
		case "invalid_response":
			return "magpie 额度数据格式变了，这个扩展读不懂。";
	}
}

function toQuotaError(error: unknown): QuotaError {
	if (error instanceof QuotaError) return error;
	if (isAbortError(error)) return new QuotaError("request_timeout", "Magpie quotas request timed out.");
	if (isNetworkError(error)) return new QuotaError("unreachable", "Magpie is not reachable.");
	return new QuotaError("http_error", "Magpie quotas request failed.");
}

function isAbortError(error: unknown): boolean {
	return isRecord(error) && error.name === "AbortError";
}

function isNetworkError(error: unknown): boolean {
	if (!isRecord(error)) return false;
	const message = typeof error.message === "string" ? error.message : "";
	return error.name === "TypeError" || /fetch failed|ECONNREFUSED|ENOTFOUND|network/i.test(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
