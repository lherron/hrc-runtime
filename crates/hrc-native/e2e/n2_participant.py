#!/usr/bin/env python3
"""Real participant-owned EPR broker: staged replay, live turn, clean exit.

Failure modes: projection before activation, missing replay/live stream or ACK,
duplicate events on replay, clean process exit classified as a crash, and HRC
tearing down the independently owned broker on owner shutdown.
"""

import argparse
import json
import socket
import subprocess
import time
import uuid
from pathlib import Path
from n2_scratch import Scratch


class Rpc:
    def __init__(self, path):
        self.s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.s.settimeout(120)
        self.s.connect(str(path))
        self.f = self.s.makefile("rwb")
        self.id = 0

    def call(self, method, params):
        self.id += 1
        self.f.write(
            (
                json.dumps({"jsonrpc": "2.0", "id": self.id, "method": method, "params": params})
                + "\n"
            ).encode()
        )
        self.f.flush()
        while True:
            r = json.loads(self.f.readline())
            if r.get("id") == self.id:
                assert "error" not in r, r
                return r["result"]

    def close(self):
        self.f.close()
        self.s.close()


def rows(s):
    tables = [
        "participant_registrations",
        "participant_registration_attempts",
        "participant_host_bindings",
        "sessions",
        "continuities",
        "runtimes",
        "runtime_operations",
        "broker_invocations",
        "broker_invocation_events",
        "broker_projection_dispositions",
        "runs",
        "hrc_events",
    ]
    return {t: s.rows("SELECT * FROM " + t) for t in tables}


def register(s, scope, record):
    status, joined = s.http(
        "POST",
        "/v1/participants/register",
        {
            "registrationMode": "direct",
            "requestedSessionRef": scope,
            "hostIncarnationId": "participant-" + str(uuid.uuid4()),
            "workspaceCwd": str(s.project),
        },
    )
    assert status == 200, joined
    record["joined"] = joined
    record["joinRows"] = rows(s)
    assert len(record["joinRows"]["runtimes"]) == 0
    return joined


def attach(s, args, scope, joined, record, brokerlog, held):
    """Real ASP compile, a participant-served broker, attach, ACTIVE."""
    status, placement = s.http(
        "POST",
        "/v1/placements/resolve",
        {"scopeRef": scope, "cwd": str(s.project), "projectRoot": str(s.project)},
    )
    assert status == 200, placement
    status, declaration = s.http(
        "POST",
        "/v1/declarations/resolve",
        {
            "agentId": "tabularasa",
            "agentRoot": placement["agentRoot"],
            "projectId": s.project_id,
            "projectRoot": str(s.project),
            "cwd": str(s.project),
            "preferredMode": "headless",
            "interactive": False,
            "initialPrompt": "Reply with exactly the word OK and nothing else. No tools.",
        },
    )
    assert status == 200, declaration
    identity = {
        k: joined["identity"][k]
        for k in ["requestId", "operationId", "runtimeId", "invocationId"]
    }
    identity.update(
        hostSessionId=joined["hostSessionId"],
        generation=joined["generation"],
        traceId="trace-" + str(uuid.uuid4()),
    )
    pl = declaration["intent"]["placement"]
    pl["correlation"] = {"sessionRef": {"scopeRef": scope, "laneRef": "main"}, **identity}
    pl["dispatchEnv"] = {
        "AGENT_SCOPE_REF": scope,
        "ASP_SCOPE_REF": scope,
        "HRC_SESSION_REF": scope + "/lane:main",
        "AGENT_HOST_SESSION_ID": joined["hostSessionId"],
        "HRC_HOST_SESSION_ID": joined["hostSessionId"],
        "HRC_RUNTIME_DIR": s.env["HRC_RUNTIME_DIR"],
        "HRC_STATE_DIR": s.env["HRC_STATE_DIR"],
        "HRC_MAIL_STOP_SOCKET": str(s.socket),
        "WRKQ_DB": str(s.root / "wrkq.db"),
        "WRKQ_DB_PATH": "",
        "WRKQ_DB_PATH_FILE": "",
    }
    request = {
        "schemaVersion": "agent-runtime-compile-request/v2",
        "agent": {"id": "tabularasa"},
        "identity": identity,
        "placement": pl,
        "requested": {"presentation": False},
        "materialization": {"initialPrompt": declaration["intent"]["initialPrompt"]},
        "hrcPolicy": {},
        "correlation": {"scopeRef": scope, **identity},
    }
    rpc = Rpc(args.aspd_socket)
    record["aspHello"] = rpc.call(
        "aspc.hello", {"clientInfo": {"name": "hrc-server"}, "protocolVersions": ["aspc/0.1"]}
    )
    compiled = rpc.call("aspc.compileHarnessInvocation", {"compileRequest": request})
    rpc.close()
    assert compiled["ok"], compiled
    record["compileRequest"] = request
    record["compiled"] = compiled
    generated = subprocess.run(
        [
            "bun",
            str(Path(__file__).with_name("participant_live_descriptor.mjs")),
            str(s.release),
        ],
        input=json.dumps({"joined": joined, "compiled": compiled}),
        env=s.env,
        capture_output=True,
        text=True,
        check=True,
    )
    d = json.loads(generated.stdout)
    record["descriptor"] = d
    endpoint = s.root / "participant.sock"
    ledger = s.root / "events.ndjson"
    worker = compiled["executionRelease"]["worker"]
    assert worker["executable"].startswith("/Users/lherron/praesidium/var/aspd/releases/")
    broker = held["broker"] = subprocess.Popen(
        [
            worker["executable"],
            *worker["argvPrefix"],
            "--socket",
            str(endpoint),
            "--event-ledger",
            str(ledger),
            "--join",
            "participant-served",
        ],
        env=s.env,
        cwd=s.project,
        stdout=brokerlog,
        stderr=brokerlog,
    )
    for _ in range(300):
        assert broker.poll() is None, args.owner + " broker exited"
        if endpoint.exists():
            break
        time.sleep(0.05)
    body = {k: joined["identity"][k] for k in ["registrationId", "attemptId", "attachEpoch"]}
    body.update(
        descriptor=d,
        socketPath=str(endpoint),
        dispatchEnv=compiled["plan"]["execution"]["dispatchRequest"].get(
            "dispatchEnv", pl["dispatchEnv"]
        ),
    )
    record["attach"] = s.http("POST", "/v1/participants/attach", body)
    assert record["attach"][0] == 200, record["attach"]
    for _ in range(1200):
        snapshot = rows(s)
        attempt = snapshot["participant_registration_attempts"][0]
        if attempt["establishment_work_state"] in ["completed", "exhausted"]:
            break
        time.sleep(0.1)
    record["durable"] = snapshot
    assert (
        attempt["state"] == "ACTIVE" and attempt["establishment_work_state"] == "completed"
    ), attempt
    assert (
        len(snapshot["runtimes"])
        == len(snapshot["runtime_operations"])
        == len(snapshot["broker_invocations"])
        == 1
    ), snapshot
    return identity, broker, endpoint, ledger, body, snapshot


def epr(s, args, scope, record, brokerlog, held):
    owner = s.up(args.owner, "participant")
    joined = register(s, scope, record)
    identity, broker, endpoint, ledger, body, snapshot = attach(
        s, args, scope, joined, record, brokerlog, held
    )
    # Activation releases replay before any live turn. Do not open another
    # broker client here: the broker routes live notifications to its most
    # recently connected controller (even an inspection connection).
    s.wait(
        lambda: s.rows("SELECT 1 FROM broker_invocations WHERE last_projected_seq > 0"),
        30,
        "participant staged replay projection",
    )
    record["afterInitial"] = rows(s)
    # A second, human-typed turn must arrive on the live event stream.
    tui = json.loads(snapshot["participant_registration_attempts"][0]["realized_hosting_json"])[
        "presentation"
    ]["tuiWindow"]

    def type_line(text):
        subprocess.run(
            ["tmux", "-S", tui["socketPath"], "send-keys", "-t", tui["paneId"], "-l", text],
            check=True,
        )
        time.sleep(0.5)
        subprocess.run(
            ["tmux", "-S", tui["socketPath"], "send-keys", "-t", tui["paneId"], "Enter"],
            check=True,
        )

    time.sleep(2)
    s.wait(
        lambda: s.rows("SELECT 1 FROM hrc_events WHERE event_kind='turn.completed'"),
        120,
        "participant first live turn",
    )
    record["afterFirst"] = rows(s)
    type_line("Reply with exactly the word LIVE and nothing else. No tools.")
    s.wait(
        lambda: len(s.rows("SELECT 1 FROM hrc_events WHERE event_kind='turn.completed'")) >= 2,
        120,
        "participant live turn projection",
    )
    record["afterLive"] = rows(s)
    # The external host owns stop. Close the HRC owner, then use the real
    # participant control protocol to stop its invocation. The next owner
    # must replay that terminal envelope without calling it a broker crash.
    s.down(owner)
    assert broker.poll() is None
    rpc = Rpc(endpoint)
    record["externalStop"] = rpc.call(
        "invocation.stop",
        {"invocationId": identity["invocationId"], "reason": "participant host finished"},
    )
    rpc.close()
    s.up(args.owner, "reconnect")
    s.wait(
        lambda: s.rows("SELECT 1 FROM broker_invocation_events WHERE type='invocation.exited'"),
        120,
        "clean participant exit",
    )
    s.wait(
        lambda: s.rows(
            "SELECT 1 FROM runtimes WHERE lifecycle_terminal_reason='external_participant_exit'"
        ),
        30,
        "clean exit releases external runtime",
    )
    rpc = Rpc(endpoint)
    record["finalSnapshot"] = rpc.call(
        "invocation.snapshot", {"invocationId": identity["invocationId"]}
    )
    rpc.close()
    time.sleep(1)
    record["retry"] = s.http("POST", "/v1/participants/attach", body)
    assert record["retry"][0] == 200 and record["retry"][1]["prepared"] is False, record[
        "retry"
    ]
    record["final"] = rows(s)
    record["ledger"] = [
        json.loads(line) for line in ledger.read_text().splitlines() if line.strip()
    ]
    s.down(owner)
    record["brokerAliveAfterShutdown"] = broker.poll() is None
    assert record["brokerAliveAfterShutdown"]


DELIVERY_PROMPT = "Reply with exactly the word {} and nothing else. No tools."


def deliver(s, scope, host, door, word, wait):
    """One addressed delivery through a public door, as the injector sends it."""
    prompt = DELIVERY_PROMPT.format(word)
    if door == "steer":
        body = {"target": scope + "/lane:main", "body": prompt, "origin": {"principalRef": "agent:clod"}}
        if wait:
            body["wait"] = True
        return s.http("POST", "/v1/submissions/steer", body, timeout=600)
    if door == "turn":
        body = {"hostSessionId": host, "prompt": prompt}
        if wait:
            body["waitFor"] = "terminal"
        return s.http("POST", "/v1/turns", body, timeout=600)
    return s.http(
        "POST",
        "/v1/literal-input/by-selector",
        {"selector": {"sessionRef": scope + "/lane:main"}, "text": prompt, "enter": True},
    )


def delivery(s, args, scope, record, brokerlog, held):
    """Addressed work into a participant-served scope, through every door.

    Failure modes: a refusal stub answering every participant delivery (the
    T-11960 incident); a delivery that births a substitute HRC runtime at the
    participant's address; ACTIVE work landing on any runtime other than the
    attempt's own; pending/absorbing attempts answered with the wrong refusal
    reason, kind or status, or falling through to a generic birth.
    """
    owner = s.up(args.owner, "delivery")
    joined = register(s, scope, record)
    host = joined["hostSessionId"]
    doors = ("steer", "turn", "literal")
    # Registered, not attached: the participant's work waits (kind pending).
    record["pending"] = {d: deliver(s, scope, host, d, "PENDING", False) for d in doors}
    record["pendingRows"] = rows(s)
    identity, broker, endpoint, ledger, body, snapshot = attach(
        s, args, scope, joined, record, brokerlog, held
    )
    s.wait(
        lambda: s.rows("SELECT 1 FROM hrc_events WHERE event_kind='turn.completed'"),
        180,
        "participant initial turn",
    )
    runtime = snapshot["runtimes"][0]["runtime_id"]
    # ACTIVE: each door lands in the participant's own runtime.
    record["active"] = {}
    for door, word in (("steer", "STEER"), ("turn", "DISPATCH"), ("literal", "LITERAL")):
        status, reply = deliver(s, scope, host, door, word, True)
        record["active"][door] = [status, reply]
        # Recorded, not asserted: the compare judges every door, so a red
        # owner still reports each case rather than only the first.
        if door == "literal" and status == 200 and reply.get("runId"):
            s.wait_completed(reply["runId"], 300)
    record["activeRows"] = rows(s)
    # The external host stops its invocation: the attempt is absorbing. As in
    # the EPR workflow, the next owner replays that terminal envelope.
    s.down(owner)
    rpc = Rpc(endpoint)
    record["externalStop"] = rpc.call(
        "invocation.stop",
        {"invocationId": identity["invocationId"], "reason": "participant host finished"},
    )
    rpc.close()
    owner = s.up(args.owner, "absorbing")
    s.wait(
        lambda: s.rows(
            "SELECT 1 FROM participant_registration_attempts WHERE state IN ('TERMINAL','SUPERSEDED','ABANDONED')"
        ),
        120,
        "absorbing participant attempt",
    )
    record["absorbing"] = {d: deliver(s, scope, host, d, "ABSORBED", False) for d in doors}
    record["final"] = rows(s)
    record["runtimeId"] = runtime
    record["identity"] = {**identity, **joined["identity"], "hostSessionId": host}
    s.down(owner)
    record["brokerAliveAfterShutdown"] = broker.poll() is None


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--owner", choices=["bun", "native"], required=True)
    p.add_argument("--mode", choices=["epr", "delivery"], default="epr")
    for key in ("binary", "installed-release", "aspd-socket", "scratch-root", "artifacts"):
        p.add_argument("--" + key, type=Path, required=True)
    args = p.parse_args()
    s = Scratch(
        args.scratch_root,
        args.installed_release,
        args.aspd_socket,
        args.binary,
        args.artifacts,
        project_id="n2-t11878",
    )
    prefix = "agent:tabularasa:project:n2-t11878:task:"
    scope = prefix + "projection"
    held = {}
    record = {}
    brokerlog = (s.artifacts / (args.owner + "-broker.log")).open("w")
    try:
        s.init_substrate()
        (s.root / "run/btmux").mkdir()
        (delivery if args.mode == "delivery" else epr)(s, args, scope, record, brokerlog, held)
        record["pass"] = True
    finally:
        record["observed"] = rows(s)
        record["scratchRoot"] = str(s.root)
        (s.artifacts / (args.owner + ".json")).write_text(json.dumps(record, indent=1) + "\n")
        (s.artifacts / (args.owner + "-steps.json")).write_text(
            json.dumps(s.steps, indent=1) + "\n"
        )
        s.cleanup(prefix)
        # Participant runtimes keep their presentation under frozen hosting,
        # rather than runtimeStateJson.tmux (the ordinary Scratch cleanup path).
        for attempt in record["observed"]["participant_registration_attempts"]:
            hosting = json.loads(attempt.get("realized_hosting_json") or "{}")
            tui = hosting.get("presentation", {}).get("tuiWindow")
            if tui:
                assert Path(tui["socketPath"]).is_relative_to(s.root / "run"), tui
                subprocess.run(
                    ["tmux", "-S", tui["socketPath"], "kill-server"], capture_output=True, timeout=5
                )
        broker = held.get("broker")
        if broker and broker.poll() is None:
            broker.terminate()
            broker.wait(timeout=20)
        brokerlog.close()
    print(json.dumps({"owner": args.owner, "pass": True, "artifacts": str(s.artifacts)}))


if __name__ == "__main__":
    main()
