#!/usr/bin/env python3
"""Rank Herdr panes against a query. Read-only; shells out to `herdr`."""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from typing import Any


def herdr(*args: str) -> Any:
    proc = subprocess.run(
        ["herdr", *args],
        check=False,
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        err = (proc.stderr or proc.stdout or "").strip() or f"exit {proc.returncode}"
        raise SystemExit(f"herdr {' '.join(args)} failed: {err}")
    payload = json.loads(proc.stdout)
    return payload.get("result", payload)


def norm(value: str | None) -> str:
    return re.sub(r"\s+", " ", (value or "")).strip().lower()


def strip_tab_number(label: str) -> str:
    return re.sub(r"^\d+\s+", "", (label or "").strip())


def score_match(query: str, *, pane: dict, tab: dict, workspace: dict, current_ws: str) -> tuple[int, str]:
    q = norm(query)
    if not q:
        return 0, ""

    pane_id = pane.get("pane_id") or ""
    tab_id = tab.get("tab_id") or pane.get("tab_id") or ""
    tab_label = tab.get("label") or ""
    tab_name = strip_tab_number(tab_label)
    ws_id = workspace.get("workspace_id") or pane.get("workspace_id") or ""
    ws_label = workspace.get("label") or ""
    cwd = pane.get("cwd") or ""
    title = pane.get("terminal_title_stripped") or pane.get("terminal_title") or ""
    cwd_base = os.path.basename(cwd.rstrip("/"))

    if q in {norm(pane_id), norm(tab_id)}:
        return 100, "id exact"
    if q == norm(tab_name) or q == norm(tab_label):
        return 95, "tab name exact"
    if q == norm(ws_label) and current_ws == ws_id:
        return 80, "workspace exact"
    if q == norm(cwd_base):
        return 70, "cwd basename exact"
    if q.isdigit() and str(tab.get("number")) == q and current_ws == ws_id:
        return 85, "tab number in current workspace"

    reasons: list[str] = []
    score = 0
    if q in norm(tab_name) or q in norm(tab_label):
        score = max(score, 75)
        reasons.append("tab name")
    if q in norm(ws_label):
        score = max(score, 55)
        reasons.append("workspace")
    if q in norm(cwd):
        score = max(score, 50)
        reasons.append("cwd")
    if q in norm(title):
        score = max(score, 40)
        reasons.append("title")
    if current_ws == ws_id and score:
        score += 5
        reasons.append("current workspace")
    return score, ", ".join(reasons)


def compact_pane(pane: dict, tab: dict, workspace: dict, score: int = 0, why: str = "") -> dict[str, Any]:
    row = {
        "pane_id": pane.get("pane_id"),
        "tab_id": tab.get("tab_id") or pane.get("tab_id"),
        "tab_label": tab.get("label"),
        "tab_name": strip_tab_number(tab.get("label") or ""),
        "workspace_id": workspace.get("workspace_id") or pane.get("workspace_id"),
        "workspace_label": workspace.get("label"),
        "cwd": pane.get("cwd"),
        "agent": pane.get("agent"),
        "agent_status": pane.get("agent_status"),
        "title": pane.get("terminal_title_stripped") or pane.get("terminal_title"),
        "self": pane.get("pane_id") == os.environ.get("HERDR_PANE_ID"),
    }
    session = pane.get("agent_session") or {}
    if session.get("kind") == "path" and session.get("value"):
        row["agent_session_path"] = session["value"]
    if score:
        row["score"] = score
        row["why"] = why
    return row


def load_catalog() -> tuple[list[dict], dict[str, dict], dict[str, dict]]:
    workspaces = {w["workspace_id"]: w for w in herdr("workspace", "list").get("workspaces", [])}
    tabs: dict[str, dict] = {}
    for ws_id in workspaces:
        for tab in herdr("tab", "list", "--workspace", ws_id).get("tabs", []):
            tabs[tab["tab_id"]] = tab
    panes = herdr("pane", "list").get("panes", [])
    return panes, tabs, workspaces


def main() -> None:
    if os.environ.get("HERDR_ENV") != "1":
        json.dump({"ok": False, "error": "not_in_herdr"}, sys.stdout)
        print()
        raise SystemExit(2)

    query = " ".join(sys.argv[1:]).strip()
    panes, tabs, workspaces = load_catalog()
    current_ws = os.environ.get("HERDR_WORKSPACE_ID") or ""
    current_pane = os.environ.get("HERDR_PANE_ID") or ""

    inventory = [
        compact_pane(pane, tabs.get(pane.get("tab_id"), {}), workspaces.get(pane.get("workspace_id"), {}))
        for pane in panes
    ]

    if not query:
        json.dump(
            {
                "ok": True,
                "query": None,
                "current_pane_id": current_pane or None,
                "current_workspace_id": current_ws or None,
                "inventory": inventory,
            },
            sys.stdout,
            ensure_ascii=False,
        )
        print()
        return

    ranked: list[dict] = []
    for pane in panes:
        tab = tabs.get(pane.get("tab_id"), {})
        workspace = workspaces.get(pane.get("workspace_id"), {})
        score, why = score_match(query, pane=pane, tab=tab, workspace=workspace, current_ws=current_ws)
        if score <= 0:
            continue
        ranked.append(compact_pane(pane, tab, workspace, score, why))

    ranked.sort(key=lambda row: (-row["score"], row.get("self", False), row.get("pane_id") or ""))
    best = ranked[0]["score"] if ranked else 0
    top = [row for row in ranked if row["score"] >= best - 10] if ranked else []
    unique = len(top) == 1 or (len(top) > 1 and top[0]["score"] >= top[1]["score"] + 15)

    json.dump(
        {
            "ok": True,
            "query": query,
            "current_pane_id": current_pane or None,
            "current_workspace_id": current_ws or None,
            "unique": unique,
            "matches": ranked,
            "inventory": inventory if not ranked else None,
        },
        sys.stdout,
        ensure_ascii=False,
    )
    print()


if __name__ == "__main__":
    main()
