import { describe, expect, test } from 'bun:test'
import { openHrcDatabase } from '../database.js'

function session(
  db: ReturnType<typeof openHrcDatabase>,
  scopeRef = 'agent:cody:project:hrc-runtime:task:primary'
) {
  db.sessions.insert({
    hostSessionId: 'hsid-meta',
    scopeRef,
    laneRef: 'main',
    generation: 1,
    status: 'active',
    createdAt: '2026-10-03T00:00:00Z',
    updatedAt: '2026-10-03T00:00:00Z',
  })
  return db.continuities.upsert({
    scopeRef,
    laneRef: 'main',
    activeHostSessionId: 'hsid-meta',
    updatedAt: '2026-10-03T00:00:00Z',
  })
}
describe('continuity metadata', () => {
  test('identity is stored once and historical rows omit identity', () => {
    const db = openHrcDatabase(':memory:')
    const c = session(db)
    expect(c.identity).toEqual({
      kind: 'project-task',
      agentId: 'cody',
      projectId: 'hrc-runtime',
      taskId: 'primary',
    })
    expect(db.sessions.getByHostSessionId('hsid-meta')?.identity).toEqual(c.identity)
    db.continuities.disassociateScope(c.scopeRef)
    expect(db.sessions.getByHostSessionId('hsid-meta')?.identity).toBeUndefined()
    db.close()
  })
  test('source precedence, replacement, atomic rejection, no-op events and rotate persistence', () => {
    const db = openHrcDatabase(':memory:')
    const c = session(db)
    const write = (
      source: 'api' | 'launch',
      set: Record<string, unknown>,
      replace = false,
      clear: string[] = []
    ) =>
      db.sessionMetadata.write({
        scopeRef: c.scopeRef,
        laneRef: 'main',
        source,
        set,
        replace,
        clear,
        updatedBy: 'test',
      })
    write(
      'launch',
      { title: 'Launch', appearance: { color: '#123456', terminalFg: '#ffffff' } },
      true
    )
    write('api', { title: 'Override' })
    expect(db.sessionMetadata.get(c.scopeRef, 'main').metadata.title).toBe('Override')
    const count = db.hrcEvents.maxHrcSeq()
    write('api', { title: 'Override' })
    expect(db.hrcEvents.maxHrcSeq()).toBe(count)
    expect(() => write('api', { appearance: 'collision', 'bad key': 1 })).toThrow()
    expect(db.sessionMetadata.get(c.scopeRef, 'main').metadata.title).toBe('Override')
    write('api', {}, false, ['title'])
    expect(db.sessionMetadata.get(c.scopeRef, 'main').metadata.title).toBe('Launch')
    write('launch', { title: 'New' }, true)
    expect(db.sessionMetadata.get(c.scopeRef, 'main').metadata.appearance).toBeUndefined()
    db.sessions.insert({
      hostSessionId: 'hsid-meta-2',
      scopeRef: c.scopeRef,
      laneRef: 'main',
      generation: 2,
      status: 'active',
      createdAt: '2026-10-03T00:00:01Z',
      updatedAt: '2026-10-03T00:00:01Z',
    })
    db.continuities.upsert({ ...c, activeHostSessionId: 'hsid-meta-2' })
    expect(db.sessionIndex.listPage({ limit: 10 }).items[0]?.title).toBe('New')
    expect(write('launch', { 'appearance.color': 'invalid', good: 1 }, true).rejected).toHaveLength(
      1
    )
    expect(db.sessionMetadata.get(c.scopeRef, 'main').metadata.good).toBe(1)
    expect(() => write('api', { ['a'.repeat(65)]: 1 })).toThrow()
    db.close()
  })
})
