import { type SyncSpec, runVerdaccioSyncCli } from './lib/verdaccio-sync'

// ASP publishes as one coherent dev-timestamp stream (0.1.1-dev.*). hrc-runtime
// consumes it but publishes its own HRC stream, so there is no HRC group here.
export const aspSyncSpec: SyncSpec = {
  label: 'ASP',
  lockName: '.asp-sync.lock',
  tmpPrefix: 'hrc-asp-sync-',
  groups: [
    {
      label: 'ASP',
      packages: [
        'agent-scope',
        'cli-kit',
        'spaces-harness-broker-protocol',
        'spaces-harness-broker-client',
        // T-08596 (T-08569A closure): the bundled execution packages left this
        // list with the manifests that declared them (`agent-harness`,
        // `spaces-harness-broker`, `spaces-harness-broker-pi-sdk`,
        // `spaces-aspc-facade`, `spaces-harness-codex`). The T-07677 lesson
        // still applies to everything that remains: every package HRC's
        // manifests declare must be listed here or `pull-deps` reports green
        // while the set splits. T-08597 (T-08569B interpretation migration)
        // completes the trim: spaces-config, spaces-runtime, spaces-execution,
        // and agent-spaces leave this list with the manifests that declared
        // them. hrc-frame-render keeps a type-only spaces-runtime edge.
        'spaces-runtime-contracts',
        'spaces-aspc-protocol',
        'spaces-aspc',
        'spaces-harness-claude',
        'spaces-harness-muse',
        'spaces-harness-pi',
        'spaces-harness-pi-sdk',
      ],
    },
  ],
}

if (import.meta.main) await runVerdaccioSyncCli(aspSyncSpec)
