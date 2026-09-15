// herdr-session-title: report the pi session name to herdr as a pane token.
//
// herdr can render pane metadata tokens in its Agent sidebar rows as `$name`.
// Nothing else reports the pi session name (the OSC terminal title carries the
// whole "π - <name> - <cwd>" string, which is too long for a sidebar row), so
// this extension pushes just the name and keeps it in sync on rename.
//
// Sidebar config this is meant for (see README):
//   [ui.sidebar.agents]
//   rows = [["state_icon", "machine", "workspace", "tab"], ["agent", "$pi_session"]]

import net from "node:net";

const PANE_ID = process.env.HERDR_PANE_ID;
const SOCKET_PATH = process.env.HERDR_SOCKET_PATH;
const SOCKET_ENDPOINT =
  process.platform === "win32" && SOCKET_PATH ? `\\\\.\\pipe\\${SOCKET_PATH}` : SOCKET_PATH;

// herdr restricts --source to ASCII letters, digits, colon, dot, underscore, hyphen.
const SOURCE = "pi:session-title";
// Pane token name: must be 1-32 ASCII letters/digits/underscore/hyphen.
const TOKEN = "pi_session";

function enabled(): boolean {
  return process.env.HERDR_ENV === "1" && !!SOCKET_ENDPOINT && !!PANE_ID;
}

function sendRequestAttempt(request: unknown, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = (delivered: boolean) => {
      if (done) return;
      done = true;
      if (timeout) clearTimeout(timeout);
      socket.destroy();
      resolve(delivered);
    };

    const socket = net.createConnection(SOCKET_ENDPOINT!);
    socket.on("error", () => finish(false));
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", () => finish(true));
    socket.on("end", () => finish(false));
    timeout = setTimeout(() => finish(false), timeoutMs);
    timeout.unref?.();
  });
}

async function sendRequest(request: unknown): Promise<void> {
  if (await sendRequestAttempt(request, 500)) return;
  await sendRequestAttempt(request, 1500);
}

/**
 * Report (or clear, with `undefined`) the session name.
 *
 * `pane.report_metadata` tokens are per-pane patches: a string sets the key,
 * null clears it, omitted keys stay untouched. We always send the single key we
 * own, so a rename can never clobber another reporter's tokens.
 */
function reportSessionName(name: string | undefined): Promise<void> {
  const trimmed = name?.trim();
  return sendRequest({
    id: `${SOURCE}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
    method: "pane.report_metadata",
    params: {
      pane_id: PANE_ID,
      source: SOURCE,
      agent: "pi",
      tokens: { [TOKEN]: trimmed ? trimmed : null },
    },
  });
}

export default function (pi: any) {
  if (!enabled()) return;

  let lastReported: string | undefined;

  function push(name: string | undefined) {
    const next = name?.trim() || undefined;
    if (next === lastReported) return;
    lastReported = next;
    void reportSessionName(next);
  }

  function currentName(ctx: any, fallback?: string): string | undefined {
    try {
      const name = ctx?.sessionManager?.getSessionName?.();
      if (typeof name === "string" && name.trim()) return name;
    } catch {
      // ignore: fall through to the event payload
    }
    return fallback;
  }

  pi.on("session_start", async (_event: any, ctx: any) => {
    push(currentName(ctx));
  });

  pi.on("session_info_changed", async (event: any, ctx: any) => {
    push(currentName(ctx, event?.name));
  });
}
