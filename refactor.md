Next refactor pass for `packages/hrc-server`: reduce coupling left behind after
the index.ts decomposition.

Scope:
- Work only in `hrc-runtime` unless a compile error requires nearby type/export
  changes.
- This is a simplification/refactor pass, not a feature pass and not a runtime
  vocabulary or persistence rewrite.
- Preserve public package exports, HTTP routes, request/response shapes, event
  names, DB schema/migrations, package scripts, launchd paths, and runtime
  semantics.
- Preserve the current `just install` / installed-binary validation bar before
  calling the work complete.

Current shape:
- `packages/hrc-server/src/index.ts` is no longer the main monolith, but it still
  wires a large route map and prototype-attached handler methods.
- `server-instance-context.ts` exposes a broad handler context with many
  `HandlerMethod` aliases. This keeps the split working, but it weakens type
  locality and makes every domain look coupled to the whole server instance.
- `server-parsers.ts` is now the largest general-purpose hub and is imported by
  most handler domains.
- `broker/controller.ts` is still a large multi-responsibility class.

Primary targets, in preferred order:

1. Split `server-parsers.ts` by API/domain.
   Suggested modules:
   - `parsers/common.ts`: `isRecord`, JSON body parsing, primitive field/query
     helpers.
   - `parsers/runtime.ts`: runtime ensure/start/inspect/action/turn/in-flight
     request parsing.
   - `parsers/app-sessions.ts`: app-session specs, selectors, managed session
     requests, freshness fences.
   - `parsers/bridges.ts`: bridge target/deliver/close selectors and requests.
   - `parsers/messages.ts`: message/session selector parsing.
   - `parsers/sweeps.ts`: runtime sweep, zombie sweep, active-run reconcile
     parsing.
   Move filesystem/profile lookup for runtime harness resolution out of parsing
   and into a focused resolver module. Parsing should validate shape; resolver
   code can perform IO.

2. Retire the prototype-handler pattern one domain at a time.
   Current handler modules are attached with `Object.assign` and share
   `HrcServerInstanceForHandlers`. Replace this gradually with explicit domain
   services or route modules that receive a small dependency object.
   Start with a low-risk domain such as event handlers or runtime list/adopt,
   then proceed to app sessions, bridge/surface, runtime control, messages, and
   turn dispatch.

   Desired direction:
   - `index.ts` owns server lifecycle, construction, route aggregation, and
     shutdown.
   - Each domain owns its route declarations and handler implementation.
   - Shared dependencies are explicit: `ServerContext`, `HrcDatabase`, tmux,
     ghostmux, broker controller factory/accessor, subscriber notifier, and
     small helper services as needed.
   - Avoid passing the whole `HrcServerInstance` into domain modules.

3. Split `broker/controller.ts` around state-transition responsibilities.
   Suggested extraction points:
   - broker client/session lifecycle and simple RPC methods;
   - admission and capability checks;
   - start graph persistence (`compiledRuntimePlans`, runtime operations,
     runtimes, runs, invocations, lifecycle policies);
   - tmux allocation serialization/runtime-state helpers;
   - terminal/crash transition handling.

   Keep behavior unchanged and retain the public `HarnessBrokerController`
   surface unless a narrower export is clearly safe and all package consumers are
   updated.

4. Move routing toward domain-owned route definitions.
   The route map in `index.ts` should become route aggregation, not route
   ownership. Each domain module should export a small route table or registrar
   that binds methods to its explicit service.

5. Improve hrc-server test infrastructure only where it unlocks refactoring.
   Useful cleanup:
   - typed response helpers instead of repeated `(await res.json()) as any`;
   - typed server fixture override hooks instead of `(server as any)` method
     replacement;
   - centralized `TMPDIR=/tmp` guidance or fixture socket shortening for broker
     tests that hit the macOS Unix-socket path limit.

Process:
1. Run `git status --short` and preserve unrelated working-tree changes.
2. Read `AGENTS.md`, `packages/hrc-server/package.json`, `index.ts`,
   `server-instance-context.ts`, `server-parsers.ts`, `broker/controller.ts`,
   representative handler modules, and relevant tests before editing.
3. Make one domain-level change at a time. Avoid broad rewrites that mix parser,
   route, broker, and test cleanup in the same diff.
4. After each substantial extraction, run focused validation:
   `bun run --filter hrc-server typecheck` and the relevant hrc-server tests.
5. Avoid new `any`, `ts-ignore`, or generic "god context" types. If a temporary
   compatibility type is unavoidable, isolate it and document the next removal
   step.

End condition:
- `server-parsers.ts` is split into cohesive parser/resolver modules, with no
  parser file over 1,000 lines.
- At least one handler domain no longer uses prototype attachment or
  `HrcServerInstanceForHandlers`, proving the explicit-domain-service pattern.
- `index.ts` keeps route aggregation/lifecycle responsibilities and does not
  regain handler implementation logic.
- No newly-created hrc-server source file exceeds 1,500 lines.
- Existing public exports remain available or are intentionally re-exported.
- Validation passes:
  - `bun run --filter hrc-server typecheck`
  - `TMPDIR=/tmp bun run --filter hrc-server test`
  - `bun run --filter hrc-server build`
  - `bun run check:boundaries`
  - `bun run lint` if feasible, or document pre-existing/unrelated lint failures
- Before calling the work complete, run `just install`, restart/verify the real
  installed daemon, and smoke at least:
  - `hrc --help`
  - `hrc server status`
  - one real read-only API/CLI command against the running daemon

Final report should include:
- module map before/after;
- line counts for touched large files;
- validation and installed-binary smoke results;
- known risks and any temporary compatibility seams left for the following pass.
