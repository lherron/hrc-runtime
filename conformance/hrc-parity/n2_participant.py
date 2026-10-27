"""EPR activation/replay, live human turns and participant-owned clean exit.

Key-order blind: JSON payload/envelope comparisons use parsed values. Variable
provider usage/notice counts are checked against each subject's real broker
ledger; the fixed lifecycle outcomes are compared between owners.
"""

import json
from pathlib import Path
from n2_turns import ledger_checks, TIMED


def compare(args, checks):
    def check(name, passed, reason, code=1):
        checks.append({"id": name, "pass": bool(passed), "reason": reason, "failureCode": code})

    views = {}
    for owner, directory in (("bun", args.baseline), ("native", args.candidate)):
        d = json.loads((Path(directory) / (owner + ".json")).read_text())
        check(
            owner + ":workflow-complete", d.get("pass") is True, "the real EPR workflow must finish"
        )
        final = d["final"]
        final["brokerLedger"] = d["ledger"]
        ledger_checks(owner, final, check)
        inv = final["broker_invocations"][0]
        runtime = final["runtimes"][0]
        activation = [e for e in final["hrc_events"] if e["event_kind"] == "runtime.ensured"]
        terminated = [e for e in final["hrc_events"] if e["event_kind"] == "runtime.terminated"]
        exited = [e for e in d["ledger"] if e["type"] == "invocation.exited"]
        check(
            owner + ":staged-release",
            len(activation) == 1
            and d["afterInitial"]["broker_invocations"][0]["last_projected_seq"] >= 4,
            "exactly one activation and replay of the real ensure/start/ready ledger",
        )
        check(
            owner + ":activation-before-turns",
            len(activation) == 1
            and all(
                e["hrc_seq"] > activation[0]["hrc_seq"]
                for e in final["hrc_events"]
                if e["event_kind"].startswith("turn.")
            ),
            "no turn projection before the participant activation transaction",
        )
        check(
            owner + ":live-turns",
            len([e for e in d["afterLive"]["hrc_events"] if e["event_kind"] == "turn.completed"])
            == 2,
            "two real turns project before owner shutdown, with no polling replay",
        )
        check(
            owner + ":one-writer",
            len(final["runtimes"]) == len(final["broker_invocations"]) == 1 and not final["runs"],
            "human turns without run rows keep the single participant identity",
        )
        check(
            owner + ":external-stop",
            d["externalStop"] == {"accepted": True, "state": "exited"},
            "the external host, rather than HRC, issues the real invocation stop",
        )
        check(
            owner + ":clean-terminal",
            len(exited) == len(terminated) == 1
            and json.loads(terminated[0]["payload_json"])
            == {
                "reason": "external_participant_exit",
                "invocationId": inv["invocation_id"],
                "seq": exited[0]["seq"],
            }
            and terminated[0]["transport"] == "headless"
            and terminated[0]["run_id"] is None
            and runtime["lifecycle_terminal_reason"] == "external_participant_exit"
            and runtime["active_run_id"] is None,
            "clean exit emits exactly one external termination and releases active observation",
        )
        check(
            owner + ":not-a-crash",
            not [e for e in final["hrc_events"] if e["event_kind"] == "runtime.crashed"],
            "a clean external exit must never condemn the broker",
        )
        check(
            owner + ":broker-survives",
            d["brokerAliveAfterShutdown"] is True,
            "both HRC owner shutdowns leave the externally owned broker alive",
        )
        ledger = d["ledger"]
        head = max(e["seq"] for e in ledger)
        # The real snapshot exposes currentSeq; attach/replay persists the ACK
        # returned by ackEvents (snapshot has no ackedThroughSeq field).
        check(
            owner + ":broker-ack",
            d["finalSnapshot"]["currentSeq"] == head
            and json.loads(runtime["runtime_state_json"])["brokerReplay"]["ackedThroughSeq"]
            == head,
            "the real broker ACK must reach the complete committed replay cursor",
        )
        messages = [
            json.loads(e["payload_json"])["message"]["content"]
            for e in final["hrc_events"]
            if e["event_kind"] == "turn.message"
        ]
        kinds = [e["event_kind"] for e in final["hrc_events"] if e["event_kind"] not in TIMED]
        replies = {}
        for name in ("attach", "retry"):
            status, body = d[name]
            check(
                owner + ":" + name + ":identity",
                all(
                    body[k] == d["joined"]["identity"][k]
                    for k in ("registrationId", "attemptId", "attachEpoch")
                ),
                "attachment answers the exact registered attempt and epoch",
            )
            body = dict(body)
            for key in ("registrationId", "attemptId"):
                body[key] = "<" + key + ">"
            replies[name] = {"status": status, "body": body}
        views[owner] = {
            "replies": replies,
            "attach": d["attach"][0],
            "prepared": d["attach"][1]["prepared"],
            "retry": d["retry"][0],
            "retryPrepared": d["retry"][1]["prepared"],
            "attempt": final["participant_registration_attempts"][0]["state"],
            "work": final["participant_registration_attempts"][0]["establishment_work_state"],
            "status": runtime["status"],
            "reason": runtime["lifecycle_terminal_reason"],
            "invocationState": inv["invocation_state"],
            "messages": messages,
            "lifecycleKinds": kinds,
            "terminalPayloadKeys": (
                sorted(json.loads(terminated[0]["payload_json"])) if terminated else []
            ),
        }
    check(
        "compare:epr-projection", views["bun"] == views["native"], json.dumps(views, sort_keys=True)
    )
    return {
        "suite": "n2-participant",
        "cases": [{"id": c["id"], "pass": c["pass"]} for c in checks],
        "behaviorQualified": all(c["pass"] for c in checks),
    }


DOORS = ("steer", "turn", "literal")


def _normalized(d):
    """Identities and seq cursors replaced by role names; everything else kept."""
    import re

    ident = d["identity"]
    text = json.dumps({k: d[k] for k in ("pending", "active", "absorbing")}, sort_keys=True)
    for key in ("registrationId", "attemptId", "runtimeId", "invocationId", "hostSessionId"):
        text = text.replace(ident[key], "<" + key + ">")
    text = re.sub(r"run-[0-9a-f-]{36}", "<runId>", text)
    view = json.loads(text)
    for phase in view.values():
        for status, body in phase.values():
            observation = body.get("observation") if isinstance(body, dict) else None
            if observation:
                observation["lifecycle"]["fromSeq"] = "<seq>"
                if "broker" in observation:
                    observation["broker"]["afterSeq"] = "<seq>"
    return view


def compare_delivery(args, checks):
    """T-11960: addressed work into a participant-served scope, every door."""

    def check(name, passed, reason, code=1):
        checks.append({"id": name, "pass": bool(passed), "reason": reason, "failureCode": code})

    views, traces = {}, {}
    for owner, directory in (("bun", args.baseline), ("native", args.candidate)):
        d = json.loads((Path(directory) / (owner + ".json")).read_text())
        check(owner + ":workflow-complete", d.get("pass") is True, "the delivery workflow must finish")
        runtime = d["runtimeId"]
        for door in DOORS:
            status, body = d["pending"][door]
            reason = (body.get("error") or {}).get("detail", {}).get("reason")
            check(
                owner + ":pending:" + door,
                status == 503
                and (
                    reason == "participant_attachment_pending"
                    if door != "literal"
                    # No participant runtime yet: Bun's literal falls back to
                    # the latest interactive runtime, and there is none.
                    else body["error"]["message"] == "no live literal-capable runtime is currently bound"
                ),
                "a registered, unattached participant keeps its work pending: " + json.dumps(body),
            )
            status, body = d["active"][door]
            check(
                owner + ":active:" + door,
                status == 200 and body.get("runtimeId") == runtime and body.get("runId"),
                "ACTIVE delivery lands in the attempt's own runtime: " + json.dumps(body),
            )
            status, body = d["absorbing"][door]
            reason = (body.get("error") or {}).get("detail", {}).get("reason")
            check(
                owner + ":absorbing:" + door,
                status == 503 and reason == "participant_attempt_absorbing",
                "an absorbing attempt never serves addressed work: " + json.dumps(body),
            )
        check(
            owner + ":pending:no-birth",
            not d["pendingRows"]["runtimes"] and not d["pendingRows"]["runs"],
            "pending work never births a substitute runtime",
        )
        runs = d["activeRows"]["runs"]
        check(
            owner + ":active:one-writer",
            len(d["final"]["runtimes"]) == 1
            and len(runs) == len(DOORS)
            and all(r["runtime_id"] == runtime and r["status"] == "completed" for r in runs),
            "every door's run completes in the one participant runtime: "
            + json.dumps([(r["runtime_id"], r["status"]) for r in runs]),
        )
        check(
            owner + ":broker-survives",
            d["brokerAliveAfterShutdown"] is True,
            "owner shutdown leaves the externally owned broker alive",
        )
        views[owner] = _normalized(d)
        traces[owner] = [
            json.loads(e["payload_json"])
            for e in d["final"]["hrc_events"]
            if e["event_kind"] == "submission.admission"
        ]
    check(
        "compare:admission-traces",
        len(traces["bun"]) == 8 and traces["bun"] == traces["native"],
        json.dumps(traces, sort_keys=True),
    )
    check(
        "compare:delivery-replies",
        views["bun"] == views["native"],
        json.dumps(views, sort_keys=True),
    )
    return {
        "suite": "n2-participant-delivery",
        "cases": [{"id": c["id"], "pass": c["pass"]} for c in checks],
        "behaviorQualified": all(c["pass"] for c in checks),
    }
