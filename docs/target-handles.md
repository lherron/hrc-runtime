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

Managed commands (`hrc run`, `hrc start`, `hrc attach`) and monitor
selectors accept these handle forms. Their defaulting rules differ below;
`wrkc` is a separate CLI with its own addressing contract (`wrkc info`).

```
<agentId>
<agentId>@<projectId>
<agentId>@<projectId>:<taskId>
<agentId>@<projectId>/<roleName>
<agentId>@<projectId>:<taskId>/<roleName>
```

A handle may also pin a **lane** with `~<lane>`:

```
<handle>~<lane>
```

Full grammar in one line:

```
agentId[@projectId[:taskId][/roleName]][~lane]
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

Each scope identity token (`agentId`, `projectId`, `taskId`, `roleName`) uses
`[A-Za-z0-9._-]+`, with a length of 1–64 characters.
A task ID here is a scope token: it can be `primary`, a standing seat name,
or a wrkq ID such as `T-12345` or `T-12345.render`.

Managed scope inputs also accept `agentId:taskId` when a project can be
inferred, and a `+key=value` provisioning directive block. Directives are
request options, outside the canonical identity; they are not accepted as
part of a monitor handle. See [CLI surface](/docs/hrc-runtime/cli-surface) for provisioning.

### Resolution rules

- For managed commands, if `@<projectId>` is omitted, HRC infers it in order:
  explicit `--project-id` → `ASP_PROJECT` env → the cwd-inferred project. For an
  interactive (TTY) invocation where the cwd is a registered project that
  differs from `ASP_PROJECT`, the physical cwd wins (a stderr note is
  printed). An explicit project in the input wins over these fallbacks.
- Once a project is known, an omitted task uses nonblank `ASP_DEFAULT_TASK`,
  falling back to `primary`. Without a project, an agent-only scope remains
  `agent:<agentId>`.
- An explicit task with no explicit role can acquire the agent profile's
  default role through placement resolution. Spell `/roleName` to select a
  role explicitly.
- Managed handle commands (`run`/`start`/`attach`) default the lane to
  `main` when `~<lane>` is omitted.
- Monitor handles do **not** infer a project from `ASP_PROJECT` or cwd.
  `clod` selects the agent-only scope; use `clod@hrc-runtime` for the project
  scope (with the task default above).
- Low-level `hrc session resolve --scope <scopeRef>` takes a canonical
  scope ref, not a handle, and defaults to `main` unless `--lane` is passed
  explicitly.

## Scope ref / session ref (canonical) — what HRC stores

The handle resolves to a canonical scope and session pair. These are what
appear in JSON output and error messages:

```
scopeRef     agent:<agentId>[:project:<projectId>[:task:<taskId>][:role:<roleName>]]
sessionRef   <scopeRef>/lane:<lane>
```

Examples assume the default task is `primary` and no profile role is added:

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
runtime:<runtimeId>            one runtime
host:<hostSessionId>           one host session
scope:<scopeRef>               canonical scope ref
session:<sessionRef>           canonical session ref
msg:<messageId>                a durable message (response waits need exactly one msg: or seq:)
seq:<messageSeq>               a durable message by sequence
```

Use the explicit `runtime:` and `host:` prefixes for monitor commands: bare
strings are parsed as handles, not detected as native IDs. Other operator
commands using `selector-resolve` support raw native IDs; their grammar is
separate from monitor's.

Omitting selectors gives all events or an aggregate snapshot; an explicit
empty string is invalid. `monitor watch` / `wait` also accept a task selector
such as `T-12345` or `T-12345.render`, and a scope prefix such as
`scope:agent:clod:project:hrc-runtime:*`. Task/prefix or multiple selectors
form a *quantified* family (`--until-any` / `--until-all`); exact single
selectors use plain `--until`. `show` accepts one exact selector.

## Where this grammar is enforced

- The Rust CLI's canonical scope grammar is in
  `crates/hrc-common/src/scope.rs`; managed input parsing and project/task
  defaulting are in `crates/hrc-cli/src/scope.rs`.
- Monitor parsing and task/prefix families are in
  `crates/hrc-cli/src/monitor/selector.rs` and `monitor/spec.rs`. Other
  operator selector resolution is in `crates/hrc-cli/src/selectors.rs`.
- TypeScript consumers use ASP's `agent-scope` package and HRC's
  `packages/hrc-cli/src/cli/scope.ts`, `profile-aware-selector.ts`, and
  `selector-resolve.ts`; monitor families use `monitor/selector-shape.ts`.
- Command-level detail is in [CLI surface](/docs/hrc-runtime/cli-surface).

## Federation note

Identity stays node-free by design: a scope's home node is never encoded in
`scopeRef`/`sessionRef`. Federation v1.3 never moves an established scope;
see [Federation ordered retirement](https://github.com/lherron/hrc-runtime/blob/main/docs/federation-registry-retirement.md). Placement, routing, and the
binding registry are a federation-layer concern layered on top of this
identity grammar, not encoded inside it.
