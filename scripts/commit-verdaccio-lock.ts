import { commitSyncedLockfile } from './lib/verdaccio-sync'
import { aspSyncSpec } from './sync-asp-from-verdaccio'
import { wrkqSyncSpec } from './sync-wrkq-from-verdaccio'

await commitSyncedLockfile([...aspSyncSpec.groups, ...wrkqSyncSpec.groups])
