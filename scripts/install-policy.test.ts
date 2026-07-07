import { describe, expect, test } from 'bun:test'

import { computeInstallPolicy, detectContextFromGitDirs } from './install-policy'

describe('install policy', () => {
  test('keeps main-checkout install side effects enabled by default', () => {
    expect(computeInstallPolicy({ context: 'main' })).toEqual({
      context: 'main',
      syncMode: 'on',
      linkMode: 'on',
      publishChannel: 'dev',
      publishTag: 'latest',
    })
  })

  test('turns linked-worktree install sync and wrapper updates off by default', () => {
    expect(computeInstallPolicy({ context: 'linked-worktree' })).toEqual({
      context: 'linked-worktree',
      syncMode: 'off',
      linkMode: 'off',
      publishChannel: 'worktree',
      publishTag: 'worktree',
    })
  })

  test('allows loud force options from linked worktrees', () => {
    expect(
      computeInstallPolicy({ context: 'linked-worktree', forceSync: '1', forceLink: '1' })
    ).toMatchObject({
      syncMode: 'forced',
      linkMode: 'forced',
      publishChannel: 'worktree',
    })
  })

  test('honors explicit no-sync on the main checkout', () => {
    expect(computeInstallPolicy({ context: 'main', noSync: '1' }).syncMode).toBe('off')
  })

  test('rejects conflicting sync options', () => {
    expect(() => computeInstallPolicy({ context: 'main', noSync: '1', forceSync: '1' })).toThrow(
      'no-sync and force-sync cannot both be enabled'
    )
  })

  test('detects linked worktrees from distinct git dirs', () => {
    expect(detectContextFromGitDirs('/repo/worktree', '.git', '/repo/main/.git')).toBe(
      'linked-worktree'
    )
    expect(detectContextFromGitDirs('/repo/main', '.git', '.git')).toBe('main')
  })
})
