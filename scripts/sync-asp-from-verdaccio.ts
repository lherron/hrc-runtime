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
        // Both ship in the same ASP publish stream and are DIRECT hrc-runtime
        // dependencies: `agent-harness` is the binary `resolveBrokerBinary`
        // hands the agent-harness-tmux driver, and the pi-sdk package is what
        // that binary maps its turns with. Omitting them stranded the pair a
        // release behind the rest of the set while `pull-deps` reported the
        // stream advanced (T-07677) — an ASP version split inside HRC's own
        // dependency set, which is precisely what this list exists to prevent.
        'spaces-harness-broker-pi-sdk',
        'agent-harness',
        'spaces-runtime-contracts',
        'spaces-aspc-protocol',
        'spaces-aspc',
        'spaces-aspc-facade',
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
