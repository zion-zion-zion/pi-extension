---
name: read-terminal
description: Read another Herdr terminal pane's screen or scrollback on demand. Use when the user asks to look at, check, or 去看 a named terminal, tab, pane, or 那个终端里的日志. Do not use for this agent's own bash output, and do not scan terminals unless the user pointed at one.
---

# Read Terminal

On-demand read of a **named** Herdr pane. Inventory stays out of context until this skill runs.

## Gate

```bash
test "${HERDR_ENV:-}" = 1
```

If that fails: this session is not inside Herdr. Ask the user to paste the log, or to export scrollback from the other terminal. Stop.

## Find

Extract the name from the request (`codex_usage`, `backend`, `w4:p1`). Then, from this skill directory:

```bash
python3 scripts/find-pane.py '<name>'
```

No name, or "旁边那个" with no label: run `python3 scripts/find-pane.py` and list **other** panes in the current workspace (`tab_name` + `cwd` + `agent_status`). If exactly one sibling exists, read that. Otherwise ask which `tab_name` they mean.

Treat `unique: true` as the target. If several close matches remain, ask — quote `tab_name`, `workspace_label`, and `pane_id`. If `matches` is empty, show `inventory` names and stop.

Prefer a non-`self` match. Read this pane only when the user named it by id.

## Read

```bash
herdr pane read <pane_id> --source recent-unwrapped --lines 200
```

Stdout is the snapshot text, not JSON. Need more tail: raise `--lines` (try 500, then 1000). Need the live viewport: `--source visible`.

The pane hosts a coding-agent TUI (field `agent` set, snapshot is chrome / spinner / empty) **and** the user asked for that conversation: read the tail of `agent_session_path` instead of paging Herdr scrollback. For a shell/server/compiler log, keep the pane snapshot.

## Report

Quote the relevant tail. Redact secrets as `<REDACTED>`. Name the pane (`tab_name` / `pane_id`) so the user can tell which terminal you read.

Read only. Do not `send-keys`, `run`, `focus`, `close`, or prompt another agent. Do not inject pane snapshots on later turns unless the user asks again.