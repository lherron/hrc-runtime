# hrc-runtime docs

Current reference for the HRC runtime. Design records live in
[`architecture/`](../architecture/); standalone HTML specs live in `docs/html/`
(`just serve-docs`). Add every new page here with one line saying what it is for.

## Orientation

- [architecture-overview.md](architecture-overview.md) — map of the HRC packages, daemon, store, and how ASP/ACP connect to them.
- [hrc-server-architecture.md](hrc-server-architecture.md) — hrc-server internals: module topology, handler registration, and request parsing.
- [target-handles.md](target-handles.md) — grammar for target handles and ScopeRefs accepted by the CLI and API.

## CLI

- [cli-surface.md](cli-surface.md) — the `hrc` command surface by task: run/start/attach and the other verbs, with examples.
- [cli-reference.md](cli-reference.md) — flag-level reference for `hrc` and the `hrcchat` shim.
- [hrcchat-spec.md](hrcchat-spec.md) — `hrcchat` spec; now a redirect-only compatibility shim over `hrc-cli`.

## Runtime and protocols

- [harness-broker-substrate-spec.md](harness-broker-substrate-spec.md) — leased-tmux `harness-broker/0.2` substrate and the T-08690 v2 consumer amendment.
- [aspd-headless-codex-integration.md](aspd-headless-codex-integration.md) — producer-selected execution preparation through aspd.
- [lifecycle-event-tail.md](lifecycle-event-tail.md) — wire contract for `GET /v1/events/tail` bounded, cursor-fenced pages.
- [monitor-spec.md](monitor-spec.md) — HRC monitor spec: output schema, selectors, and the never-guess-success condition engine.
- [state-retention.md](state-retention.md) — retention policy for the live `state.sqlite` tables.

## Federation

- [federation-peer-protocol.md](federation-peer-protocol.md) — authenticated peer HTTP contract between nodes.
- [federation-binding-registry-rebuild.md](federation-binding-registry-rebuild.md) — rebuilding the binding registry from node placement ledgers.
- [federation-registry-retirement.md](federation-registry-retirement.md) — ordered, idempotent retirement of a scope on its home node.

## Build, install, operations

- [operations-runbook.md](operations-runbook.md) — day-to-day operation: runtime locations, restart doctrine, dependency sync.
- [atomic-install.md](atomic-install.md) — how `just install` builds a release image and cuts over atomically.
- [wave-b-registry.md](wave-b-registry.md) — Verdaccio single-authority contract for package publication.
- [isolated-daemon-smoke-recipe.md](isolated-daemon-smoke-recipe.md) — when and how to smoke against an isolated HRC daemon.
- [urgent-turn-smoke.md](urgent-turn-smoke.md) — smoke for the four broker admission classes against an installed release.
- [runbooks/broker-tmux-ghostmux-e2e.md](runbooks/broker-tmux-ghostmux-e2e.md) — repeatable ghostmux E2E harness for the broker-tmux substrate.

## Approved designs

- [proposals/install-publish-split.md](proposals/install-publish-split.md) — implemented design splitting local install selection from publication (T-08559).
- [proposals/viewer-sidecar-spec.md](proposals/viewer-sidecar-spec.md) — approved spec extracting Ghostty presentation from hrc-server into the viewer sidecar.

## Policy and process

- [rule-enforcers.md](rule-enforcers.md) — each repo rule and the check, type or test that fails when it is broken (or `judgment`).
- [suppression-policy.md](suppression-policy.md) — lint/type suppressions require a ticketed `EXCEPTION(T-…)` justification.
- [agent-enablement-changelog.md](agent-enablement-changelog.md) — append-only ledger of reusable agent-enablement lessons.
