import assert from "node:assert/strict";
import { test } from "node:test";
import { createUsageStore, describeUsageError, extractAccountId, loadStatusCard } from "./client.ts";
import { UsageError } from "./parser.ts";

const ACCOUNT_ID = "acct_test_123";
const TOKEN = makeJwt({
	"https://api.openai.com/auth": { chatgpt_account_id: ACCOUNT_ID },
});
const USAGE_BODY = {
	plan_type: "pro",
	primary_window: {
		used_percent: 32,
		window_minutes: 300,
		resets_at: 1_700_000_800,
	},
	secondary_window: {
		used_percent: 61,
		window_minutes: 10_080,
		resets_at: 1_700_008_000,
	},
};

function makeJwt(payload: unknown, { payloadRaw, parts }: { payloadRaw?: string; parts?: string[] } = {}): string {
	if (parts) return parts.join(".");
	const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
	const body = payloadRaw ?? Buffer.from(JSON.stringify(payload)).toString("base64url");
	return `${header}.${body}.signature`;
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

test("extracts the ChatGPT account ID from a valid JWT", () => {
	assert.equal(extractAccountId(TOKEN), ACCOUNT_ID);
});

test("rejects JWTs that are missing segments, not base64, not JSON, or missing the account claim", () => {
	assert.throws(() => extractAccountId("only-one-part"), (error: unknown) => {
		assert.ok(error instanceof UsageError);
		assert.equal(error.code, "invalid_token");
		assert.doesNotMatch(error.message, /only-one-part/);
		return true;
	});
	assert.throws(() => extractAccountId(makeJwt(null, { payloadRaw: "!!!" })), (error: unknown) => {
		assert.ok(error instanceof UsageError);
		assert.equal(error.code, "invalid_token");
		return true;
	});
	assert.throws(() => extractAccountId(makeJwt(null, { payloadRaw: Buffer.from("{").toString("base64url") })), (error: unknown) => {
		assert.ok(error instanceof UsageError);
		assert.equal(error.code, "invalid_token");
		return true;
	});
	assert.throws(() => extractAccountId(makeJwt({ sub: "user" })), (error: unknown) => {
		assert.ok(error instanceof UsageError);
		assert.equal(error.code, "invalid_token");
		return true;
	});
});

test("requests usage with bearer token and account header", async () => {
	const requests: Array<{ url: string; headers: Headers }> = [];
	const store = createUsageStore({
		now: () => 1_700_000_000_000,
		fetchImpl: async (input, init) => {
			requests.push({ url: String(input), headers: new Headers(init?.headers) });
			return jsonResponse(USAGE_BODY);
		},
	});

	const snapshot = await store.refresh(async () => ({ auth: { apiKey: TOKEN } }));
	assert.equal(requests.length, 1);
	assert.equal(requests[0]?.url, "https://chatgpt.com/backend-api/wham/usage");
	assert.equal(requests[0]?.headers.get("authorization"), `Bearer ${TOKEN}`);
	assert.equal(requests[0]?.headers.get("chatgpt-account-id"), ACCOUNT_ID);
	assert.equal(requests[0]?.headers.get("accept"), "application/json");
	assert.equal(snapshot.planType, "pro");
	assert.equal(snapshot.fiveHour?.usedPercent, 32);
	assert.equal(store.snapshot(), snapshot);
	assert.equal(store.stale(), false);
});

test("maps HTTP 401 and 403 to unauthorized without echoing the body", async () => {
	for (const status of [401, 403]) {
		const store = createUsageStore({
			fetchImpl: async () => new Response(`secret token=${TOKEN} account=${ACCOUNT_ID}`, { status }),
		});
		await assert.rejects(
			() => store.refresh(async () => ({ auth: { apiKey: TOKEN } })),
			(error: unknown) => {
				assert.ok(error instanceof UsageError);
				assert.equal(error.code, "unauthorized");
				assert.equal(error.status, status);
				assert.doesNotMatch(error.message, new RegExp(TOKEN));
				assert.doesNotMatch(error.message, new RegExp(ACCOUNT_ID));
				assert.doesNotMatch(error.message, /secret/i);
				return true;
			},
		);
	}
});

test("reports other HTTP errors by status code only", async () => {
	const store = createUsageStore({
		fetchImpl: async () => new Response(`internal ${TOKEN}`, { status: 500 }),
	});
	await assert.rejects(
		() => store.refresh(async () => ({ auth: { apiKey: TOKEN } })),
		(error: unknown) => {
			assert.ok(error instanceof UsageError);
			assert.equal(error.code, "http_error");
			assert.equal(error.status, 500);
			assert.match(error.message, /500/);
			assert.doesNotMatch(error.message, new RegExp(TOKEN));
			return true;
		},
	);
});

test("maps timeouts and invalid JSON to stable error categories", async () => {
	const timeoutStore = createUsageStore({
		timeoutMs: 20,
		fetchImpl: async (_input, init) => {
			await new Promise((_, reject) => {
				init?.signal?.addEventListener("abort", () => {
					const error = new Error("aborted");
					error.name = "AbortError";
					reject(error);
				});
			});
			return jsonResponse(USAGE_BODY);
		},
	});
	await assert.rejects(
		() => timeoutStore.refresh(async () => ({ auth: { apiKey: TOKEN } })),
		(error: unknown) => {
			assert.ok(error instanceof UsageError);
			assert.equal(error.code, "request_timeout");
			return true;
		},
	);

	const jsonStore = createUsageStore({
		fetchImpl: async () => new Response(`{"token":"${TOKEN}"`, { status: 200 }),
	});
	await assert.rejects(
		() => jsonStore.refresh(async () => ({ auth: { apiKey: TOKEN } })),
		(error: unknown) => {
			assert.ok(error instanceof UsageError);
			assert.equal(error.code, "invalid_response");
			assert.doesNotMatch(error.message, new RegExp(TOKEN));
			return true;
		},
	);
});

test("keeps the last successful snapshot and marks it stale after a later failure", async () => {
	let fail = false;
	const store = createUsageStore({
		now: () => 1_700_000_000_000,
		fetchImpl: async () => {
			if (fail) throw new Error("network down");
			return jsonResponse(USAGE_BODY);
		},
	});

	const first = await store.refresh(async () => ({ auth: { apiKey: TOKEN } }));
	fail = true;
	await assert.rejects(() => store.refresh(async () => ({ auth: { apiKey: TOKEN } })), UsageError);
	assert.equal(store.snapshot(), first);
	assert.equal(store.stale(), true);
});

test("reuses an in-flight refresh so concurrent triggers issue one HTTP request", async () => {
	let started = 0;
	let release: ((response: Response) => void) | undefined;
	const store = createUsageStore({
		now: () => 1_700_000_000_000,
		fetchImpl: async () => {
			started += 1;
			return await new Promise<Response>((resolve) => {
				release = resolve;
			});
		},
	});

	const first = store.refresh(async () => ({ auth: { apiKey: TOKEN } }));
	const second = store.refresh(async () => ({ auth: { apiKey: TOKEN } }));
	await Promise.resolve();
	assert.equal(started, 1);
	release?.(jsonResponse(USAGE_BODY));
	const [left, right] = await Promise.all([first, second]);
	assert.equal(left, right);
	assert.equal(started, 1);
});

test("maps OAuth refresh failures to invalid_token", async () => {
	const store = createUsageStore({ fetchImpl: async () => jsonResponse(USAGE_BODY) });
	await assert.rejects(
		() => store.refresh(async () => {
			throw new Error(`refresh failed for ${TOKEN}`);
		}),
		(error: unknown) => {
			assert.ok(error instanceof UsageError);
			assert.equal(error.code, "invalid_token");
			assert.doesNotMatch(error.message, new RegExp(TOKEN));
			return true;
		},
	);
});

test("status card load keeps stale cache when a later refresh fails", async () => {
	let fail = false;
	const store = createUsageStore({
		now: () => 1_700_000_000_000,
		fetchImpl: async () => {
			if (fail) throw new Error("network down");
			return jsonResponse(USAGE_BODY);
		},
	});

	const first = await loadStatusCard(store, async () => ({ auth: { apiKey: TOKEN } }));
	assert.equal(first.stale, false);
	assert.equal(first.error, undefined);

	fail = true;
	const stale = await loadStatusCard(store, async () => ({ auth: { apiKey: TOKEN } }));
	assert.equal(stale.snapshot, first.snapshot);
	assert.equal(stale.stale, true);
	assert.equal(stale.error?.code, "http_error");
});

test("status card load without cache surfaces the original error", async () => {
	const store = createUsageStore({
		fetchImpl: async () => new Response("nope", { status: 500 }),
	});
	await assert.rejects(
		() => loadStatusCard(store, async () => ({ auth: { apiKey: TOKEN } })),
		(error: unknown) => {
			assert.ok(error instanceof UsageError);
			assert.equal(error.code, "http_error");
			return true;
		},
	);
});

test("treats missing OAuth as not_authenticated", async () => {
	const store = createUsageStore({ fetchImpl: async () => jsonResponse(USAGE_BODY) });
	await assert.rejects(
		() => store.refresh(async () => undefined),
		(error: unknown) => {
			assert.ok(error instanceof UsageError);
			assert.equal(error.code, "not_authenticated");
			return true;
		},
	);
});

test("user-facing errors suggest recovery and never include secrets", () => {
	const errors = [
		new UsageError("not_authenticated", "hidden"),
		new UsageError("invalid_token", TOKEN),
		new UsageError("request_timeout", ACCOUNT_ID),
		new UsageError("unauthorized", TOKEN, 401),
		new UsageError("http_error", TOKEN, 500),
		new UsageError("invalid_response", TOKEN),
	];
	for (const error of errors) {
		const text = describeUsageError(error);
		assert.doesNotMatch(text, new RegExp(TOKEN));
		assert.doesNotMatch(text, new RegExp(ACCOUNT_ID));
	}
	assert.match(describeUsageError(new UsageError("not_authenticated", "x")), /\/login openai-codex/);
	assert.match(describeUsageError(new UsageError("invalid_token", "x")), /\/logout openai-codex/);
	assert.match(describeUsageError(new UsageError("request_timeout", "x")), /\/status/);
	assert.match(describeUsageError(new UsageError("invalid_response", "x")), /upgrade|升级/i);
});

test("does not store token, JWT, or account ID on the snapshot", async () => {
	const store = createUsageStore({
		now: () => 1_700_000_000_000,
		fetchImpl: async () => jsonResponse(USAGE_BODY),
	});
	const snapshot = await store.refresh(async () => ({ auth: { apiKey: TOKEN } }));
	const serialized = JSON.stringify(snapshot);
	assert.doesNotMatch(serialized, new RegExp(TOKEN));
	assert.doesNotMatch(serialized, new RegExp(ACCOUNT_ID));
});
