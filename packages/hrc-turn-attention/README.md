# hrc-turn-attention

Node-local subscriber for T-12015's approved `attention-v3` contract. Follows
HRC's bounded event stream over the local Unix socket. On first deployment it
starts at the head; subsequent starts catch up from the private cursor. The
cursor also holds unfinished turns' message and user tails so a mid-turn
restart does not lose their context. A ledger incarnation mismatch stops the
process instead of applying an old cursor to a replacement ledger.

Only non-`T-<digits>` scopes are eligible, including foundry. The last assistant
`message_end` supplies the final text, including string or text-block content.
No transcript index is read. jev receives the verbatim last 2500 Unicode code
points, user prompt's last 400, and agent/project/seat. Its only attempt times
out after 3 seconds. Failed classifications and failed appends log and drop;
there is no classification retry or queue. Launchd supervises stream failures;
catch-up replays remain subject to the route's idempotency/freshness fence.

Build: `bun run --filter hrc-turn-attention build`.
Run: `TYPESAFE_API_KEY=… bun packages/hrc-turn-attention/src/cli.ts`.
Optional configuration: `HRC_SOCKET_PATH`, `HRC_TURN_ATTENTION_STATE_PATH`.
The cursor and atomic replacement have mode 0600; its directory is created 0700.

G1 (real hosted API, no retries):

```sh
bun packages/hrc-turn-attention/src/g1.ts
bun test packages/hrc-turn-attention
```

G1 imports the production classifier, checks all 412 gold rows and the six idle
IDs, and writes `fixtures/g1-results.jsonl` and `fixtures/g1-summary.json`.
The original research harness is preserved as `fixtures/eval_jev.py`; its v3
questions are copied verbatim into `src/questions.ts`. The process E2E test
requires `TYPESAFE_API_KEY` and otherwise reports skipped. It uses a private HRC
socket fixture grounded in real event rows and real jev, exercising catch-up,
restart text, task exclusion, none append, and invalid-key fail-open. It does
not stand in for G2–G5 on installed HRC/Loggia.

Publication joins the HRC selected-release tuple. After publishing, Mable runs
`just install-turn-attention-launchd <version>` with `TYPESAFE_API_KEY` exported.
This renders a private plist and loads `com.praesidium.hrc-turn-attention`.
The fleet deploy lane runs it after HRC and the injector; satellites pin the
version of max3's supervised job. The node's `.zshenv` must export the key for
that lane. Keys never enter command arguments or logs. G2–G5 and activation
belong to the coordinator, not this package's G1 acceptance.
