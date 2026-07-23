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

Most user-facing commands (`hrc run`, `hrc start`, `hrc attach`,
`hrcchat dm`, monitor selectors) accept:

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
- Managed handle commands (`run`/`start`/`attach`) default the lane to
  `main` when `~<lane>` is omitted.
- Low-level `hrc session resolve` defaults to `main` unless `--lane` is
  passed explicitly.

## Scope ref / session ref (canonical) — what HRC stores

The handle resolves to a canonical, fully-qualified pair. These are what
appear in JSON output and error messages:

```
scopeRef     agent:<agentId>:project:<projectId>
sessionRef   agent:<agentId>:project:<projectId>/lane:<lane>
```

Example: `cody@agent-spaces` resolves to
`scopeRef = agent:cody:project:agent-spaces` and
`sessionRef = agent:cody:project:agent-spaces/lane:main`.

Note the canonical forms have no `taskId`/`roleName` segment in the ref
strings shown above — task/role selection composes with the runtime and
message dispatch layer on top of the agent/project scope, not into a
different ref shape at this layer.

## Monitor selectors

`hrc monitor show | watch | wait` accept a selector that is either a target
handle (resolved to a session selector as above) or an explicit prefixed
form:

```
<handle>                       e.g. clod@agent-spaces  (session selector)
msg:<messageId>                a specific durable message (required for response* waits)
```

A bare/empty selector means "all events / aggregate snapshot." Task/prefix
or multiple selectors form a *quantified* family (`--until-any` / `--until-all`);
exact single selectors use plain `--until`.

## Where this grammar is enforced

- Handle parsing/normalization: `packages/hrcchat-cli/src/normalize.ts` and
  the equivalent resolution path in `hrc-cli`.
- Scope ref parsing lives in the ASP `agent-scope` package
  (`parseScopeRef`), consumed by HRC — HRC does not own the ref grammar
  itself, it resolves handles down to it.
- The full command-level detail for every consumer of this grammar (run,
  start, attach, monitor, hrcchat dm) is in `hrc-runtime/cli-surface` and
  `hrc-runtime/hrcchat-messaging`.

## Federation note

Identity stays node-free by design: nothing in `scopeRef`/`sessionRef`
changes when a scope's home node changes. Placement, routing, and the
binding registry are a federation-layer concern layered on top of this
identity grammar, not encoded inside it.
