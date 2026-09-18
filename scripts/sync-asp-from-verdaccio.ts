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
        'spaces-config',
        'spaces-runtime',
        'spaces-execution',
        'spaces-harness-broker-protocol',
        'spaces-harness-broker-client',
        // T-08596 (T-08569A closure): the bundled execution packages left this
        // list with the manifests that declared them (`agent-harness`,
        // `spaces-harness-broker`, `spaces-harness-broker-pi-sdk`,
        // `spaces-aspc-facade`, `spaces-harness-codex`). The T-07677 lesson
        // still applies to everything that remains: every package HRC's
        // manifests declare must be listed here or `pull-deps` reports green
        // while the set splits. The full trim of the remaining execution
        // packages follows the T-08569B interpretation migration.
        'spaces-runtime-contracts',
        'spaces-aspc-protocol',
        'spaces-aspc',
        'spaces-harness-claude',
        'spaces-harness-muse',
        'spaces-harness-pi',
        'spaces-harness-pi-sdk',
        'agent-spaces',
      ],
    },
  ],
}

if (import.meta.main) await runVerdaccioSyncCli(aspSyncSpec)
