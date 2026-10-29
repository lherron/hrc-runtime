#!/usr/bin/env python3
"""Record what a real Ghostty answers to Claude Code's startup queries (§4.4).

Driver (default): starts `hrc-pty serve`, opens a Ghostty tab running
`hrc-pty attach` (ghostmux), then spawns this script's `child` mode as the
pty child, so every query travels child -> hrc-pty -> attach -> Ghostty and
every reply comes back the same way. Writes the raw recording and the
responder's data file (`responder-answers.json`).

  record_answers.py --binary target/debug/hrc-pty --out DIR [--answers PATH]
"""
import argparse
import json
import os
import select
import subprocess
import sys
import termios
import time
import tty

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import hrcpty  # noqa: E402

# Claude Code 2.1.312's exact query bytes (probe runs/d1-answer.out.bin
# offsets 1681-1763), in its order: batch 1, then batch 2.
QUERIES = [
    ("xtversion", b"\x1b[>0q", None),
    ("kitty_keyboard_query", b"\x1b[?u", "kitty_flags"),
    ("program_status_query", b"\x1b]7501;?\x07", None),
    ("da1", b"\x1b[c", None),
    ("decrqm_2026", b"\x1b[?2026$p", None),
    ("kitty_graphics_query", b"\x1b_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\", None),
    ("cell_size", b"\x1b[16t", "cell_size"),
    ("decrqm_1016", b"\x1b[?1016$p", None),
]
BATCH1 = b"\x1b[>0q\x1b[?u\x1b]7501;?\x07\x1b[c"
BATCH2 = b"\x1b[?2026$p\x1b_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\\x1b[16t\x1b[?1016$p\x1b[c"
# What Claude writes before querying: the kitty push the ?u answer reflects.
PREAMBLE = b"\x1b[<u\x1b[>5u"
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


def child(log_path):
    fd = sys.stdin.fileno()
    saved = termios.tcgetattr(fd)
    tty.setraw(fd)
    out = sys.stdout.buffer
    record = {"single": [], "batches": []}
    try:
        out.write(PREAMBLE)
        out.flush()
        read_for(fd, 0.3)
        for name, query, _ in QUERIES:
            out.write(query)
            out.flush()
            record["single"].append({"name": name, "queryHex": query.hex(), "reply": read_for(fd, QUIET)})
        for label, batch in (("batch1", BATCH1), ("batch2", BATCH2)):
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
    ipc = os.path.join(args.scratch, "record-ipc")
    os.makedirs(out_dir, exist_ok=True)
    pid, token = hrcpty.serve(binary, ipc, cols=120, rows=40, broker_argv=["/bin/sleep", "3600"],
                              extra=["--answers", os.path.join(os.path.dirname(__file__), "empty-answers.json")])
    sock = os.path.join(ipc, "hrcpty.sock")
    ops = hrcpty.Ops(sock, token)
    byte_log = os.path.join(out_dir, "record.attach-bytes.bin")
    attach_cmd = f"exec {binary} attach --socket {sock} --byte-log {byte_log}"
    tab = json.loads(subprocess.check_output(
        ["ghostmux", "new", "--title", "hrc-pty record", "--command", attach_cmd, "--json"], text=True))
    surface = hrcpty.surface_id(tab)
    try:
        assert hrcpty.wait_until(lambda: ops.call("status")["clients"]["readWrite"] == 1, 15), "attach never came"
        raw_log = os.path.join(out_dir, "record.raw.json")
        env = {k: os.environ[k] for k in ("HOME", "USER", "LOGNAME", "PATH", "SHELL", "LANG", "TMPDIR") if k in os.environ}
        ops.call("spawn", {"argv": [sys.executable, "-I", os.path.abspath(__file__), "child", raw_log],
                           "env": env, "cwd": args.scratch})
        assert hrcpty.wait_until(lambda: ops.call("status")["child"]["state"] == "exited", 30), "child never finished"
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
    answers = []
    for (name, query, template), single in zip(QUERIES, raw["single"]):
        reply = joined(single["reply"])
        answers.append({
            "name": name,
            "query": query.decode("latin-1"),
            "reply": reply.decode("latin-1"),
            "replyHex": reply.hex(),
            "firstByteMs": single["reply"][0]["atMs"] if single["reply"] else None,
            **({"template": template} if template else {}),
        })
    data = {
        "recordedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "terminal": ghostty_version(),
        "method": "Claude Code 2.1.312's exact query bytes written one at a time by a pty child of "
                  "hrc-pty serve, relayed by hrc-pty attach running in a Ghostty tab; each reply is "
                  f"every byte that came back within {int(QUIET * 1000)} ms. The child first pushed "
                  "kitty keyboard flags 5 (CSI > 5 u), as Claude does.",
        "childStatus": status["child"],
        "batches": [{"name": b["name"], "replyHex": joined(b["reply"]).hex(),
                     "reply": joined(b["reply"]).decode("latin-1"), "chunks": b["reply"]} for b in raw["batches"]],
        "answers": answers,
    }
    target = args.answers or os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                                          "responder-answers.json")
    with open(target, "w") as f:
        json.dump(data, f, indent=1, ensure_ascii=True)
        f.write("\n")
    for a in answers:
        print(f"{a['name']:22} {a['reply']!r}")
    print(f"wrote {target}")


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "child":
        child(sys.argv[2])
        sys.exit(0)
    parser = argparse.ArgumentParser()
    parser.add_argument("--binary", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--scratch", default=os.path.expanduser("~/praesidium/var/scratch/hrc-runtime/T-12047"))
    parser.add_argument("--answers")
    driver(parser.parse_args())
