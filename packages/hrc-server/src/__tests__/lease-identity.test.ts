import { describe, expect, it } from 'bun:test'

import { parseLsofUnixSocketPaths } from '../startup-reconcile/lease-identity'

describe('parseLsofUnixSocketPaths', () => {
  it.each([
    ['macOS', 'n/tmp/codex-app-server-renderer-control.test.sock'],
    ['Linux', 'n/tmp/codex-app-server-renderer-control.test.sock type=STREAM'],
  ])('parses the %s lsof NAME field shape', (_platform, nameField) => {
    const paths = parseLsofUnixSocketPaths(`p123\nf4\n${nameField}\n`)

    expect(paths).toEqual(new Set(['/tmp/codex-app-server-renderer-control.test.sock']))
  })
})
