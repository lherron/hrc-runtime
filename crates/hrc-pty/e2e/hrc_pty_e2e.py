#!/usr/bin/env python3
"""hrc-pty spike e2e (T-12047 brief E1-E5): Claude Code as the child of a bare
`hrc-pty serve`, attach clients in real Ghostty windows (ghostmux). No HRC,
aspd, broker or tmux; the "broker" is `sleep`. E6 (T-12053) needs neither
Claude nor Ghostty: the child's HRC_PTY_SOCKET, clients.remote from an
SSH_CONNECTION client, clients.focused across CSI O / CSI I.

T-12162 (codex-hrcpty) legs: G (no Ghostty) the broker's process group ends
with the broker and at shutdown, attach and spawn with no child, a second
spawn on a fresh pty; X the real Codex TUI spawned under a live read-write
Ghostty client.

  hrc_pty_e2e.py --binary crates/target/debug/hrc-pty --artifacts DIR [--scratch DIR]

Every check writes its evidence under --artifacts and a line in summary.json.
Exit status is non-zero if any check failed.
"""
import argparse
import glob
import json
import os
import re
import shutil
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import hrcpty  # noqa: E402

CLAUDE = "/Users/lherron/.local/bin/claude"
HERE = os.path.dirname(os.path.abspath(__file__))
PROBE_D1 = os.path.expanduser("~/praesidium/var/scratch/hrc-runtime/tmuxless/runs/d1-answer.claude-debug.txt")
ENV_KEYS = ("HOME", "USER", "LOGNAME", "PATH", "SHELL", "LANG", "TMPDIR")


class Run:
    def __init__(self, args):
        self.binary = os.path.abspath(args.binary)
        self.art = os.path.abspath(args.artifacts)
        self.scratch = os.path.abspath(args.scratch)
        os.makedirs(self.art, exist_ok=True)
        shutil.rmtree(self.scratch, ignore_errors=True)
        os.makedirs(self.scratch)
        self.checks = []
        self.windows = []
        self.env = {k: os.environ[k] for k in ENV_KEYS if k in os.environ}

    # -- evidence --------------------------------------------------------
    def path(self, name):
        return os.path.join(self.art, name)

    def save(self, name, data):
        with open(self.path(name), "w") as f:
            if isinstance(data, str):
                f.write(data)
            else:
                json.dump(data, f, indent=1, ensure_ascii=False)
                f.write("\n")
        return self.path(name)

    def check(self, check_id, ok, detail, evidence):
        line = {"check": check_id, "ok": bool(ok), "detail": detail, "evidence": evidence}
        self.checks.append(line)
        print(("PASS " if ok else "FAIL ") + check_id + ": " + detail, flush=True)

    # -- ghostty ---------------------------------------------------------
    def open_window(self, title, command):
        created = json.loads(subprocess.check_output(
            ["ghostmux", "new", "--title", title, "--command", command, "--json"], text=True))
        surface = hrcpty.surface_id(created)
        self.windows.append(surface)
        return surface

    def attach_window(self, sock, title, byte_log, exit_file=None):
        cmd = f"{self.binary} attach --socket {sock} --byte-log {byte_log}"
        if exit_file:
            cmd = f"{cmd}; echo $? > {exit_file}; exit"
        else:
            cmd = f"exec {cmd}"
        return self.open_window(title, cmd)

    def close_window(self, surface):
        subprocess.run(["ghostmux", "kill-surface", "-t", surface, "--force"], capture_output=True)
        if surface in self.windows:
            self.windows.remove(surface)

    def ghostty_text(self, surface):
        return subprocess.run(["ghostmux", "capture-pane", "-t", surface], capture_output=True, text=True).stdout

    def screenshot(self, surface, name):
        subprocess.run(["ghostmux", "focus", "-t", surface], capture_output=True)
        time.sleep(0.8)
        out = subprocess.run(["ghostmux", "screenshot", "-t", surface, "-o", self.path(name)],
                             capture_output=True, text=True)
        return self.path(name) if out.returncode == 0 and os.path.exists(self.path(name)) else None

    def surface_exists(self, surface):
        listed = subprocess.run(["ghostmux", "list-surfaces", "--json"], capture_output=True, text=True).stdout
        return surface in listed

    def cleanup(self):
        for surface in list(self.windows):
            self.close_window(surface)


def norm(text):
    lines = [line.rstrip() for line in text.replace("\r", "").split("\n")]
    while lines and not lines[-1]:
        lines.pop()
    return "\n".join(lines)


def vt_capture(run, byte_log, cols, rows):
    out = subprocess.check_output([run.binary, "vt-capture", "--cols", str(cols), "--rows", str(rows), byte_log], text=True)
    return json.loads(out)


def prompt_box(ops):
    return [line for line in ops.call("capture")["text"].split("\n") if line.startswith("❯")]


def box_empty(ops):
    box = prompt_box(ops)
    return bool(box) and box[0].strip("❯\xa0 ") == ""


def transcript_users(cwd):
    slug = re.sub(r"[^A-Za-z0-9]", "-", os.path.realpath(cwd))
    files = sorted(glob.glob(os.path.expanduser(f"~/.claude/projects/{slug}/*.jsonl")), key=os.path.getmtime)
    if not files:
        return None, []
    users = []
    for line in open(files[-1]):
        record = json.loads(line)
        if record.get("type") != "user":
            continue
        content = record["message"]["content"]
        if not isinstance(content, str):
            continue
        users.append({"timestamp": record.get("timestamp"), "content": content})
    return files[-1], users


def unwrap_pasted(content):
    m = re.fullmatch(r'\s*<pasted_content id="([^"]+)">\n(.*)\n</pasted_content id="\1">\s*', content, re.S)
    return (m.group(2), True) if m else (content, False)


# -- E1 + E5(read-only birth) ---------------------------------------------
def e1(run, ctx):
    ipc = os.path.join(run.scratch, "claude-ipc")
    cwd = os.path.join(run.scratch, "claude-cwd")
    os.makedirs(cwd)
    pid, token = hrcpty.serve(run.binary, ipc, cols=120, rows=40, broker_argv=["/bin/sleep", "3600"])
    sock = os.path.join(ipc, "hrcpty.sock")
    ctx.update(ipc=ipc, cwd=cwd, sock=sock, token=token, serve_pid=pid)
    ctx["events"] = hrcpty.Events(sock, token, run.path("events.claude.ndjson"))
    ops = ctx["ops"] = hrcpty.Ops(sock, token)
    # A read-only observer with no tty logs Claude's raw output from byte 0.
    observer_log = run.path("e1.claude-output.bin")
    observer = subprocess.Popen([run.binary, "attach", "--socket", sock, "--read-only", "--byte-log", observer_log],
                                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL)
    hrcpty.wait_until(lambda: ops.call("status")["clients"]["readOnly"] == 1, 10)
    before = ops.call("status")
    debug = os.path.join(run.scratch, "claude-debug.txt")
    spawned = ops.call("spawn", {"argv": [CLAUDE, "--permission-mode", "default", "--debug-file", debug],
                                 "env": run.env, "cwd": cwd})
    ctx["claude_pid"] = spawned["pid"]
    hrcpty.wait_until(lambda: "❯" in ops.call("capture")["text"], 60)
    time.sleep(3)
    status = ops.call("status")
    observer.terminate()
    observer.wait()
    shutil.copy(debug, run.path("e1.claude-debug.txt"))
    log = open(debug).read()
    caps = next((line for line in log.splitlines() if "Terminal capabilities:" in line), "")
    decstbm = next((line for line in log.splitlines() if "DECSTBM:" in line), "")
    d1 = open(PROBE_D1).read().splitlines() if os.path.exists(PROBE_D1) else []
    out = open(observer_log, "rb").read()
    wanted = ["kittyKeyboard=yes", "kittyGraphics=yes", "mousePixels=yes", "synchronizedOutput=yes"]
    result = {
        "spawn": spawned,
        "statusBeforeSpawn": {"clients": before["clients"], "responderArmed": before["responderArmed"]},
        "responderAnswered": status["responderAnswered"],
        "capabilitiesLine": caps,
        "decstbmLine": decstbm,
        "probeD1": {"capabilities": next((x for x in d1 if "Terminal capabilities:" in x), ""),
                    "decstbm": next((x for x in d1 if "DECSTBM:" in x), "")},
        "output": {"bytes": len(out), "osc9_4": out.count(b"\x1b]9;4"), "sgr256": out.count(b"38;5;"),
                   "truecolor": out.count(b"38;2;")},
    }
    run.save("e1.result.json", result)
    ok = (all(w in caps for w in wanted) and "DECSTBM: enabled" in decstbm and result["output"]["osc9_4"] > 0
          and result["output"]["sgr256"] == 0 and result["output"]["truecolor"] > 0)
    run.check("E1", ok, f"{', '.join(w for w in wanted if w in caps)}; {decstbm.split('[DEBUG] ')[-1][:40]}; "
              f"OSC 9;4 x{result['output']['osc9_4']}, 38;5; x{result['output']['sgr256']}, "
              f"38;2; x{result['output']['truecolor']}", [run.path("e1.result.json"), run.path("e1.claude-debug.txt"),
                                                            observer_log])
    counts = {k: before["clients"][k] for k in ("total", "readWrite", "readOnly")}
    ro_ok = (counts == {"total": 1, "readWrite": 0, "readOnly": 1} and before["responderArmed"]
             and "kittyGraphics=yes" in caps and len(status["responderAnswered"]) >= 8)
    run.check("E5.read-only-birth", ro_ok, f"only a read-only client attached at spawn ({before['clients']}); "
              f"responder answered {len(status['responderAnswered'])} queries; kittyGraphics=yes in debug log",
              [run.path("e1.result.json")])


# -- E2 + E4 ---------------------------------------------------------------
def capture_parity(run, ops, surface, byte_log, label, attempts=6):
    """Equal text and cursor between hrc-pty capture, a second libghostty-vt
    over the client's byte log, and Ghostty's own screen text."""
    last = None
    for _ in range(attempts):
        cap = ops.call("capture")
        replayed = vt_capture(run, byte_log, cap["cols"], cap["rows"])
        ghostty = run.ghostty_text(surface)
        last = {"capture": cap, "clientByteLogVt": replayed, "ghosttyCapturePane": ghostty}
        same_vt = norm(cap["text"]) == norm(replayed["text"]) and cap["cursor"] == replayed["cursor"]
        same_ghostty = norm(cap["text"]) == norm(ghostty)
        last["equal"] = {"textAndCursorVsClientVt": same_vt, "textVsGhostty": same_ghostty}
        if same_vt and same_ghostty:
            break
        time.sleep(1)
    run.save(f"{label}.json", last)
    return last


def e2_e4(run, ctx):
    ops, sock = ctx["ops"], ctx["sock"]
    log1 = run.path("e2.attach1.bytes.bin")
    w1 = run.attach_window(sock, "hrc-pty e2 attach 1", log1)
    assert hrcpty.wait_until(lambda: ops.call("status")["clients"]["readWrite"] == 1, 20), "attach 1 never came"
    time.sleep(2.5)
    shot1 = run.screenshot(w1, "e2.attach1.png")
    parity = capture_parity(run, ops, w1, log1, "e4.capture-parity")
    run.check("E4", all(parity["equal"].values()),
              f"capture vs client byte log through a second libghostty-vt (text+cursor {parity['capture']['cursor']}): "
              f"{parity['equal']['textAndCursorVsClientVt']}; capture text vs Ghostty capture-pane: "
              f"{parity['equal']['textVsGhostty']}", [run.path("e4.capture-parity.json")])
    run.save("e2.ghostty-attach1.txt", run.ghostty_text(w1))
    run.close_window(w1)
    assert hrcpty.wait_until(lambda: ops.call("status")["clients"]["readWrite"] == 0, 10), "detach not seen"
    detached = ops.call("capture")
    run.save("e2.capture-detached.json", detached)
    log2 = run.path("e2.attach2.bytes.bin")
    w2 = run.attach_window(sock, "hrc-pty e2 attach 2", log2)
    assert hrcpty.wait_until(lambda: ops.call("status")["clients"]["readWrite"] == 1, 20), "attach 2 never came"
    time.sleep(2.5)
    shot2 = run.screenshot(w2, "e2.attach2.png")
    g2 = run.ghostty_text(w2)
    run.save("e2.ghostty-attach2.txt", g2)
    replay = vt_capture(run, log2, detached["cols"], detached["rows"])
    run.close_window(w2)
    hrcpty.wait_until(lambda: ops.call("status")["clients"]["readWrite"] == 0, 10)
    claude_screen = "❯" in detached["text"] and "Claude Code" in detached["text"]
    same = norm(g2) == norm(detached["text"])
    result = {"detachedCaptureHasTui": claude_screen, "reattachGhosttyEqualsDetachedCapture": same,
              "reattachBytes": os.path.getsize(log2), "reattachVtCursor": replay["cursor"],
              "detachedCursor": detached["cursor"], "screenshots": [shot1, shot2]}
    run.save("e2.result.json", result)
    run.check("E2.claude", claude_screen and same,
              f"detached capture holds Claude's TUI; reattached Ghostty screen == detached capture: {same}; "
              f"screenshots {'ok' if shot1 and shot2 else 'missing'}",
              [run.path("e2.result.json"), run.path("e2.capture-detached.json"), run.path("e2.ghostty-attach2.txt"),
               shot1, shot2])


def e2_kitty(run):
    ipc = os.path.join(run.scratch, "kitty-ipc")
    pid, token = hrcpty.serve(run.binary, ipc, cols=120, rows=40)
    sock = os.path.join(ipc, "hrcpty.sock")
    ops = hrcpty.Ops(sock, token)
    try:
        ops.call("spawn", {"argv": [sys.executable, "-I", os.path.join(HERE, "kitty_fixture.py")],
                           "env": run.env, "cwd": run.scratch})
        hrcpty.wait_until(lambda: "fixture ready" in ops.call("capture")["text"], 10)
        detached = ops.call("capture")
        run.save("e2k.capture-detached.json", detached)
        shots, models = [], []
        for n in (1, 2):
            log = run.path(f"e2k.attach{n}.bytes.bin")
            w = run.attach_window(sock, f"hrc-pty e2 kitty attach {n}", log)
            assert hrcpty.wait_until(lambda: ops.call("status")["clients"]["readWrite"] == 1, 20), "attach never came"
            time.sleep(2)
            shots.append(run.screenshot(w, f"e2k.attach{n}.png"))
            run.save(f"e2k.ghostty-attach{n}.txt", run.ghostty_text(w))
            models.append(vt_capture(run, log, detached["cols"], detached["rows"]))
            run.close_window(w)
            hrcpty.wait_until(lambda: ops.call("status")["clients"]["readWrite"] == 0, 10)
        replay = open(run.path("e2k.attach2.bytes.bin"), "rb").read()
        placeholder = "\U0010EEEE".encode()
        row0 = ("\U0010EEEE̅̅").encode()
        result = {
            "detachedKittyPlacements": detached["kittyPlacements"],
            "replayModelKitty": models[1]["kitty"],
            "replayHas": {
                "transmit7": b"a=t,f=32,s=64,v=32,i=7" in replay, "transmit8": b"a=t,f=32,s=48,v=24,i=8" in replay,
                "positioned7": b"\x1b[3;5H\x1b_Ga=p,i=7,p=1,c=8,r=4,C=1,q=2" in replay,
                "virtual8": b"\x1b_Ga=p,i=8,p=2,c=6,r=3,U=1,q=2" in replay,
                "placeholderFg38_5_8": b"\x1b[38;5;8m" + placeholder in replay,
                "placeholderRowColDiacritics": row0 in replay,
                "orderCellsThenTransmitThenU1": 0 <= replay.find(placeholder) < replay.find(b"i=8,q=2") <
                replay.find(b"\x1b_Ga=p,i=8,p=2,c=6,r=3,U=1"),
            },
            "screenshots": shots,
        }
        run.save("e2k.result.json", result)
        placements = {(p["imageId"], p["virtual"], p["col"] if not p["virtual"] else None)
                      for p in models[1]["kitty"]["placements"]}
        ok = placements == {(7, False, 4), (8, True, None)} and all(result["replayHas"].values())
        run.check("E2.kitty", ok, f"after reattach the client-side model holds {sorted(placements, key=str)}; "
                  f"replay bytes {result['replayHas']}; screenshots {'ok' if all(shots) else 'missing'}",
                  [run.path("e2k.result.json"), *[s for s in shots if s]])
    finally:
        ops.call("signal", {"signal": "KILL"})
        ops.call("shutdown")


def attach_sigwinch(run, ctx):
    """`hrc-pty attach` turns SIGWINCH on its own tty into `resize`."""
    import fcntl
    import pty
    import signal
    import struct
    import termios

    ops = ctx["ops"]
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 100, 1600, 990))
    proc = subprocess.Popen([run.binary, "attach", "--socket", ctx["sock"]], stdin=slave, stdout=slave,
                            stderr=slave, start_new_session=True)
    os.close(slave)
    sizes = []
    try:
        hrcpty.wait_until(lambda: ops.call("status")["clients"]["readWrite"] == 1, 10)
        sizes.append(ops.call("status")["size"])
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 45, 150, 2400, 1485))
        os.kill(proc.pid, signal.SIGWINCH)
        hrcpty.wait_until(lambda: ops.call("status")["size"]["cols"] == 150, 5)
        sizes.append(ops.call("status")["size"])
    finally:
        proc.send_signal(signal.SIGHUP)
        code = proc.wait(5)
        os.close(master)
    hrcpty.wait_until(lambda: ops.call("status")["clients"]["readWrite"] == 0, 5)
    run.save("attach.sigwinch.json", {"sizes": sizes, "exitOnSighup": code})
    ok = (sizes[0]["cols"], sizes[0]["rows"]) == (100, 30) and (sizes[-1]["cols"], sizes[-1]["rows"]) == (150, 45)
    run.check("attach.sigwinch", ok, f"pty size at attach {sizes[0]}, after SIGWINCH {sizes[-1]}; "
              f"SIGHUP exit {code}", [run.path("attach.sigwinch.json")])


# -- E3 --------------------------------------------------------------------
def prompt_text(n):
    size = 1024 + n * (3072 // 19)
    head = f"E3-{n:02d} hrc-pty input check, line 1 of a multi-line prompt.\n"
    body, i = "", 0
    while len(head) + len(body) < size:
        i += 1
        body += f"line {i + 1}: the quick brown fox jumps over the lazy dog {n:02d}-{i:03d}\n"
    return (head + body)[:size].rstrip("\n")


def e3(run, ctx):
    ops = ctx["ops"]
    sent, rows = [], []
    for n in range(20):
        text = prompt_text(n)
        sent.append(text)
        ops.input(b"\x1b[200~" + text.encode() + b"\x1b[201~")
        time.sleep(0.3)
        ops.input(b"\r")
        marker = f"E3-{n:02d} "
        landed = hrcpty.wait_until(lambda: any(marker in u["content"] for u in transcript_users(ctx["cwd"])[1]), 30)
        ops.call("interrupt")
        # After an early interrupt Claude puts the prompt back in the box
        # (§4.5); clear it so the next paste does not append to it. The
        # first turn is cold and can take several seconds to give it back.
        restored = hrcpty.wait_until(lambda: "Pasted" in "".join(prompt_box(ops)), 20)
        cleared = False
        for _ in range(3):
            ops.input(b"\x15")
            if hrcpty.wait_until(lambda: box_empty(ops), 3):
                time.sleep(0.5)
                cleared = box_empty(ops)
                if cleared:
                    break
        rows.append({"n": n, "bytes": len(text.encode()), "landed": bool(landed), "restored": bool(restored),
                     "cleared": cleared})
    path, users = transcript_users(ctx["cwd"])
    matched = []
    for n, text in enumerate(sent):
        marker = f"E3-{n:02d} "
        hits = [u for u in users if marker in u["content"]]
        inner, wrapped = unwrap_pasted(hits[0]["content"]) if len(hits) == 1 else ("", False)
        matched.append({**rows[n], "records": len(hits), "fullText": inner.strip("\n") == text, "pastedContentWrap": wrapped})
    shutil.copy(path, run.path("e3.transcript.jsonl"))
    run.save("e3.result.json", {"transcript": path, "prompts": matched, "sent": sent})
    ok = all(m["records"] == 1 and m["fullText"] for m in matched)
    sizes = [m["bytes"] for m in matched]
    run.check("E3", ok, f"{sum(m['records'] == 1 and m['fullText'] for m in matched)}/20 prompts "
              f"({min(sizes)}-{max(sizes)} bytes) recorded once with full text; "
              f"{sum(m['pastedContentWrap'] for m in matched)}/20 wrapped in <pasted_content>",
              [run.path("e3.result.json"), run.path("e3.transcript.jsonl")])


# -- E5 --------------------------------------------------------------------
def e5(run, ctx):
    ops, sock, events = ctx["ops"], ctx["sock"], ctx["events"]
    claude = ctx["claude_pid"]
    log = run.path("e5.attach-hup.bytes.bin")
    w = run.attach_window(sock, "hrc-pty e5 attach", log)
    assert hrcpty.wait_until(lambda: ops.call("status")["clients"]["readWrite"] == 1, 20), "attach never came"
    attach_pid = int(subprocess.check_output(["pgrep", "-f", f"attach --socket {sock} --byte-log {log}"],
                                             text=True).split()[0])
    mark = len(events.items)
    os.kill(attach_pid, 1)
    events.wait_for("client.detached", 10, after=mark)
    after = ops.call("status")
    hup = {"attachPid": attach_pid, "attachAlive": hrcpty.pid_alive(attach_pid), "claudePid": claude,
           "status": after}
    run.save("e5.sighup.json", hup)
    run.close_window(w)
    run.check("E5.sighup", after["child"]["pid"] == claude and after["child"]["state"] == "running"
              and after["clients"]["total"] == 0 and not hup["attachAlive"],
              f"attach pid {attach_pid} gone after SIGHUP; Claude pid {after['child']['pid']} running; "
              f"clients {after['clients']}", [run.path("e5.sighup.json")])

    broker = ops.call("status")["broker"]
    mark = len(events.items)
    os.kill(broker["pid"], 15)
    exited = events.wait_for("broker.exited", 10, after=mark)
    time.sleep(2)
    after = ops.call("status")
    cap = ops.call("capture")
    result = {"brokerBefore": broker, "event": exited, "statusAfter2s": after, "captureStillWorks": "❯" in cap["text"]}
    run.save("e5.broker.json", result)
    run.check("E5.broker", after["broker"]["pid"] == broker["pid"] and after["broker"]["state"] == "exited"
              and after["child"]["pid"] == claude and after["child"]["state"] == "running" and result["captureStillWorks"],
              f"broker.exited {exited['params']}; no respawn (broker {after['broker']['state']}, pid "
              f"{after['broker']['pid']}); Claude pid {claude} running; capture ok", [run.path("e5.broker.json")])

    mark = len(events.items)
    ops.input(b"/exit")
    time.sleep(0.5)
    ops.input(b"\r")
    child = events.wait_for("child.exited", 30, after=mark)
    final = ops.call("capture")
    run.save("e5.final-capture.json", final)
    log = run.path("e5.attach-after-exit.bytes.bin")
    exit_file = os.path.join(run.scratch, "e5.attach-exit-code")
    w = run.attach_window(sock, "hrc-pty e5 after exit", log, exit_file=exit_file)
    assert hrcpty.wait_until(lambda: ops.call("status")["clients"]["readWrite"] == 1, 20), "attach after exit failed"
    time.sleep(2)
    shot = run.screenshot(w, "e5.attach-after-exit.png")
    ghostty = run.ghostty_text(w)
    run.save("e5.ghostty-after-exit.txt", ghostty)
    mark = len(events.items)
    ops.call("shutdown")
    hrcpty.wait_until(lambda: os.path.exists(exit_file) and open(exit_file).read().strip(), 15)
    attach_exit = open(exit_file).read().strip() if os.path.exists(exit_file) else None
    gone = hrcpty.wait_until(lambda: not hrcpty.pid_alive(ctx["serve_pid"]), 10)
    absent = subprocess.run([run.binary, "attach", "--socket", sock], capture_output=True, text=True)
    run.windows.remove(w) if not run.surface_exists(w) and w in run.windows else None
    result = {"childExited": child, "finalCaptureNonEmpty": bool(norm(final["text"])),
              "ghosttyAfterExitEqualsCapture": norm(ghostty) == norm(final["text"]),
              "attachExitOnServerClose": attach_exit, "serveGone": bool(gone),
              "attachWithSocketAbsent": {"code": absent.returncode, "stderr": absent.stderr.strip()},
              "screenshot": shot}
    run.save("e5.exit.json", result)
    run.check("E5.exit", result["finalCaptureNonEmpty"] and result["ghosttyAfterExitEqualsCapture"]
              and attach_exit == "0" and absent.returncode != 0,
              f"child.exited {child['params']}; capture after exit kept the final screen; a new Ghostty attach shows "
              f"it ({result['ghosttyAfterExitEqualsCapture']}); attach exit on server close = {attach_exit}; "
              f"attach to an absent socket = {absent.returncode}", [run.path("e5.exit.json"),
                                                                     run.path("e5.final-capture.json"), shot])


# -- E6: Loggia animation player additions (T-12053, spec §4.3) --------------
def e6(run):
    ipc = os.path.join(run.scratch, "player-ipc")
    pid, token = hrcpty.serve(run.binary, ipc, cols=80, rows=24, broker_argv=["/bin/sleep", "3600"])
    sock = os.path.join(ipc, "hrcpty.sock")
    ops = hrcpty.Ops(sock, token)
    clients = []
    try:
        env_file = os.path.join(run.scratch, "player-child-env.txt")
        ops.call("spawn", {"argv": ["/bin/sh", "-c", f"env > {env_file}; exec /bin/sleep 3600"], "env": run.env})
        hrcpty.wait_until(lambda: os.path.exists(env_file) and os.path.getsize(env_file) > 0, 10)
        child_env = dict(line.split("=", 1) for line in open(env_file).read().splitlines() if "=" in line)
        shutil.copy(env_file, run.path("e6.child-env.txt"))
        run.check("E6.child-env-socket", child_env.get("HRC_PTY_SOCKET") == sock,
                  f"child HRC_PTY_SOCKET={child_env.get('HRC_PTY_SOCKET')!r}, ops socket {sock}",
                  [run.path("e6.child-env.txt")])

        def attach(extra_env):
            env = {k: v for k, v in run.env.items() if k != "SSH_CONNECTION"}
            env.update(extra_env)
            proc = subprocess.Popen([run.binary, "attach", "--socket", sock], env=env, stdin=subprocess.PIPE,
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            clients.append(proc)
            return proc

        def counts():
            c = ops.call("status")["clients"]
            return {k: c.get(k) for k in ("total", "readWrite", "readOnly", "remote", "focused")}

        trail = [("idle", counts())]
        remote = attach({"SSH_CONNECTION": "192.0.2.10 50000 192.0.2.20 22"})
        trail.append(("ssh-attached", hrcpty.wait_until(lambda: (lambda c: c if c["total"] == 1 else None)(counts()), 10)))
        local = attach({})
        trail.append(("local-attached", hrcpty.wait_until(lambda: (lambda c: c if c["total"] == 2 else None)(counts()), 10)))
        run.check("E6.remote-count", trail[0][1]["remote"] == 0 and trail[1][1]["remote"] == 1 and trail[2][1]["remote"] == 1,
                  "remote 0 → 1 with the SSH_CONNECTION client, stays 1 when a local client joins", trail)

        local.terminate()  # SIGTERM: the client restores its tty and exits 0
        local.wait(timeout=10)
        clients.remove(local)
        steps = [("one-client", hrcpty.wait_until(lambda: (lambda c: c if c["total"] == 1 else None)(counts()), 10))]
        for label, report, want in (("CSI O", b"\x1b[O", 0), ("CSI I", b"\x1b[I", 1)):
            remote.stdin.write(report)
            remote.stdin.flush()
            steps.append((label, hrcpty.wait_until(lambda: (lambda c: c if c["focused"] == want else None)(counts()), 10)
                          or counts()))
        focused = [s[1]["focused"] for s in steps]
        run.save("e6.status-trail.json", {"remote": trail, "focus": steps})
        run.check("E6.focus", focused == [1, 0, 1], f"clients.focused {focused} across attach, CSI O, CSI I",
                  [run.path("e6.status-trail.json")])
    finally:
        for proc in clients:
            proc.kill()
        try:
            ops.call("signal", {"signal": "KILL"})
            ops.call("shutdown")
        except Exception:
            pass


# -- G: broker process group, no-child attach, respawn (T-12162 §4.2) --------
def pgid(pid):
    out = subprocess.run(["ps", "-o", "pgid=", "-p", str(pid)], capture_output=True, text=True).stdout.strip()
    return int(out) if out else None


def read_pid(path, timeout=10):
    hrcpty.wait_until(lambda: os.path.exists(path) and open(path).read().strip(), timeout)
    return int(open(path).read().strip())


def watch_deaths(pids, t0, timeout):
    """Seconds after t0 at which each pid stopped existing (None if it never did)."""
    died = {name: None for name in pids}
    deadline = time.time() + timeout
    while time.time() < deadline and any(v is None for v in died.values()):
        for name, pid in pids.items():
            if died[name] is None and not hrcpty.pid_alive(pid):
                died[name] = round(time.time() - t0, 3)
        time.sleep(0.02)
    return died


def stop(ops):
    for method, params in (("signal", {"signal": "KILL"}), ("shutdown", {})):
        try:
            ops.call(method, params)
        except Exception:
            pass


def g_broker_crash(run):
    """A SIGKILLed broker takes its group (a TERM-honouring and a TERM-ignoring
    grandchild) with it before broker.exited; the pty child survives."""
    ipc = os.path.join(run.scratch, "g-crash-ipc")
    os.makedirs(ipc)
    soft, stubborn = os.path.join(ipc, "soft.pid"), os.path.join(ipc, "stubborn.pid")
    broker = ["/bin/sh", "-c", f'(exec /bin/sleep 3600) & echo $! > {soft}; '
              f'(trap "" TERM; exec /bin/sleep 3600) & echo $! > {stubborn}; wait']
    serve_pid, token = hrcpty.serve(run.binary, ipc, cols=80, rows=24, broker_argv=broker)
    sock = os.path.join(ipc, "hrcpty.sock")
    events = hrcpty.Events(sock, token, run.path("g-crash.events.ndjson"))
    ops = hrcpty.Ops(sock, token)
    try:
        pids = {"soft": read_pid(soft), "stubborn": read_pid(stubborn)}
        child = ops.call("spawn", {"argv": ["/bin/sleep", "3600"], "env": run.env})
        before = ops.call("status")
        bpid = before["broker"]["pid"]
        groups = {"serve": pgid(serve_pid), "broker": pgid(bpid), "soft": pgid(pids["soft"]),
                  "stubborn": pgid(pids["stubborn"]), "child": pgid(child["pid"])}
        mark = len(events.items)
        t0 = time.time()
        os.kill(bpid, 9)
        died = watch_deaths(pids, t0, 8)
        exited = events.wait_for("broker.exited", 10, after=mark)
        after = ops.call("status")
        result = {"groups": groups, "grandchildren": pids, "diedAfterKillS": died,
                  "brokerExitedAfterS": round(exited["receivedAt"] - t0, 3), "event": exited["params"],
                  "childAfter": after["child"], "childAlive": hrcpty.pid_alive(child["pid"]),
                  "brokerAfter": after["broker"]}
        run.save("g-crash.result.json", result)
        shutil.copy(os.path.join(ipc, "hrcpty.log"), run.path("g-crash.hrcpty.log"))
        lines = open(run.path("g-crash.hrcpty.log")).read().splitlines()
        kill_at = next((i for i, line in enumerate(lines) if f"broker group {bpid} outlived" in line), None)
        event_at = next((i for i, line in enumerate(lines) if "event broker.exited" in line), None)
        result["logOrder"] = {"groupKillLine": kill_at, "brokerExitedLine": event_at}
        run.save("g-crash.result.json", result)
        # pid_alive sees a KILLed grandchild until launchd reaps the zombie, so
        # the order comes from the log and the timing gets 0.1 s of slack.
        ok = (groups["broker"] == bpid and groups["serve"] != bpid and groups["soft"] == bpid
              and groups["stubborn"] == bpid and groups["child"] == child["pid"]
              and died["soft"] is not None and died["soft"] < 1
              and died["stubborn"] is not None and 4.5 <= died["stubborn"] <= 6
              and kill_at is not None and event_at is not None and kill_at < event_at
              and result["brokerExitedAfterS"] >= died["stubborn"] - 0.1 and exited["params"]["signal"] == 9
              and after["child"]["state"] == "running" and result["childAlive"])
        run.check("G.broker-crash", ok, f"broker {bpid} in its own group {groups['broker']} (serve group "
                  f"{groups['serve']}); after SIGKILL: TERM grandchild gone at {died['soft']}s, TERM-ignoring "
                  f"grandchild at {died['stubborn']}s, broker.exited at {result['brokerExitedAfterS']}s; pty child "
                  f"{child['pid']} {after['child']['state']}",
                  [run.path("g-crash.result.json"), run.path("g-crash.events.ndjson"), run.path("g-crash.hrcpty.log")])
    finally:
        stop(ops)


def g_shutdown(run):
    """Shutdown ends the broker's group whether the broker is dead (its
    TERM-ignoring grandchild alive) or alive (lease end)."""
    rows = {}
    for label, broker_exits in (("dead-broker", True), ("live-broker", False)):
        ipc = os.path.join(run.scratch, f"g-shutdown-{label}-ipc")
        os.makedirs(ipc)
        stubborn, trigger = os.path.join(ipc, "stubborn.pid"), os.path.join(ipc, "trigger")
        tail = f"while [ ! -e {trigger} ]; do /bin/sleep 0.1; done; exit 0" if broker_exits else "wait"
        broker = ["/bin/sh", "-c", f'(trap "" TERM; exec /bin/sleep 3600) & echo $! > {stubborn}; {tail}']
        serve_pid, token = hrcpty.serve(run.binary, ipc, cols=80, rows=24, broker_argv=broker)
        ops = hrcpty.Ops(os.path.join(ipc, "hrcpty.sock"), token)
        grandchild = read_pid(stubborn)
        if broker_exits:
            open(trigger, "w").close()
            hrcpty.wait_until(lambda: ops.call("status")["broker"]["state"] == "exited", 5, 0.02)
        before = ops.call("status")["broker"]
        alive_before = hrcpty.pid_alive(grandchild)
        t0 = time.time()
        ops.call("shutdown")
        died = watch_deaths({"grandchild": grandchild, "serve": serve_pid}, t0, 10)
        shutil.copy(os.path.join(ipc, "hrcpty.log"), run.path(f"g-shutdown-{label}.hrcpty.log"))
        rows[label] = {"brokerAtShutdown": before, "grandchild": grandchild, "grandchildAliveAtShutdown": alive_before,
                       "diedAfterShutdownS": died}
    run.save("g-shutdown.result.json", rows)
    ok = all(r["grandchildAliveAtShutdown"] and r["diedAfterShutdownS"]["grandchild"] is not None
             and r["diedAfterShutdownS"]["serve"] is not None
             and r["diedAfterShutdownS"]["grandchild"] <= r["diedAfterShutdownS"]["serve"] <= 6.5
             for r in rows.values())
    ok = ok and rows["dead-broker"]["brokerAtShutdown"]["state"] == "exited"
    run.check("G.shutdown", ok, "; ".join(
        f"{k}: broker {r['brokerAtShutdown']['state']}, TERM-ignoring grandchild gone {r['diedAfterShutdownS']['grandchild']}s"
        f" after shutdown, serve gone {r['diedAfterShutdownS']['serve']}s" for k, r in rows.items()),
        [run.path("g-shutdown.result.json"), *[run.path(f"g-shutdown-{k}.hrcpty.log") for k in rows]])


def pty_attach(run, sock, cols, rows, extra=()):
    """`hrc-pty attach` on a pty of a given size; its output is drained."""
    import fcntl
    import pty
    import struct
    import termios
    import threading

    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    proc = subprocess.Popen([run.binary, "attach", "--socket", sock, *extra], stdin=slave, stdout=slave,
                            stderr=slave, start_new_session=True)
    os.close(slave)

    def drain():
        try:
            while os.read(master, 65536):
                pass
        except OSError:
            pass
    threading.Thread(target=drain, daemon=True).start()
    return proc, master


def g_no_child(run):
    """No child: a read-only attach gets RIS and spawns nothing; spawn without
    cols/rows after a read-write attach starts at that client's size."""
    ipc = os.path.join(run.scratch, "g-nochild-ipc")
    serve_pid, token = hrcpty.serve(run.binary, ipc, cols=120, rows=40)
    sock = os.path.join(ipc, "hrcpty.sock")
    ops = hrcpty.Ops(sock, token)
    observer_log = run.path("g-nochild.read-only.bytes.bin")
    observer = subprocess.Popen([run.binary, "attach", "--socket", sock, "--read-only", "--byte-log", observer_log],
                                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL)
    rw = None
    try:
        hrcpty.wait_until(lambda: ops.call("status")["clients"]["readOnly"] == 1, 10)
        time.sleep(1)
        ro = ops.call("status")
        ro_bytes = open(observer_log, "rb").read()
        rw, master = pty_attach(run, sock, 111, 33)
        hrcpty.wait_until(lambda: ops.call("status")["clients"]["readWrite"] == 1, 10)
        rw_status = ops.call("status")
        spawned = ops.call("spawn", {"argv": ["/bin/sh", "-c", "stty size; exec /bin/sleep 3600"], "env": run.env})
        hrcpty.wait_until(lambda: "33 111" in ops.call("capture")["text"], 10)
        cap = ops.call("capture")
        result = {"readOnly": {"child": ro["child"], "clients": ro["clients"], "bytes": ro_bytes.decode("latin-1")},
                  "readWriteAttach": {"child": rw_status["child"], "size": rw_status["size"]},
                  "spawn": spawned, "capture": {"text": norm(cap["text"]), "cols": cap["cols"], "rows": cap["rows"]}}
        run.save("g-nochild.result.json", result)
        ok = (ro["child"]["state"] == "none" and ro_bytes == b"\x1bc" and rw_status["child"]["state"] == "none"
              and (spawned["cols"], spawned["rows"]) == (111, 33) and "33 111" in cap["text"])
        run.check("G.no-child", ok, f"read-only attach: child {ro['child']['state']}, bytes {ro_bytes!r}; read-write "
                  f"attach 111x33 then spawn without size -> {spawned['cols']}x{spawned['rows']}, child's stty size "
                  f"{'33 111' if '33 111' in cap['text'] else cap['text'][:20]!r}",
                  [run.path("g-nochild.result.json"), observer_log])
    finally:
        observer.terminate()
        if rw:
            rw.terminate()
        stop(ops)


def g_respawn(run):
    """A child exits nonzero; the next spawn runs on a fresh pty and model, and
    attached clients are reset first."""
    ipc = os.path.join(run.scratch, "g-respawn-ipc")
    serve_pid, token = hrcpty.serve(run.binary, ipc, cols=100, rows=30)
    sock = os.path.join(ipc, "hrcpty.sock")
    events = hrcpty.Events(sock, token, run.path("g-respawn.events.ndjson"))
    ops = hrcpty.Ops(sock, token)
    observer_log = run.path("g-respawn.read-only.bytes.bin")
    observer = subprocess.Popen([run.binary, "attach", "--socket", sock, "--read-only", "--byte-log", observer_log],
                                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL)
    try:
        hrcpty.wait_until(lambda: ops.call("status")["clients"]["readOnly"] == 1, 10)
        mark = len(events.items)
        first = ops.call("spawn", {"argv": ["/bin/sh", "-c", "echo FIRST-CHILD; printf '\\033[?1049h\\033[?2004h'; "
                                            "echo FIRST-ALT; /bin/sleep 0.3; exit 3"], "env": run.env})
        exited = events.wait_for("child.exited", 10, after=mark)
        time.sleep(0.3)
        cap1 = ops.call("capture")
        offset = os.path.getsize(observer_log)
        second = ops.call("spawn", {"argv": ["/bin/sh", "-c", "echo SECOND-CHILD; exec /bin/sleep 3600"], "env": run.env})
        hrcpty.wait_until(lambda: "SECOND-CHILD" in ops.call("capture")["text"], 10)
        cap2 = ops.call("capture")
        styled = ops.call("capture", {"styled": True})["text"]
        status = ops.call("status")
        tail = open(observer_log, "rb").read()[offset:]
        result = {"first": first, "firstExited": exited["params"],
                  "captureAfterFirst": {"text": norm(cap1["text"]), "screen": cap1["screen"]},
                  "second": second, "captureAfterSecond": {"text": norm(cap2["text"]), "screen": cap2["screen"],
                                                           "styledHasBracketedPaste": "?2004h" in styled},
                  "child": status["child"], "observerBytesAfterSecondSpawn": tail.decode("latin-1")}
        run.save("g-respawn.result.json", result)
        ok = (exited["params"]["code"] == 3 and "FIRST-ALT" in cap1["text"] and cap1["screen"] == "alternate"
              and norm(cap2["text"]) == "SECOND-CHILD" and cap2["screen"] == "primary"
              and not result["captureAfterSecond"]["styledHasBracketedPaste"]
              and status["child"]["pid"] == second["pid"] and status["child"]["state"] == "running"
              and tail.startswith(b"\x1bc") and b"SECOND-CHILD" in tail)
        run.check("G.respawn", ok, f"first child exit {exited['params']['code']} on the {cap1['screen']} screen; second "
                  f"spawn's capture {norm(cap2['text'])!r} on the {cap2['screen']} screen, no leftover modes; attached "
                  f"client got RIS first ({tail[:2]!r})", [run.path("g-respawn.result.json"), observer_log])
    finally:
        observer.terminate()
        stop(ops)


# -- X: the real Codex TUI under a live read-write Ghostty client ----------------
CODEX = os.path.expanduser("~/.local/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/"
                           "vendor/aarch64-apple-darwin/bin/codex")
QUERIES = {"CPR": b"\x1b[6n", "OSC10": b"\x1b]10;?", "OSC11": b"\x1b]11;?", "kittyKeyboard": b"\x1b[?u",
           "DA1": b"\x1b[c"}


def x_codex(run):
    ipc = os.path.join(run.scratch, "codex-ipc")
    cwd = os.path.join(run.scratch, "codex-cwd")
    os.makedirs(cwd)
    serve_pid, token = hrcpty.serve(run.binary, ipc, cols=120, rows=40, broker_argv=["/bin/sleep", "3600"])
    sock = os.path.join(ipc, "hrcpty.sock")
    events = hrcpty.Events(sock, token, run.path("x-codex.events.ndjson"))
    ops = hrcpty.Ops(sock, token)
    hrcpty_log = os.path.join(ipc, "hrcpty.log")
    try:
        log1 = run.path("x-codex.attach1.bytes.bin")
        w1 = run.attach_window(sock, "hrc-pty codex attach 1", log1)
        assert hrcpty.wait_until(lambda: ops.call("status")["clients"]["readWrite"] == 1, 20), "attach 1 never came"
        attached = ops.call("status")
        spawned = ops.call("spawn", {"argv": [CODEX], "env": run.env, "cwd": cwd})
        t0 = time.time()
        main_screen = hrcpty.wait_until(
            lambda: (lambda t: "OpenAI Codex (v" in t and "\n› " in t)(ops.call("capture")["text"]), 60)
        reached = round(time.time() - t0, 2)
        time.sleep(1.5)
        status = ops.call("status")
        log_lines = open(hrcpty_log).read().splitlines()
        since_spawn = log_lines[next(i for i, line in enumerate(log_lines) if "spawned child" in line):]
        answered = [line for line in since_spawn if "responder answered" in line]
        out = open(log1, "rb").read()
        queries = {name: out.count(q) for name, q in QUERIES.items()}
        shot1 = run.screenshot(w1, "x-codex.attach1.png")
        parity = capture_parity(run, ops, w1, log1, "x-codex.capture-parity")
        run.close_window(w1)
        assert hrcpty.wait_until(lambda: ops.call("status")["clients"]["readWrite"] == 0, 10), "detach not seen"
        time.sleep(1)
        detached = ops.call("capture")
        log2 = run.path("x-codex.attach2.bytes.bin")
        w2 = run.attach_window(sock, "hrc-pty codex attach 2", log2)
        assert hrcpty.wait_until(lambda: ops.call("status")["clients"]["readWrite"] == 1, 20), "attach 2 never came"
        time.sleep(2)
        shot2 = run.screenshot(w2, "x-codex.attach2.png")
        g2 = run.ghostty_text(w2)
        run.save("x-codex.ghostty-attach2.txt", g2)
        # Ctrl-C on an empty composer quits Codex 0.163; a second one only if
        # it is still up (an older TUI asks for it).
        mark = len(events.items)
        ops.input(b"\x03")
        try:
            exited = events.wait_for("child.exited", 3, after=mark)
        except TimeoutError:
            ops.input(b"\x03")
            exited = events.wait_for("child.exited", 15, after=mark)
        run.close_window(w2)
        shutil.copy(hrcpty_log, run.path("x-codex.hrcpty.log"))
        result = {"attachedBeforeSpawn": {"clients": attached["clients"], "child": attached["child"],
                                          "size": attached["size"]},
                  "spawn": spawned, "mainScreenAfterS": reached if main_screen else None,
                  "responderAnsweredSinceSpawn": answered, "statusResponderAnswered": status["responderAnswered"],
                  "bytesIn": status["bytesRelayed"]["in"], "queriesSeenByClient": queries,
                  "attach1Parity": parity["equal"], "detachedCapture": norm(detached["text"]),
                  "reattachGhosttyEqualsDetachedCapture": norm(g2) == norm(detached["text"]),
                  "childExited": exited["params"], "screenshots": [shot1, shot2]}
        run.save("x-codex.result.json", result)
        size_ok = (spawned["cols"], spawned["rows"]) == (attached["size"]["cols"], attached["size"]["rows"])
        ok = (attached["child"]["state"] == "none" and size_ok and main_screen and not answered
              and not status["responderAnswered"] and all(queries.values()) and status["bytesRelayed"]["in"] > 0
              and all(parity["equal"].values()) and result["reattachGhosttyEqualsDetachedCapture"])
        run.check("X.codex", ok, f"Codex spawned at the attaching Ghostty's size {spawned['cols']}x{spawned['rows']} "
                  f"({size_ok}); main screen in {reached}s; responder answers since spawn: {len(answered)}; startup "
                  f"queries at the client {queries}, {status['bytesRelayed']['in']} bytes answered by Ghostty; attach "
                  f"parity {parity['equal']}; reattach replay == detached capture: "
                  f"{result['reattachGhosttyEqualsDetachedCapture']}; TUI exit {exited['params']}",
                  [run.path("x-codex.result.json"), run.path("x-codex.hrcpty.log"), log1, log2,
                   run.path("x-codex.capture-parity.json"), shot1, shot2])
    finally:
        stop(ops)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--binary", required=True)
    parser.add_argument("--artifacts", required=True)
    parser.add_argument("--scratch", default=os.path.expanduser("~/praesidium/var/scratch/hrc-runtime/T-12047/e2e"))
    parser.add_argument("--only", help="comma list of e1,e2,e2k,e3,e5,e6,g,x (e2/e3/e5 need e1)")
    args = parser.parse_args()
    run = Run(args)
    only = set((args.only or "e1,e2,e2k,e3,e5,e6,g,x").split(","))
    ctx = {}
    try:
        if only - {"e6", "g"}:
            subprocess.run(["ghostmux", "status"], check=True, capture_output=True)
        if "e1" in only:
            e1(run, ctx)
        if "e2" in only:
            e2_e4(run, ctx)
        if "e2" in only:
            attach_sigwinch(run, ctx)
        if "e2k" in only:
            e2_kitty(run)
        if "e3" in only:
            e3(run, ctx)
        if "e5" in only:
            e5(run, ctx)
        if "e6" in only:
            e6(run)
        if "g" in only:
            for leg in (g_broker_crash, g_shutdown, g_no_child, g_respawn):
                try:
                    leg(run)
                except Exception as error:
                    run.check(leg.__name__, False, f"{type(error).__name__}: {error}", [])
        if "x" in only:
            x_codex(run)
    except Exception as error:  # a crashed phase is a failed check, with its reason
        run.check("harness", False, f"{type(error).__name__}: {error}", [])
    finally:
        run.cleanup()
        if ctx.get("ops"):
            try:
                ctx["ops"].call("signal", {"signal": "KILL"})
                ctx["ops"].call("shutdown")
            except Exception:
                pass
    summary = {"binary": run.binary, "version": subprocess.check_output([run.binary, "version"], text=True).strip(),
               "at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "ok": all(c["ok"] for c in run.checks),
               "checks": run.checks}
    run.save("summary.json", summary)
    print(f"{'PASS' if summary['ok'] else 'FAIL'}: {sum(c['ok'] for c in run.checks)}/{len(run.checks)} -> "
          f"{run.path('summary.json')}")
    sys.exit(0 if summary["ok"] else 1)


if __name__ == "__main__":
    main()
