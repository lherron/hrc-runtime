#!/usr/bin/env bash
# hrc-focus <task-id> — raise the Ghostty "Headless Sessions" tab for a task.
#
# The consolidated headless viewer (T-05237) groups one tab per task, keyed by
# the durable ghostmux metadata `hrc_tab_key == task:<taskId>` on each agent
# pane (role `headless-agent-pane`). We find any pane in that tab and focus it;
# focusing a surface raises its window AND switches to its tab.
set -euo pipefail

usage() { echo "usage: hrc-focus <task-id>   (e.g. hrc-focus T-05190)" >&2; exit 2; }
[ $# -eq 1 ] || usage
QUERY="$1"

SURFACES_JSON="$(ghostmux list-surfaces --json)" QUERY="$QUERY" python3 - <<'PY'
import json, os, subprocess, sys

query = os.environ["QUERY"]
surfaces = json.loads(os.environ["SURFACES_JSON"]).get("terminals", [])

def resolved(sid):
    try:
        out = subprocess.run(
            ["ghostmux", "metadata", "get", "-t", sid, "--resolved", "--json"],
            capture_output=True, text=True, timeout=5,
        ).stdout
        d = json.loads(out)
        return d.get("data", d) or {}
    except Exception:
        return {}

# Collect headless agent panes, grouped by tab key.
tabs = {}  # tabKey -> {"label": str, "surfaces": [sid,...]}
for s in surfaces:
    sid = s.get("short_id") or s.get("id")
    md = resolved(sid)
    if md.get("hrc_role") != "headless-agent-pane":
        continue
    tk = md.get("hrc_tab_key") or ""
    scope = md.get("hrc_scope_ref") or ""
    label = md.get("hrc_tab_label") or s.get("title") or tk
    entry = tabs.setdefault(tk, {"label": label, "scopes": set(), "surfaces": []})
    entry["surfaces"].append(sid)
    if scope:
        entry["scopes"].add(scope)

if not tabs:
    print("hrc-focus: no headless agent panes found (is the Headless Sessions window open?)", file=sys.stderr)
    sys.exit(1)

# Match: exact `task:<query>`, else tab-key task segment starts with query,
# else any scope ref contains `:task:<query>` or the bare query.
def task_seg(tk): return tk[len("task:"):] if tk.startswith("task:") else ""

exact = [tk for tk in tabs if tk == f"task:{query}"]
prefix = [tk for tk in tabs if task_seg(tk).startswith(query)]
scoped = [tk for tk, e in tabs.items()
          if any(f":task:{query}" in sc or query in sc for sc in e["scopes"])]

matches = exact or prefix or scoped
matches = list(dict.fromkeys(matches))  # de-dupe, keep order

if not matches:
    print(f"hrc-focus: no headless tab matches '{query}'. Open tabs:", file=sys.stderr)
    for tk, e in sorted(tabs.items()):
        print(f"  {tk}  ({len(e['surfaces'])} pane(s))  {e['label']}", file=sys.stderr)
    sys.exit(1)

if len(matches) > 1:
    print(f"hrc-focus: '{query}' is ambiguous, matches {len(matches)} tabs:", file=sys.stderr)
    for tk in matches:
        e = tabs[tk]
        print(f"  {tk}  ({len(e['surfaces'])} pane(s))  {e['label']}", file=sys.stderr)
    sys.exit(1)

tk = matches[0]
sid = tabs[tk]["surfaces"][0]
subprocess.run(["ghostmux", "focus", "-t", sid], check=True)
print(f"focused {tk}  ({tabs[tk]['label']})")
PY
