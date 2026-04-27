# Monitor Removal Audit

Date: 2026-04-27
Task: T-01294

This is the F3pre blast-radius audit before removing legacy monitor-adjacent commands.
No commands were removed in this phase.

## Migration Map

| Legacy command | Replacement | Notes |
| --- | --- | --- |
| `hrc status` | `hrc monitor show` | Aggregate daemon/session snapshot moves to the monitor namespace. |
| `hrc status <scope> --json` | `hrc monitor show --json <selector>` | JSON output should expose canonical `scopeRef` and `scopeHandle`. |
| `hrc status <scope> --events <n>` | `hrc monitor show <selector>` plus `hrc monitor watch <selector>` | `show` is the point-in-time view; `watch` owns event replay/streaming. |
| `hrc events` | `hrc monitor watch` | Finite replay defaults to the last 100 events. |
| `hrc events <scope> --from-seq <n> --follow` | `hrc monitor watch <selector> --from-seq <n> --follow` | Same selector family, monitor-owned conditions are available via `--until`. |
| `hrc server health` | `hrc server status` | Health is consolidated into status; JSON diagnostics are available with `--json`. |
| `hrcchat status` | `hrc monitor show` | Per-target status moves to monitor selectors. |
| `hrcchat watch` | `hrc monitor watch` | Message/session watching should use monitor selectors and conditions. |
| `hrcchat wait` | `hrc monitor wait` | Message waits use `msg:<messageId>` selectors. |
| `hrcchat dm --wait` | `hrcchat dm --json` then `hrc monitor wait msg:<messageId> --until response-or-idle` | Split request creation from response/idle waiting. |

### Worked `dm --wait` Migration

Old:

```bash
hrcchat dm cody@agent-spaces --wait --timeout 30m -
```

New:

```bash
envelope="$(hrcchat dm --json cody@agent-spaces - <<'EOF'
Please handle the requested task.
EOF
)"
message_id="$(printf '%s\n' "$envelope" | jq -r '.messageId')"
hrc monitor wait "msg:${message_id}" --until response-or-idle --timeout 30m
```

For handoff scripts that need to keep full dispatch context:

```bash
hrcchat dm --json cody@agent-spaces - <<'EOF' > /tmp/dm-envelope.json
Please handle the requested task.
EOF
jq '{messageId, seq, sessionRef, runtimeId, turnId}' /tmp/dm-envelope.json
hrc monitor wait "msg:$(jq -r '.messageId' /tmp/dm-envelope.json)" \
  --until response-or-idle \
  --timeout 30m
```

## Audit Summary

Search scope: repo files on disk, excluding `.git`, `node_modules`, `asp_modules`, and `dist`.

Blast radius estimate:

| Category | Files | References | F3 impact |
| --- | ---: | ---: | --- |
| CLI implementation | 5 | 15 | Non-trivial: remove command registrations, help text, renderer/debug strings, and generated follow suggestions. |
| CLI tests | 1 | 31 | Non-trivial: update legacy status/events/server-health coverage to monitor surface or delete obsolete compatibility assertions. |
| hrcchat implementation/docs | 5 | 24 | Non-trivial: remove watch/wait/status registrations and replace info/status docs. |
| Project docs/specs/scripts | 9 | 44 | Mostly doc-only, with one smoke script needing migration. |
| Untracked local docs seen at audit time | 1 | 1 | Not part of committed repo, but should be migrated or dropped before F3 if kept. |

Total command-shaped hits reviewed: 115. One hit, `packages/cli/src/commands/repo/status.ts:144`, is unrelated `asp repo status` and does not require F3 action.

## References By Command

### `hrc status`

| Reference | Classification | Migration |
| --- | --- | --- |
| `HRC_STATUS_SPEC.md:3` | doc-only | Legacy spec; archive or retitle as historical. |
| `HRC_STATUS_SPEC.md:10` | doc-only | Replace help-bug note with monitor-era note or archive. |
| `HRC_STATUS_SPEC.md:11` | doc-only | Replace with `hrc monitor show <selector>`. |
| `HRC_STATUS_SPEC.md:16` | doc-only | Archive/remove legacy heading. |
| `HRC_STATUS_SPEC.md:29` | doc-only | Replace with monitor selector section. |
| `HRC_STATUS_SPEC.md:81` | doc-only | Replace example command with monitor wording. |
| `HRC_STATUS_SPEC.md:196` | doc-only | Replace with `hrc monitor show --help`. |
| `HRC_STATUS_SPEC.md:197` | doc-only | Replace with `hrc monitor show`. |
| `HRC_STATUS_SPEC.md:198` | doc-only | Replace with monitor output expectation. |
| `HRC_STATUS_SPEC.md:199` | doc-only | Replace with monitor output expectation. |
| `packages/hrc-cli/src/status-derive.ts:287` | needs-migration | Debug prefix should become `hrc monitor show debug:` or be removed with the legacy status module. |
| `packages/hrc-cli/src/__tests__/cli.test.ts:518` | needs-migration | Convert help test to `monitor show --help`. |
| `packages/hrc-cli/src/__tests__/cli.test.ts:522` | needs-migration | Expected usage becomes `hrc monitor show`. |
| `packages/hrc-cli/src/__tests__/cli.test.ts:529` | needs-migration | Convert `-h` test to monitor. |
| `packages/hrc-cli/src/__tests__/cli.test.ts:533` | needs-migration | Expected usage becomes `hrc monitor show`. |
| `packages/hrc-cli/src/__tests__/cli.test.ts:536` | needs-migration | Convert scoped status rendering test to monitor show. |
| `packages/hrc-cli/src/__tests__/cli.test.ts:551` | safe-to-delete | Legacy invalid-scope command test can be removed or replaced by monitor selector validation. |
| `packages/hrc-cli/src/__tests__/cli.test.ts:1087` | needs-migration | `--events` suppression has no direct `show` flag; split into show/watch tests. |
| `packages/hrc-cli/src/__tests__/cli.test.ts:1099` | needs-migration | `--events <n>` becomes `monitor watch` replay behavior. |
| `packages/hrc-cli/src/__tests__/cli.test.ts:1138` | needs-migration | Verbose event-tail assertion becomes monitor watch formatting/JSON assertion. |
| `packages/hrc-cli/src/__tests__/cli.test.ts:1172` | needs-migration | Convert stable scoped status JSON test to monitor show JSON. |
| `packages/hrc-cli/src/__tests__/cli.test.ts:3108` | doc-only | Test comment only; update/remove. |
| `packages/hrc-cli/src/__tests__/cli.test.ts:3112` | doc-only | Test comment only; update/remove. |
| `packages/hrc-cli/src/__tests__/cli.test.ts:3255` | needs-migration | Convert aggregate status JSON test to monitor show/server status as appropriate. |
| `packages/hrc-cli/src/__tests__/cli.test.ts:3396` | doc-only | Test comment only; update/remove. |
| `packages/hrc-cli/src/__tests__/cli.test.ts:3399` | doc-only | Test comment only; update/remove. |
| `packages/hrc-cli/src/__tests__/cli.test.ts:3403` | needs-migration | Convert human-readable capabilities assertion. |
| `packages/hrc-cli/src/__tests__/cli.test.ts:3412` | needs-migration | Convert tmux backend display assertion. |
| `packages/hrc-cli/src/__tests__/cli.test.ts:3423` | needs-migration | Convert unavailable capability assertion. |
| `packages/hrc-cli/src/__tests__/cli.test.ts:3434` | needs-migration | Convert JSON capabilities assertion. |
| `packages/hrc-cli/src/__tests__/cli.test.ts:3446` | needs-migration | Remove backward-compat field preservation expectation. |
| `packages/hrc-cli/src/__tests__/cli.test.ts:3470` | doc-only | Test comment only; update/remove. |
| `packages/hrc-cli/src/__tests__/cli.test.ts:3474` | doc-only | Test comment only; update/remove. |
| `packages/hrc-cli/src/__tests__/cli.test.ts:3476` | doc-only | Test comment only; update/remove. |
| `packages/hrc-cli/src/__tests__/cli.test.ts:3531` | needs-migration | Convert joined session human rendering test to monitor show. |
| `packages/hrc-cli/src/__tests__/cli.test.ts:3551` | needs-migration | Convert no-runtime/no-surface rendering test to monitor show. |
| `packages/hrc-cli/src/__tests__/cli.test.ts:3563` | needs-migration | Convert joined sessions JSON assertion to monitor show JSON or server status JSON. |
| `packages/hrc-cli/src/cli.ts:1435` | needs-migration | Remove legacy usage printer. |
| `packages/hrc-cli/src/cli.ts:1453` | needs-migration | Remove/update example. |
| `packages/hrc-cli/src/cli.ts:1454` | needs-migration | Remove/update example. |
| `packages/hrc-cli/src/cli.ts:1455` | needs-migration | Remove/update example. |
| `packages/hrc-cli/src/cli.ts:1456` | needs-migration | Remove/update example. |
| `packages/hrc-cli/src/cli.ts:1457` | needs-migration | Remove/update example. |
| `packages/hrc-cli/src/cli.ts:1921` | needs-migration | Debug prefix should move to monitor show or be removed. |
| `packages/hrc-cli/src/cli.ts:3389` | needs-migration | Remove top-level Commander registration. |

### `hrc events`

| Reference | Classification | Migration |
| --- | --- | --- |
| `CODEX_OTEL_HRC_SPEC.md:17` | doc-only | Replace with `hrc monitor watch --follow`. |
| `CODEX_OTEL_HRC_SPEC.md:28` | doc-only | Replace with monitor watch file/command references. |
| `CODEX_OTEL_HRC_SPEC.md:67` | doc-only | Replace with monitor watch output reference. |
| `CODEX_OTEL_HRC_SPEC.md:345` | doc-only | Replace with `hrc monitor watch --follow`. |
| `CODEX_OTEL_HRC_SPEC.md:462` | doc-only | Replace with `hrc monitor watch --follow`. |
| `PI_INTERACTIVE.md:549` | doc-only | Replace command string with `hrc monitor watch pi-e2e@agent-spaces --follow --json`. |
| `OTEL_GAPS.md:7` | doc-only | Replace with monitor watch example. |
| `OTEL_GAPS.md:20` | doc-only | Historical note; update wording. |
| `OTEL_GAPS.md:21` | doc-only | Historical note; update wording. |
| `OTEL_GAPS.md:22` | doc-only | Replace with monitor watch. |
| `OTEL_GAPS.md:77` | doc-only | Historical note; update wording. |
| `MONITOR_PROPOSAL.md:36` | doc-only | Proposal historical reference; keep only if explicitly historical. |
| `MONITOR_PROPOSAL.md:49` | doc-only | Command list; update after F3. |
| `scripts/cli-smoke.sh:264` | needs-migration | Replace validation with `hrc monitor watch --from-seq -1`. |
| `scripts/cli-smoke.sh:265` | needs-migration | Update expected error label for monitor watch. |
| `HRC_STATUS_SPEC.md:38` | doc-only | Replace selector comparison with monitor watch. |
| `HRC_STATUS_SPEC.md:94` | doc-only | Replace example with monitor watch. |
| `HRC_STATUS_SPEC.md:165` | doc-only | Replace follow suggestion with monitor watch. |
| `HRC_STATUS_SPEC.md:207` | doc-only | Replace shared-selector wording. |
| `packages/hrc-cli/src/events-render.ts:2` | needs-migration | Rename/comment to monitor watch renderer or move module. |
| `packages/hrc-cli/src/__tests__/cli.test.ts:18` | doc-only | Test file comment; update/remove. |
| `packages/hrc-cli/src/__tests__/cli.test.ts:547` | needs-migration | Follow suggestion should be monitor watch. |
| `packages/hrc-cli/src/__tests__/cli.test.ts:981` | needs-migration | Follow suggestion assertion should be monitor watch. |
| `packages/hrc-cli/src/__tests__/cli.test.ts:1228` | needs-migration | Follow suggestion assertion should be monitor watch. |
| `packages/hrc-cli/src/__tests__/cli.test.ts:1233` | needs-migration | Shared selector test should compare monitor commands. |
| `packages/hrc-cli/src/__tests__/cli.test.ts:2512` | doc-only | Test heading; update/remove. |
| `packages/hrc-cli/src/__tests__/cli.test.ts:2514` | needs-migration | Convert describe block to monitor watch or delete. |
| `packages/hrc-cli/src/__tests__/cli.test.ts:2522` | needs-migration | Expected usage becomes `hrc monitor watch`. |
| `packages/hrc-cli/src/cli.ts:1135` | needs-migration | Remove legacy usage printer. |
| `packages/hrc-cli/src/cli.ts:1159` | needs-migration | Remove/update example. |
| `packages/hrc-cli/src/cli.ts:1160` | needs-migration | Remove/update example. |
| `packages/hrc-cli/src/cli.ts:1161` | needs-migration | Remove/update example. |
| `packages/hrc-cli/src/cli.ts:1162` | needs-migration | Remove/update example. |
| `packages/hrc-cli/src/cli.ts:1163` | needs-migration | Remove/update example. |
| `packages/hrc-cli/src/cli.ts:1164` | needs-migration | Remove/update example. |
| `packages/hrc-cli/src/cli.ts:1165` | needs-migration | Remove/update example. |
| `packages/hrc-cli/src/cli.ts:1789` | needs-migration | Generated follow command should be `hrc monitor watch ...`. |
| `packages/hrc-cli/src/cli.ts:3073` | needs-migration | Help/example text should use monitor watch. |
| `packages/hrc-cli/src/cli.ts:3406` | needs-migration | Remove top-level Commander registration. |

### `hrc server health`

| Reference | Classification | Migration |
| --- | --- | --- |
| `MONITOR_PROPOSAL.md:50` | doc-only | Command list; update after F3. |
| `MONITOR_PROPOSAL.md:75` | doc-only | Historical proposal note can remain if marked historical. |
| `packages/hrc-cli/src/__tests__/cli.test.ts:3108` | doc-only | Test comment; update/remove. |
| `packages/hrc-cli/src/__tests__/cli.test.ts:3111` | doc-only | Test comment; update/remove. |
| `packages/hrc-cli/src/__tests__/cli.test.ts:3126` | needs-migration | Replace with `hrc server status --json` health assertion. |
| `packages/hrc-cli/src/cli.ts:3286` | needs-migration | Remove `server health` Commander registration. |

### `hrcchat status`

| Reference | Classification | Migration |
| --- | --- | --- |
| `HRCCHAT_SPEC.md:252` | doc-only | Replace command with `hrc monitor show`. |
| `HRCCHAT_SPEC.md:253` | doc-only | Replace command with `hrc monitor show --json`. |
| `MONITOR_PROPOSAL.md:80` | doc-only | Command list; update after F3. |
| `packages/hrcchat-cli/HRCCHAT_STATUS.md:95` | doc-only | Replace/remove status row. |
| `packages/hrcchat-cli/src/main.ts:228` | needs-migration | Remove hrcchat `status` registration. |

### `hrcchat watch`

| Reference | Classification | Migration |
| --- | --- | --- |
| `HRCCHAT_SPEC.md:1030` | doc-only | Replace with monitor watch wording. |
| `HRCCHAT_SPEC.md:1071` | doc-only | Replace example with monitor watch selector/condition. |
| `MONITOR_PROPOSAL.md:81` | doc-only | Command list; update after F3. |
| `packages/hrcchat-cli/src/commands/info.ts:28` | needs-migration | Replace quick-start example with monitor watch. |
| `packages/hrcchat-cli/src/main.ts:182` | needs-migration | Remove hrcchat `watch` registration. |
| `packages/hrcchat-cli/HRCCHAT_STATUS.md:92` | doc-only | Replace/remove watch row. |

### `hrcchat wait`

| Reference | Classification | Migration |
| --- | --- | --- |
| `HRCCHAT_SPEC.md:1029` | doc-only | Replace with monitor wait message selector. |
| `HRCCHAT_SPEC.md:1059` | doc-only | Replace with monitor wait message selector. |
| `MONITOR_PROPOSAL.md:82` | doc-only | Command list; update after F3. |
| `packages/hrcchat-cli/src/commands/info.ts:31` | needs-migration | Replace quick-start example with monitor wait. |
| `packages/hrcchat-cli/src/main.ts:200` | needs-migration | Remove hrcchat `wait` registration. |
| `packages/hrcchat-cli/HRCCHAT_STATUS.md:93` | doc-only | Replace/remove wait row. |

### `hrcchat dm --wait`

| Reference | Classification | Migration |
| --- | --- | --- |
| `P1_VALIDATION_PLAN.md:415` | doc-only | Untracked local file at audit time; replace with `dm --json` plus monitor wait if retained. |
| `HRCCHAT_SPEC.md:211` | doc-only | Replace command syntax. |
| `HRCCHAT_SPEC.md:377` | doc-only | Replace section with handoff-envelope flow. |
| `HRCCHAT_SPEC.md:379` | doc-only | Replace behavior definition with monitor wait. |
| `HRCCHAT_SPEC.md:393` | doc-only | Replace output behavior with JSON envelope plus separate wait result. |
| `HRCCHAT_SPEC.md:676` | doc-only | Replace correlation text with monitor wait correlation. |
| `packages/hrcchat-cli/HRCCHAT_STATUS.md:59` | doc-only | Replace/remove support note. |
| `MONITOR_PROPOSAL.md:35` | doc-only | Proposal motivation; can remain as historical. |
| `MONITOR_PROPOSAL.md:83` | doc-only | Command list; update after F3. |
| `packages/hrcchat-cli/src/commands/dm.ts:56` | needs-migration | Remove `opts.wait` dispatch and timeout-implies-wait behavior. |
| `packages/hrcchat-cli/src/main.ts:121` | needs-migration | Remove `--wait` option. |

### Unrelated False Positive

| Reference | Classification | Migration |
| --- | --- | --- |
| `packages/cli/src/commands/repo/status.ts:144` | safe-to-delete from audit scope | This is `asp repo status`, not `hrc status`. No F3 migration. |

## Live Smoke Results

Live daemon: `/Users/lherron/praesidium/var/run/hrc/hrc.sock`.
Capture directory during audit: `/tmp/hrc-monitor-smoke-T-01294`.
All commands were run from `/Users/lherron/praesidium/agent-spaces` against the live HRC daemon.

Result: 6/11 passed. F3 is blocked.

| # | Command | Exit | Result |
| ---: | --- | ---: | --- |
| 1 | `hrc server status` | 0 | pass |
| 2 | `hrc server status --json` | 0 | pass |
| 3 | `hrc monitor show` | 0 | pass |
| 4 | `hrc monitor show clod@agent-spaces` | 2 | fail: unknown session |
| 5 | `hrc monitor show --json clod@agent-spaces` | 2 | fail: unknown session |
| 6 | `hrc monitor show msg:msg-1639525d-6b14-472f-b8d3-7d4f498cb703` | 2 | fail: unknown message |
| 7 | `hrc monitor watch` | 0 | pass: 100 replay lines |
| 8 | `hrc monitor watch --follow --until idle clod@agent-spaces --timeout 10s` | 2 | fail: unknown session |
| 9 | `hrc monitor wait clod@agent-spaces --until turn-finished --timeout 5s` | 0 | pass: `no_active_turn` |
| 10 | `hrcchat dm --json clod@agent-spaces -` | 0 | pass exit, but envelope has null `runtimeId`/`turnId` and `execution.state=not_applicable` |
| 11 | `hrc monitor wait msg:msg-713e484f-7196-430b-88eb-cca290adf038 --until response-or-idle --timeout 5m` | 4 | fail: `context_changed`, `generation_changed` |

### Smoke Output

#### 1. `hrc server status`

Exit: 0

```text
HRC Daemon Status
  running:      yes
  status:       healthy
  pid:          20385
  pid alive:    yes
  pid file:     /Users/lherron/praesidium/var/run/hrc/server.pid
  socket:       /Users/lherron/praesidium/var/run/hrc/hrc.sock (responsive)
  api health:   ok
  lock:         /Users/lherron/praesidium/var/run/hrc/server.lock (present)
  tmux:         running (26 session(s))
  tmux socket:  /Users/lherron/praesidium/var/run/hrc/tmux.sock
  uptime:       159522s
  started:      2026-04-25T20:05:12.415Z
  apiVersion:   0.1.0
```

#### 2. `hrc server status --json`

Exit: 0

```json
{
  "ok": true,
  "status": "healthy",
  "exitCode": 0,
  "running": true,
  "pid": 20385,
  "pidAlive": true,
  "socketResponsive": true,
  "apiHealth": {
    "ok": true
  },
  "api": {
    "startedAt": "2026-04-25T20:05:12.415Z",
    "uptime": 159523,
    "apiVersion": "0.1.0",
    "socketPath": "/Users/lherron/praesidium/var/run/hrc/hrc.sock",
    "dbPath": "/Users/lherron/praesidium/var/state/hrc/state.sqlite"
  },
  "tmux": {
    "available": true,
    "version": "tmux 3.6a",
    "running": true,
    "sessionCount": 26
  }
}
```

#### 3. `hrc monitor show`

Exit: 0

```text
HRC Monitor Snapshot
  daemon: healthy
  socket: /Users/lherron/praesidium/var/run/hrc/hrc.sock (responsive)
  event-log high-water: 51806
  tmux: available
  sessions: 336
  runtimes: 700
```

#### 4. `hrc monitor show clod@agent-spaces`

Exit: 2

```text
hrc: unknown session "agent:clod:project:agent-spaces/lane:main"
```

#### 5. `hrc monitor show --json clod@agent-spaces`

Exit: 2

```text
hrc: unknown session "agent:clod:project:agent-spaces/lane:main"
```

#### 6. `hrc monitor show msg:msg-1639525d-6b14-472f-b8d3-7d4f498cb703`

Exit: 2

```text
hrc: unknown message "msg-1639525d-6b14-472f-b8d3-7d4f498cb703"
```

#### 7. `hrc monitor watch`

Exit: 0

Stdout was 100 replayed JSON lines. First and last lines:

```json
{"event":"turn.tool_result","selector":"","replayed":true,"ts":"2026-04-27T16:20:00.173Z","seq":51709,"runtimeId":"rt-58aa33e9-0a72-49c6-af03-c334c98c4adc","turnId":"run-d31f399f-8a97-4e7f-b41f-168b67a3e082"}
{"event":"turn.tool_result","selector":"","replayed":true,"ts":"2026-04-27T16:23:14.409Z","seq":51788,"runtimeId":"rt-1c9cb9ec-9538-411a-b3d3-5feb7628bc54","turnId":"run-5d0acda9-b32a-419a-afc6-8a232797f436"}
```

#### 8. `hrc monitor watch --follow --until idle clod@agent-spaces --timeout 10s`

Exit: 2

```text
error: unknown session "agent:clod:project:agent-spaces/lane:main"
```

#### 9. `hrc monitor wait clod@agent-spaces --until turn-finished --timeout 5s`

Exit: 0

```text
monitor.completed selector=session:agent:clod:project:agent-spaces/lane:main condition=turn-finished result=no_active_turn exitCode=0
```

#### 10. `hrcchat dm --json clod@agent-spaces -`

Exit: 0

Captured message: `msg-713e484f-7196-430b-88eb-cca290adf038`.

```json
{
  "messageId": "msg-713e484f-7196-430b-88eb-cca290adf038",
  "seq": 828,
  "to": "clod@agent-spaces",
  "sessionRef": "agent:clod:project:agent-spaces/lane:main",
  "runtimeId": null,
  "turnId": null,
  "request": {
    "messageSeq": 828,
    "messageId": "msg-713e484f-7196-430b-88eb-cca290adf038",
    "createdAt": "2026-04-27T16:23:59.744Z",
    "kind": "dm",
    "phase": "request",
    "execution": {
      "state": "not_applicable"
    }
  }
}
```

#### 11. `hrc monitor wait msg:<captured-messageId> --until response-or-idle --timeout 5m`

Exit: 4

```text
monitor.completed selector=msg:msg-713e484f-7196-430b-88eb-cca290adf038 condition=response-or-idle result=context_changed reason=generation_changed exitCode=4
```

### Failure Diagnosis

The failure is reproducible against the live daemon and blocks F3.

Verified facts:

- `hrcchat status clod@agent-spaces` reports `agent:clod:project:agent-spaces/lane:main`, `hostSessionId=hsid-cbb4853b-00be-427a-bcb6-a656ed75050f`, `generation=4`, runtime `rt-a9ca7b19-9320-4723-b803-22d63709f9b7`, state `busy`.
- `hrc session list --scope agent:clod:project:agent-spaces --lane main` also shows generation 4 active for the same scope/lane.
- `hrc monitor show clod@agent-spaces` and `hrc monitor show --json clod@agent-spaces` fail with unknown session.
- The new message created by smoke item 10 is durable, but the JSON handoff envelope has `runtimeId: null`, `turnId: null`, and `request.execution.state: "not_applicable"`.
- `hrc monitor show --json msg:msg-713e484f-7196-430b-88eb-cca290adf038` resolves the message but reports `session.hostSessionId=hsid-b86ac758-bbe3-4ab9-ae01-8a5e8c21518d`, `generation=1`, while separately reporting runtime `rt-a9ca7b19-9320-4723-b803-22d63709f9b7` from generation 4.
- `hrc monitor wait msg:msg-713e484f-7196-430b-88eb-cca290adf038 --until response-or-idle --timeout 5m` exits 4 with `result=context_changed reason=generation_changed`.

Inference: monitor/message selector resolution is selecting or persisting an older active session generation for `clod@agent-spaces` while runtime status and hrcchat target status point at generation 4. This is consistent with the known message-selector response-correlation failure class, but it also affects smoke items 4, 5, 6, 8, 10, and 11.

Escalation required before F3: fix monitor selector/session correlation for live `clod@agent-spaces` and rerun all 11 smoke items.

## Re-smoke After T-01299

Date: 2026-04-27
Capture directory: `/tmp/hrc-monitor-t01299-resmoke-T-01294`
Fixes verified: `7550245` red regression coverage, `38edf23` green fix.

Scope: F3pre re-ran the two remaining red state-dependent items against
`agent-minder@agent-spaces`, per coordinator decision after T-01297, T-01298,
and T-01299 closed. Earlier final re-smoke had already passed items 1-7, 9,
and 10, with item 10 returning a non-null `runtimeId`.

Result: green for the remaining gate items. Combined F3pre gate is now 11/11 pass under the approved target plan.

| # | Command | Exit | Result |
| ---: | --- | ---: | --- |
| 8 | `hrc monitor watch --follow --until idle agent-minder@agent-spaces --timeout 10s` | 0 | `already_idle` |
| 11a | `hrcchat dm --json agent-minder@agent-spaces -` | 0 | captured `msg-558d7704-4c12-4721-b53f-927a8286cf21`, `runtimeId=rt-e372069d-6b33-4ffe-a9cb-cd0d1567b546`, `turnId=run-1c48452a-68b7-4d5f-b362-741ab7af0d4f` |
| 11 | `hrc monitor wait msg:msg-558d7704-4c12-4721-b53f-927a8286cf21 --until response-or-idle --timeout 5m` | 0 | `response` |

### Output

#### 8. `hrc monitor watch --follow --until idle agent-minder@agent-spaces --timeout 10s`

```json
{"event":"monitor.completed","selector":"session:agent:agent-minder:project:agent-spaces/lane:main","replayed":false,"ts":"2026-04-27T19:26:10.219Z","result":"already_idle","exitCode":0,"condition":"idle"}
```

#### 11a. `hrcchat dm --json agent-minder@agent-spaces -`

```json
{
  "messageId": "msg-558d7704-4c12-4721-b53f-927a8286cf21",
  "seq": 872,
  "to": "agent-minder@agent-spaces",
  "sessionRef": "agent:agent-minder:project:agent-spaces/lane:main",
  "runtimeId": "rt-e372069d-6b33-4ffe-a9cb-cd0d1567b546",
  "turnId": "run-1c48452a-68b7-4d5f-b362-741ab7af0d4f",
  "request": {
    "messageSeq": 872,
    "messageId": "msg-558d7704-4c12-4721-b53f-927a8286cf21",
    "createdAt": "2026-04-27T19:26:10.309Z",
    "kind": "dm",
    "phase": "request",
    "execution": {
      "state": "started",
      "mode": "headless",
      "sessionRef": "agent:agent-minder:project:agent-spaces/lane:main",
      "hostSessionId": "hsid-830ff461-49e7-4d8e-83e4-ab420d387da2",
      "generation": 2,
      "runtimeId": "rt-e372069d-6b33-4ffe-a9cb-cd0d1567b546",
      "runId": "run-1c48452a-68b7-4d5f-b362-741ab7af0d4f",
      "transport": "headless"
    }
  }
}
```

#### 11. `hrc monitor wait msg:<captured-messageId> --until response-or-idle --timeout 5m`

```text
monitor.completed selector=msg:msg-558d7704-4c12-4721-b53f-927a8286cf21 condition=response-or-idle result=response exitCode=0
```

## F4 Live E2E Smoke (post-T-01300)

Date: 2026-04-27
Coordinator: clod
HRC daemon socket: `/Users/lherron/praesidium/var/run/hrc/hrc.sock`
Capture directory: `/tmp/hrc-monitor-F4-clod-smoke`

### Removed surfaces (must reject)

| Command | Result |
| --- | --- |
| `hrc status` | `error: unknown command 'status'` ✓ |
| `hrc events` | `error: unknown command 'events'` ✓ |
| `hrc server health` | `unknown command: server health` ✓ |
| `hrcchat dm --wait foo bar` | `error: unknown option '--wait'` ✓ |

### Replacement surfaces (must succeed)

| # | Command | Exit | Result |
| --- | --- | ---: | --- |
| 1 | `hrc server status` | 0 | healthy daemon snapshot (pid, socket, tmux, uptime) |
| 2 | `hrc server status --json` | 0 | JSON with `status: "healthy"` |
| 3 | `hrc monitor show` | 0 | aggregate snapshot (daemon/socket/tmux/sessions/runtimes) |
| 4 | `hrc monitor show clod@agent-spaces` | 0 | scoped snapshot with sessionRef + runtime + status |
| 5 | `hrc monitor show --json clod@agent-spaces` | 0 | canonical JSON snapshot |
| 6 | `hrc monitor watch --follow --until idle agent-minder@agent-spaces --timeout 5s` | 0 | `result=already_idle` (T-01299 at-start short-circuit verified) |
| 7 | `hrcchat dm --json agent-minder@agent-spaces - <<<…` | 0 | envelope with messageId, runtimeId, turnId, sessionRef |
| 8 | `hrc monitor wait msg:<id> --until response-or-idle --timeout 60s` | 0 | `result=response` (T-01299 reply correlation verified) |

### Defect filed during F4

**T-01301 — `hrcchat dm --json` emits literal LF in body field (intermittent)**

Observed in `/tmp/hrc-monitor-F4-clod-smoke/07_dm_json_envelope.out`: the `body` string contains an unescaped U+000A control character, producing invalid JSON per RFC 8259 §7. Subsequent dispatches in the same shell with similar input produced valid JSON, so the bug is intermittent. Workaround during F4 smoke: extract `messageId` via grep instead of jq; the rest of the handoff flow then completed cleanly with `monitor wait msg:<id> --until response-or-idle`.

This does NOT block F3/F4 closure — the replacement contract is structurally correct and the e2e flow works. The defect is a JSON serialization bug in the envelope writer that should be addressed separately.

### Result

F4 e2e smoke: **GREEN** (all replacements work end-to-end against canonical paths).
One non-blocking defect filed as T-01301.
