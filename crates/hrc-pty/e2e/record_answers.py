#!/usr/bin/env python3
"""Record what a real Ghostty answers to harness startup queries (§4.4).

Driver (default): starts `hrc-pty serve`, opens a Ghostty tab running
`hrc-pty attach` (ghostmux), then spawns this script's `child` mode as the
pty child, so every query travels child -> hrc-pty -> attach -> Ghostty and
every reply comes back the same way. Writes the raw recording and the
responder's data file (`responder-answers.json`).

  record_answers.py --binary target/debug/hrc-pty --out DIR [--harness claude|pi]
  --answers PATH selects the query definitions and answer union to extend.
"""
import argparse
import json
import os
import select
import shlex
import tempfile
import subprocess
import sys
import termios
import time
import tty

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import hrcpty  # noqa: E402

# Query bytes, batches and keyboard preambles live beside the answer union.
DEFAULT_ANSWERS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                               "responder-answers.json")
QUIET = 0.6


def read_for(fd, seconds):
    """Every byte that arrives within `seconds`, with arrival offsets."""
    start = time.monotonic()
    chunks = []
    while True:
        left = seconds - (time.monotonic() - start)
        if left <= 0:
            return chunks
        ready, _, _ = select.select([fd], [], [], left)
        if ready:
            data = os.read(fd, 4096)
            if not data:
                return chunks
            chunks.append({"atMs": round((time.monotonic() - start) * 1000, 2), "hex": data.hex()})


def child(log_path, plan_path):
    fd = sys.stdin.fileno()
    saved = termios.tcgetattr(fd)
    tty.setraw(fd)
    out = sys.stdout.buffer
    plan = json.load(open(plan_path))
    record = {"single": [], "batches": []}
    try:
        out.write(plan["preamble"].encode("latin-1"))
        out.flush()
        read_for(fd, 0.3)
        for entry in plan["queries"]:
            name, query = entry["name"], entry["query"].encode("latin-1")
            out.write(query)
            out.flush()
            record["single"].append({"name": name, "queryHex": query.hex(), "reply": read_for(fd, QUIET)})
        for entry in plan["batches"]:
            label, batch = entry["name"], entry["query"].encode("latin-1")
            out.write(batch)
            out.flush()
            record["batches"].append({"name": label, "queryHex": batch.hex(), "reply": read_for(fd, QUIET)})
        out.write(b"\x1b[<u\r\nrecorded\r\n")
        out.flush()
    finally:
        termios.tcsetattr(fd, termios.TCSANOW, saved)
    with open(log_path, "w") as f:
        json.dump(record, f, indent=1)


def joined(chunks):
    return bytes.fromhex("".join(c["hex"] for c in chunks))


def ghostty_version():
    """`+version` of the Ghostty app that is running (the tab's terminal)."""
    ps = subprocess.run(["ps", "-axo", "comm="], capture_output=True, text=True).stdout.splitlines()
    apps = [p for p in ps if ".app/Contents/MacOS/" in p and "ghostty" in p.rsplit("/", 1)[-1]]
    if not apps:
        return "unknown"
    out = subprocess.run([apps[0], "+version"], capture_output=True, text=True)
    return f"{out.stdout.splitlines()[0] if out.stdout else 'unknown'} ({apps[0]})"


def driver(args):
    binary = os.path.abspath(args.binary)
    out_dir = os.path.abspath(args.out)
    data = json.load(open(args.answers))
    harness = data["harnesses"][args.harness]
    os.makedirs(args.scratch, exist_ok=True)
    ipc = tempfile.mkdtemp(prefix="record-", dir=args.scratch)
    os.makedirs(out_dir, exist_ok=True)
    plan_path = os.path.join(out_dir, "record.plan.json")
    with open(plan_path, "w") as f:
        json.dump(harness, f, indent=1)
    pid, token = hrcpty.serve(binary, ipc, cols=120, rows=40, broker_argv=["/bin/sleep", "3600"],
                              extra=["--answers", os.path.join(os.path.dirname(__file__), "empty-answers.json")])
    sock = os.path.join(ipc, "hrcpty.sock")
    ops = hrcpty.Ops(sock, token)
    byte_log = os.path.join(out_dir, "record.attach-bytes.bin")
    attach_cmd = "exec " + shlex.join([binary, "attach", "--socket", sock, "--byte-log", byte_log])
    tab = json.loads(subprocess.check_output(
        ["ghostmux", "new", "--title", "hrc-pty record", "--command", attach_cmd, "--json"], text=True))
    surface = hrcpty.surface_id(tab)
    try:
        assert hrcpty.wait_until(lambda: ops.call("status")["clients"]["readWrite"] == 1, 15), "attach never came"
        raw_log = os.path.join(out_dir, "record.raw.json")
        env = {k: os.environ[k] for k in ("HOME", "USER", "LOGNAME", "PATH", "SHELL", "LANG", "TMPDIR") if k in os.environ}
        ops.call("spawn", {"argv": [sys.executable, "-I", os.path.abspath(__file__), "child", raw_log, plan_path],
                           "env": env, "cwd": args.scratch})
        assert hrcpty.wait_until(lambda: ops.call("status")["child"]["state"] == "exited", (len(harness["queries"]) + len(harness["batches"])) * QUIET + 15), "child never finished"
        status = ops.call("status")
        with open(os.path.join(out_dir, "record.ghostty-tab.txt"), "w") as f:
            subprocess.run(["ghostmux", "capture-pane", "-t", surface], stdout=f, check=False)
    finally:
        subprocess.run(["ghostmux", "kill-surface", "-t", surface, "--force"], check=False)
        try:
            ops.call("shutdown")
        except Exception:
            pass
    raw = json.load(open(raw_log))
    # Preserve every previously recorded entry, including templates and provenance.
    # Only exact query bytes absent from the union can add an answer.
    known = {a["query"] for a in data["answers"]}
    additions = []
    assert status["child"]["code"] == 0, status["child"]
    assert len(raw["single"]) == len(harness["queries"])
    for entry, single in zip(harness["queries"], raw["single"]):
        assert entry["query"].encode("latin-1").hex() == single["queryHex"]
        if entry["query"] in known:
            continue
        reply = joined(single["reply"])
        answer = {
            **entry,
            "reply": reply.decode("latin-1"),
            "replyHex": reply.hex(),
            "firstByteMs": single["reply"][0]["atMs"] if single["reply"] else None,
        }
        additions.append(answer)
        known.add(entry["query"])
    recording = {
        "recordedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "terminal": ghostty_version(),
        "harness": args.harness,
        "version": harness["version"],
        "method": "Exact data-defined queries written by a pty child of hrc-pty serve; "
                  "hrc-pty attach in a real Ghostty tab relays replies. "
                  f"Each reply contains all bytes received within {int(QUIET * 1000)} ms. "
                  "Existing entries are retained unchanged; an empty reply means no answer.",
        "childStatus": status["child"],
        "raw": raw,
        "additions": additions,
    }
    with open(os.path.join(out_dir, "record.json"), "w") as f:
        json.dump(recording, f, indent=1, ensure_ascii=True)
        f.write("\n")
    data["answers"].extend(additions)
    data.setdefault("recordings", []).append({k: v for k, v in recording.items() if k not in ("raw", "additions")})
    with open(args.answers, "w") as f:
        json.dump(data, f, indent=1, ensure_ascii=True)
        f.write("\n")
    for a in additions:
        print(f"{a['name']:22} {a['reply']!r}")
    print(f"wrote {args.answers}: {len(additions)} new entries")


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "child":
        child(sys.argv[2], sys.argv[3])
        sys.exit(0)
    parser = argparse.ArgumentParser()
    parser.add_argument("--binary", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--scratch", default=os.path.expanduser("~/praesidium/var/scratch/hrc-runtime/record-answers"))
    parser.add_argument("--answers", default=DEFAULT_ANSWERS)
    parser.add_argument("--harness", default="claude", help="key in answers.harnesses (claude or pi)")
    driver(parser.parse_args())
