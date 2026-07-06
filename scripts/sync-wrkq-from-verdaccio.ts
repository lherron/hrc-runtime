import { syncFromVerdaccio } from './lib/verdaccio-sync'

// @wrkq/client is its own dev-timestamp stream (0.1.0-dev.*), independent of ASP.
await syncFromVerdaccio({
  label: 'WRKQ',
  lockName: '.wrkq-sync.lock',
  tmpPrefix: 'hrc-wrkq-sync-',
  groups: [{ label: 'WRKQ', packages: ['@wrkq/client'] }],
})
