import { stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export const NESTED_SNAPSHOT_ENTRY = "pretty-tui-nested-results";
export const NESTED_LIMITS = { calls: 256, args: 4096, output: 8192, total: 131072 };
type Status = "running" | "ok" | "error" | "cancelled";
export type NestedCall = {
  id: string; parentId: string; name: string; args: string; status: Status;
  startedAt?: number; durationMs?: number; output?: string; truncated?: boolean; argsTruncated?: boolean;
};
export type NestedSnapshot = { version: 1; rootId: string; calls: NestedCall[]; incomplete: boolean };
const safeText = (value: string) => stripTerminalSequences(value).replace(/[\x00-\x08\x0b-\x1f\x7f]/gu, "");
const bounded = (text: string, limit: number) => safeText(text).slice(0, limit);
const argsText = (args: any): string => {
  try {
    return bounded(JSON.stringify(args ?? {}, (key, value) =>
      /token|secret|password|credential|authorization|api[_-]?key/iu.test(key) ? "[redacted]" : value,
    ), NESTED_LIMITS.args);
  } catch { return "[arguments unavailable]"; }
};
const recordedArgs = (value: string): string => {
  try { return argsText(JSON.parse(value)); } catch {
    return bounded(value.replace(/("[^"\n]*(?:token|secret|password|credential|authorization|api[_-]?key)[^"\n]*"\s*:\s*)("(?:\\.|[^"\\])*"|[^,}\n]*)/giu, '$1"[redacted]"'), NESTED_LIMITS.args);
  }
};
const resultText = (result: any): string => {
  const text = (Array.isArray(result?.content) ? result.content : [])
    .filter((block: any) => block?.type === "text" && typeof block.text === "string")
    .map((block: any) => block.text).join("\n");
  // Edit renderers carry their useful diff separately from the success message.
  const diff = typeof result?.details?.diff === "string" ? result.details.diff : "";
  let structured = "";
  if (!text && result?.structuredContent !== undefined) {
    try { structured = JSON.stringify(result.structuredContent, null, 2); } catch { /* non-JSON result */ }
  }
  const media = (result?.content ?? []).some((block: any) => block?.type === "image")
    ? "[Image result omitted from nested text preview]" : "";
  const error = !text && typeof result?.details?.error === "string" ? result.details.error : "";
  return safeText([text, diff, structured, media, error].filter(Boolean).join("\n"));
};

const compactArgs = (value: string): string => {
  try {
    const args = JSON.parse(value);
    if (!args || typeof args !== "object" || Array.isArray(args)) return value;
    return Object.entries(args)
      .filter(([key]) => !/token|secret|password|credential|authorization|api[_-]?key/iu.test(key))
      .slice(0, 3).map(([key, entry]) => `${key}=${typeof entry === "string" ? entry : JSON.stringify(entry)}`)
      .join(" · ").replace(/\s+/gu, " ");
  } catch { return value.replace(/\s+/gu, " "); }
};

/** UI-only nested execution state. Never executes tools or alters model results. */
export class NestedTools {
  private calls = new Map<string, NestedCall>();
  private incomplete = new Set<string>();
  // Local overrides can close one disclosure even after global expansion.
  private expanded = new Map<string, boolean>();
  clearExpansion() { this.expanded.clear(); }
  clear() { this.calls.clear(); this.incomplete.clear(); this.clearExpansion(); }
  toggle(key: string, globallyExpanded = false) {
    this.expanded.set(key, !(this.expanded.get(key) ?? globallyExpanded));
  }
  private isExpanded(key: string, globallyExpanded: boolean): boolean {
    return this.expanded.get(key) ?? globallyExpanded;
  }
  root(id: string): string {
    const seen = new Set<string>();
    while (this.calls.has(id) && !seen.has(id)) {
      seen.add(id); id = this.calls.get(id)!.parentId;
    }
    return id;
  }
  children(parentId: string): NestedCall[] {
    return [...this.calls.values()].filter((call) => call.parentId === parentId);
  }
  count(rootId: string): number {
    return [...this.calls.values()].filter((call) => this.root(call.id) === rootId).length;
  }
  start(event: any) {
    if (!event.parentToolCallId || this.calls.has(event.toolCallId)) return;
    const rootId = this.root(event.parentToolCallId);
    if (this.count(rootId) >= NESTED_LIMITS.calls) { this.incomplete.add(rootId); return; }
    const args = argsText(event.args);
    const argsTruncated = args.length >= NESTED_LIMITS.args;
    if (argsTruncated) this.incomplete.add(rootId);
    this.calls.set(event.toolCallId, {
      id: event.toolCallId, parentId: event.parentToolCallId, name: bounded(String(event.toolName ?? "tool"), 256),
      args, argsTruncated, status: "running", startedAt: Date.now(),
    });
  }
  update(event: any, finished = false) {
    const call = this.calls.get(event.toolCallId);
    if (!call) return;
    const text = resultText(finished ? event.result : event.partialResult);
    const rootId = this.root(call.id);
    const otherSize = [...this.calls.values()].filter((other) => other.id !== call.id && this.root(other.id) === rootId)
      .reduce((size, other) => size + other.args.length + (other.output?.length ?? 0), 0);
    const limit = Math.max(0, Math.min(NESTED_LIMITS.output, NESTED_LIMITS.total - otherSize - call.args.length));
    call.output = text.slice(0, limit);
    call.truncated = text.length > limit;
    if (call.truncated) this.incomplete.add(rootId);
    if (finished) {
      call.status = event.isError ? "error" : "ok";
      call.durationMs = Math.max(0, Date.now() - (call.startedAt ?? Date.now()));
    }
  }
  finish(rootId: string): boolean {
    let changed = false;
    for (const call of this.calls.values()) {
      if (this.root(call.id) === rootId && call.status === "running") {
        call.status = "cancelled"; changed = true;
      }
    }
    return changed;
  }
  finishAll(): string[] {
    const roots = new Set([...this.calls.values()].map((call) => this.root(call.id)));
    return [...roots].filter((rootId) => this.finish(rootId));
  }
  /** Persisted host metadata is a fallback, not a substitute for actual results. */
  absorb(rootId: string, records: any, complete = true) {
    if (records && !Array.isArray(records) && Array.isArray(records.calls)) {
      complete &&= records.complete !== false;
      records = records.calls;
    }
    if (!Array.isArray(records)) return;
    for (const record of records) {
      if (typeof record?.id !== "string" || typeof record?.name !== "string" || record.id.endsWith("/?")) continue;
      const existing = this.calls.get(record.id);
      if (existing) {
        if (record.status === "cancelled" || record.status === "unfinished") existing.status = "cancelled";
        else if (record.status === "error" || record.status === "ok") existing.status = record.status;
        if (typeof record.durationMs === "number") existing.durationMs = record.durationMs;
        continue;
      }
      if (this.count(rootId) >= NESTED_LIMITS.calls) { this.incomplete.add(rootId); break; }
      const slash = record.id.lastIndexOf("/");
      const candidate = record.id.slice(0, slash);
      const parentId = this.calls.has(candidate) ? candidate : rootId;
      this.calls.set(record.id, {
        id: record.id, parentId, name: bounded(record.name, 256),
        args: typeof record.args === "string" ? recordedArgs(record.args) : record.argumentsBytes !== undefined ? "[Arguments omitted by Pi]" : argsText(record.arguments),
        argsTruncated: record.argumentsBytes !== undefined,
        status: record.status === "error" ? "error" : record.status === "cancelled" || record.status === "unfinished" ? "cancelled" : record.status === "running" ? "running" : "ok",
        durationMs: typeof record.durationMs === "number" ? record.durationMs : undefined,
        output: typeof record.error === "string" ? bounded(record.error, NESTED_LIMITS.output) : undefined,
      });
    }
    if (!complete) this.incomplete.add(rootId);
  }
  snapshot(rootId: string): NestedSnapshot | undefined {
    const calls: NestedCall[] = [];
    let budget = NESTED_LIMITS.total;
    let incomplete = this.incomplete.has(rootId);
    for (const call of this.calls.values()) {
      if (this.root(call.id) !== rootId) continue;
      const { startedAt: _startedAt, ...copy } = call;
      copy.args = copy.args.slice(0, Math.max(0, budget));
      budget -= copy.args.length;
      if (copy.output !== undefined) {
        copy.output = copy.output.slice(0, Math.max(0, budget));
        budget -= copy.output.length;
        copy.truncated ||= copy.output.length < (call.output?.length ?? 0);
      }
      copy.argsTruncated ||= copy.args.length < call.args.length;
      incomplete ||= Boolean(copy.argsTruncated || copy.truncated);
      if (copy.status === "running") copy.status = "cancelled";
      calls.push(copy);
    }
    if (!calls.length) return undefined;
    return { version: 1, rootId, calls, incomplete };
  }
  restore(data: any) {
    if (data?.version !== 1 || typeof data.rootId !== "string" || !Array.isArray(data.calls)) return;
    // Snapshot entries originate locally; still validate and bound every field.
    let budget = NESTED_LIMITS.total;
    for (const call of data.calls.slice(0, NESTED_LIMITS.calls)) {
      if (typeof call?.id !== "string" || typeof call.parentId !== "string" || typeof call.name !== "string") continue;
      const args = bounded(String(call.args ?? ""), Math.min(NESTED_LIMITS.args, budget));
      budget -= args.length;
      const output = typeof call.output === "string" ? bounded(call.output, Math.min(NESTED_LIMITS.output, budget)) : undefined;
      budget -= output?.length ?? 0;
      this.calls.set(call.id, { id: call.id, parentId: call.parentId, name: bounded(call.name, 256), args, output,
        status: call.status === "error" ? "error" : call.status === "cancelled" || call.status === "running" ? "cancelled" : "ok",
        durationMs: typeof call.durationMs === "number" ? call.durationMs : undefined, truncated: Boolean(call.truncated), argsTruncated: Boolean(call.argsTruncated) });
    }
    if (data.incomplete) this.incomplete.add(data.rootId);
  }
  render(owner: any, width: number, theme: any): { lines: string[]; actions: Map<number, string> } {
    const rootId = owner.toolCallId;
    const actions = new Map<number, string>();
    const count = this.count(rootId);
    const failed = [...this.calls.values()].filter((call) => this.root(call.id) === rootId && call.status === "error").length;
    const color = owner.result?.isError ? "error" : owner.result && !owner.isPartial ? "success" : "dim";
    const label = owner.toolDefinition?.label ?? owner.toolName;
    const lines = [theme.fg(color, "● ") + theme.fg("text", theme.bold(label)) +
      theme.fg("muted", `(${count} nested ${count === 1 ? "call" : "calls"}${failed ? ` · ${failed} failed` : ""})`)];
    const detail = (text: string, prefix: string, action?: string) => {
      const push = (line: string) => {
        if (action) actions.set(lines.length, action);
        lines.push(line);
      };
      const available = Math.max(1, width - visibleWidth(prefix));
      let rows = 0;
      for (const line of bounded(text, NESTED_LIMITS.output).split("\n")) {
        for (const wrapped of wrapTextWithAnsi(line || " ", available)) {
          if (++rows > 200) { push(theme.fg("dim", prefix + "[Preview truncated]")); return; }
          push(theme.fg("dim", prefix) + theme.fg("toolOutput", wrapped));
        }
      }
      if (safeText(text).length > NESTED_LIMITS.output) push(theme.fg("dim", prefix + "[Preview truncated]"));
    };
    const items = this.children(rootId);
    const visit = (call: NestedCall, indent: string, last: boolean, depth: number) => {
      const prefix = indent + (last ? "└─ " : "├─ ");
      const continuation = indent + (last ? "   " : "│  ");
      const icon = call.status === "cancelled" ? "⊘" : "●";
      const callColor = call.status === "ok" ? "success" : call.status === "error" ? "error" : call.status === "running" ? "dim" : "muted";
      actions.set(lines.length, call.id);
      const duration = call.durationMs === undefined ? "" : ` · ${call.durationMs < 1000 ? `${Math.round(call.durationMs)}ms` : `${(call.durationMs / 1000).toFixed(1)}s`}`;
      const descendants = this.children(call.id);
      lines.push(theme.fg("dim", prefix) + theme.fg(callColor, icon + " ") + theme.fg("text", theme.bold(call.name)) + theme.fg("muted", `(${compactArgs(call.args)})${duration}`));
      const expanded = this.isExpanded(call.id, Boolean(owner.expanded));
      const first = call.output?.split("\n").find((line) => line.trim());
      const summary = first ?? (call.status === "running" ? "Running…" : call.truncated ? "Output omitted by UI size limit" : call.output === undefined ? "Only call metadata retained" : "No text output");
      actions.set(lines.length, call.id);
      lines.push(theme.fg("dim", continuation + (descendants.length ? "├ " : "└ ")) + theme.fg(call.status === "error" ? "error" : "muted", summary));
      if (expanded) {
        detail(`Arguments: ${call.args}`, continuation + "  ", call.id);
        if (call.output) detail(call.output, continuation + "  ", call.id);
        if (call.argsTruncated) detail("[Arguments truncated in UI snapshot]", continuation + "  ", call.id);
        if (call.truncated) detail("[Output truncated in UI snapshot]", continuation + "  ", call.id);
      }
      if (depth < 7) descendants.forEach((child, index, children) => visit(child, continuation, index === children.length - 1, depth + 1));
      else if (descendants.length) detail("[Deeper calls omitted]", continuation);
    };
    const code = typeof owner.args?.code === "string" ? owner.args.code : undefined;
    if (code) {
      const key = `${rootId}:script`;
      actions.set(lines.length, key); lines.push(theme.fg("dim", "  ├─ ") + theme.fg("mdLink", "[Script]"));
      if (this.isExpanded(key, Boolean(owner.expanded))) detail(code, "  │  ", key);
    }
    items.forEach((call) => visit(call, "  ", false, 0));
    const key = `${rootId}:output`;
    actions.set(lines.length, key);
    lines.push(theme.fg("dim", "  └─ ") + theme.fg("mdLink", code ? "[Script output]" : "[Output]"));
    if (this.isExpanded(key, Boolean(owner.expanded))) detail(resultText(owner.result) || (owner.isPartial || !owner.result ? "Running…" : "No text output"), "     ", key);
    if (this.incomplete.has(rootId)) lines.push(theme.fg("warning", "  [Nested call record is incomplete or truncated]"));
    return { lines: lines.map((line) => truncateToWidth(line, Math.max(1, width), "…")), actions };
  }
}
