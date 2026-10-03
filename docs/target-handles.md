---
id: hrc-runtime/target-handles
title: Target handle and scope ref grammar
kind: reference
authority: descriptive
status: active
visibility: internal
provenance: authored
---

# Target handle and scope ref grammar

HRC addresses agent sessions two ways: a short **target handle** that humans
and scripts type, and a canonical **scope ref / session ref** pair that HRC
stores and prints. Both are stable, node-free identity forms — they never
encode which machine a session lives on (see Praesidium federation doctrine
for placement/routing, which is a separate concern from identity).

## Target handle (shorthand) — what you type

Most user-facing commands (`hrc run`, `hrc start`, `hrc attach`, monitor
selectors) and `wrkc` addressing accept:

```
<agentId>
<agentId>@<projectId>
<agentId>@<projectId>:<taskId>
<agentId>@<projectId>:<taskId>/<roleName>
```

A handle may also pin a **lane** with `~<lane>`:

```
<handle>~<lane>
```

Full grammar in one line:

```
agentId[@projectId[:taskId[/roleName]]][~lane]
```

Examples:

```
cody
cody@agent-spaces
cody@agent-spaces:T-123
cody@agent-spaces:T-123/reviewer
cody@agent-spaces~repair
cody@agent-spaces:T-123/reviewer~planning
```

### Resolution rules

- If `@<projectId>` is omitted, HRC infers it in order: explicit
  `--project-id` → `ASP_PROJECT` env → the cwd-inferred project. For an
  interactive (TTY) invocation where the cwd is a registered project that
  differs from `ASP_PROJECT`, the physical cwd wins (a stderr note is
  printed).
- If `:<taskId>` is omitted, the shared agent-scope resolver fills the task
  default `primary`.
- Managed handle commands (`run`/`start`/`attach`) default the lane to
  `main` when `~<lane>` is omitted.
- Low-level `hrc session resolve --scope <scopeRef>` takes a canonical
  scope ref, not a handle, and defaults to `main` unless `--lane` is passed
  explicitly.

## Scope ref / session ref (canonical) — what HRC stores

The handle resolves to a canonical, fully-qualified pair. These are what
appear in JSON output and error messages:

```
scopeRef     agent:<agentId>:project:<projectId>:task:<taskId>[:role:<roleName>]
sessionRef   <scopeRef>/lane:<lane>
```

Examples:

| Handle | scopeRef | lane |
| --- | --- | --- |
| `cody@agent-spaces` | `agent:cody:project:agent-spaces:task:primary` | `main` |
| `cody@agent-spaces:T-123` | `agent:cody:project:agent-spaces:task:T-123` | `main` |
| `cody@agent-spaces:T-123/reviewer` | `agent:cody:project:agent-spaces:task:T-123:role:reviewer` | `main` |
| `cody@agent-spaces~repair` | `agent:cody:project:agent-spaces:task:primary` | `repair` |

The task and role are part of the scope ref; the lane is only in the
session ref.

## Monitor selectors

`hrc show` and `hrc monitor show | watch | wait` accept a selector that is
either a target handle or an explicit prefixed form:

```
<handle>                       e.g. clod@agent-spaces  (session selector)
runtime:<runtimeId>            one runtime (a raw runtimeId also works)
host:<hostSessionId>           one host session (a raw hostSessionId also works)
scope:<scopeRef>               canonical scope ref
session:<sessionRef>           canonical session ref
msg:<messageId>                a durable message (response waits need exactly one msg: or seq:)
seq:<messageSeq>               a durable message by sequence
```

Raw native IDs win first, explicit prefixes win by type, and ambiguous bare
selectors fail closed.

A bare/empty selector means "all events / aggregate snapshot." Task/prefix
or multiple selectors form a *quantified* family (`--until-any` / `--until-all`);
exact single selectors use plain `--until`.

## Where this grammar is enforced

- Handle and scope ref parsing live in the ASP `agent-scope` package
  (`resolveScopeInput`, `parseScopeRef`), consumed by HRC — HRC does not own
  the ref grammar itself, it resolves handles down to it.
- HRC's project defaulting is `packages/hrc-cli/src/cli/scope.ts`; selector
  resolution is `packages/hrc-cli/src/selector-resolve.ts`.
- The full command-level detail for every consumer of this grammar (run,
  start, attach, monitor) is in `hrc-runtime/cli-surface`.

## Federation note

Identity stays node-free by design: a scope's home node is never encoded in
`scopeRef`/`sessionRef`. Federation v1.3 never moves an established scope;
see [Federation ordered retirement](federation-registry-retirement.md). Placement, routing, and the
binding registry are a federation-layer concern layered on top of this
identity grammar, not encoded inside it.
