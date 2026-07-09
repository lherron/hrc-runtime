import { cp, rm } from 'node:fs/promises'
import { join } from 'node:path'

const root = join(import.meta.dir, '..')

await rm(join(root, 'dist'), { recursive: true, force: true })
await cp(join(root, 'payload-dist'), join(root, 'dist'), { recursive: true })
