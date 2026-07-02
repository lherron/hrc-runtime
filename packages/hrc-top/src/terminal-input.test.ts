import { describe, expect, it } from 'bun:test'

import {
  HrcTopTerminalInputDecoder,
  drainHrcTopPendingInput,
  restoreHrcTopTerminalAfterSpawn,
} from './index.js'
import { interpretHrcTopKey } from './keymap.js'

describe('hrc-top terminal input hygiene', () => {
  it.each([
    ['device attributes', '\u001b[?62;1c'],
    ['focus in', '\u001b[I'],
    ['focus out', '\u001b[O'],
    ['cursor position report', '\u001b[12;34R'],
    ['ss3 function key', '\u001bOP'],
    ['legacy mouse packet', '\u001b[Mabc'],
  ])('swallows %s without emitting action or noop keys', (_name, sequence) => {
    const decoder = new HrcTopTerminalInputDecoder()

    const keys = decoder.feed(Buffer.from(sequence, 'utf8'))

    expect(keys).toEqual([])
    expect(keys.map((key) => interpretHrcTopKey(key).intent)).toEqual([])
  })

  it('does not fire actions for printable action bytes inside terminal reports', () => {
    const decoder = new HrcTopTerminalInputDecoder()

    const keys = decoder.feed(Buffer.from('\u001b[?62;1c\u001b[12;34R\u001b[I', 'utf8'))

    expect(keys).toEqual([])
  })

  it('keeps bare printable action and quit keys active', () => {
    const decoder = new HrcTopTerminalInputDecoder()

    expect(decoder.feed(Buffer.from('acq', 'utf8'))).toEqual(['a', 'c', 'q'])
    expect(interpretHrcTopKey('a').intent).toEqual({ type: 'action', key: 'a' })
    expect(interpretHrcTopKey('c').intent).toEqual({ type: 'action', key: 'c' })
    expect(interpretHrcTopKey('q').intent).toEqual({ type: 'quit' })
  })

  it('drains buffered terminal responses before post-spawn input resumes', () => {
    const reads = [
      Buffer.from('\u001b[?62;1c', 'utf8'),
      Buffer.from('\u001b[12;34Ra', 'utf8'),
      null,
    ]
    const calls: string[] = []
    const input = {
      read() {
        calls.push('read')
        return reads.shift()
      },
    }
    const decoder = new HrcTopTerminalInputDecoder()

    expect(drainHrcTopPendingInput(input, decoder)).toBe(2)
    calls.push('resume')

    expect(calls).toEqual(['read', 'read', 'read', 'resume'])
    expect(decoder.feed(Buffer.from('q', 'utf8'))).toEqual(['q'])
  })

  it('restores after spawn by draining before resume and forcing a clear redraw', () => {
    const reads = [Buffer.from('\u001b[?62;1c', 'utf8'), null]
    const calls: string[] = []
    const outputChunks: string[] = []
    const input = {
      setRawMode(mode: boolean) {
        calls.push(`raw:${mode}`)
        return this
      },
      read() {
        calls.push('read')
        return reads.shift()
      },
      resume() {
        calls.push('resume')
        return this
      },
    }
    const output = {
      write(chunk: string) {
        outputChunks.push(chunk)
        return true
      },
    }

    const drained = restoreHrcTopTerminalAfterSpawn({
      input,
      output,
      decoder: new HrcTopTerminalInputDecoder(),
      redraw: () => {
        calls.push('redraw')
        output.write('\u001b[H\u001b[2Jscreen')
      },
    })

    expect(drained).toBe(1)
    expect(calls).toEqual(['raw:true', 'read', 'read', 'resume', 'redraw'])
    expect(outputChunks.join('')).toContain('\u001b[?25l\u001b[H\u001b[2J')
  })
})
