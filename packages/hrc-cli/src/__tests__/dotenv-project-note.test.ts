/**
 * A bare `hrc run <agent>` whose project came from ASP_PROJECT in an auto-loaded
 * .env.local (not the real environment) must say so. Lance ran `hrc run mable`
 * in ~/praesidium/var/agents/arris and silently got mable@agents from
 * var/agents/.env.local; the resolution stays, but it is never silent.
 */
import { describe, expect, it } from 'bun:test'

import { dotEnvProjectNote } from '../cli-runtime/dotenv-sources.js'

const SOURCE = '/Users/x/praesidium/var/agents/.env.local'

describe('dotEnvProjectNote', () => {
  it('names the file when the chosen project is the file-loaded ASP_PROJECT', () => {
    expect(dotEnvProjectNote({ projectId: 'agents', aspProject: 'agents', source: SOURCE })).toBe(
      `[hrc] project 'agents' from ASP_PROJECT in ${SOURCE}; pass '<agent>@<project>' or --project-id to choose another\n`
    )
  })

  it('is silent when ASP_PROJECT came from the real environment', () => {
    expect(
      dotEnvProjectNote({ projectId: 'agents', aspProject: 'agents', source: undefined })
    ).toBeUndefined()
  })

  it('is silent when the file value did not decide the project (cwd won)', () => {
    expect(
      dotEnvProjectNote({ projectId: 'arris', aspProject: 'agents', source: SOURCE })
    ).toBeUndefined()
  })
})
