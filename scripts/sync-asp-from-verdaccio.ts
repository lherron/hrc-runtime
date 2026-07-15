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
        'spaces-harness-broker',
        'spaces-runtime-contracts',
        'spaces-aspc-protocol',
        'spaces-aspc',
        'spaces-harness-claude',
        'spaces-harness-codex',
        'spaces-harness-pi',
        'spaces-harness-pi-sdk',
        'agent-spaces',
      ],
    },
  ],
}

if (import.meta.main) await runVerdaccioSyncCli(aspSyncSpec)
