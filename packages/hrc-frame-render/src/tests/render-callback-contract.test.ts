import { describe, expect, test } from 'bun:test'
import ts from 'typescript'

import {
  type OnRenderCallback,
  type RunState,
  SessionEventsManager,
} from '../session-events-manager.js'
import type { SessionEventEnvelope } from '../types.js'

const TEST_SESSION = 'agent:smokey:project:test-suite/lane:callback-contract'

function receive(
  manager: SessionEventsManager,
  envelope: Omit<SessionEventEnvelope, 'sessionRef'>
): void {
  manager.receive({
    sessionRef: TEST_SESSION,
    ...envelope,
  })
}

function compileConsumer(source: string): string[] {
  const rootName = `${import.meta.dir}/render-callback-contract-consumer.ts`
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    esModuleInterop: true,
    skipLibCheck: true,
    noEmit: true,
    isolatedModules: true,
    verbatimModuleSyntax: true,
  }
  const host = ts.createCompilerHost(options)
  const originalGetSourceFile = host.getSourceFile.bind(host)
  const originalReadFile = host.readFile.bind(host)
  const originalFileExists = host.fileExists.bind(host)

  host.fileExists = (fileName) => fileName === rootName || originalFileExists(fileName)
  host.readFile = (fileName) => (fileName === rootName ? source : originalReadFile(fileName))
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
    if (fileName === rootName) {
      return ts.createSourceFile(fileName, source, languageVersion, true)
    }
    return originalGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile)
  }

  const program = ts.createProgram([rootName], options, host)
  return ts
    .getPreEmitDiagnostics(program)
    .filter(
      (diagnostic) =>
        diagnostic.category === ts.DiagnosticCategory.Error &&
        (!diagnostic.file || diagnostic.file.fileName === rootName)
    )
    .map((diagnostic) => {
      const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
      if (!diagnostic.file || diagnostic.start === undefined) {
        return message
      }
      const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
      return `${diagnostic.file.fileName}:${line + 1}:${character + 1} ${message}`
    })
}

describe('SessionEventsManager render callback public contract', () => {
  test('exports preferred four-argument callback while retaining legacy compatibility', () => {
    // Public-surface red: consumers should be able to name the preferred
    // four-argument callback without losing the legacy five-argument path.
    const diagnostics = compileConsumer(`
      import {
        SessionEventsManager,
        type OnRenderCallback,
        type RenderFrame,
        type RenderFrameCallback,
      } from '../index.js'

      const preferred: RenderFrameCallback = (
        _sessionRef: string,
        _projectId: string,
        _runId: string,
        frame: RenderFrame
      ) => {
        frame.blocks.length
      }
      new SessionEventsManager('preferred', preferred)

      const legacy: OnRenderCallback = (_sessionRef, _projectId, _runId, frame, run) => {
        frame.blocks.length
        run.lastSeq
      }
      new SessionEventsManager('legacy', legacy)
    `)

    expect(diagnostics).toEqual([])
  })

  test('documents OnRenderCallback as deprecated in favor of RenderFrameCallback', async () => {
    const source = await Bun.file(`${import.meta.dir}/../session-events-manager.ts`).text()

    const deprecatedLegacyType = source.match(
      /\/\*\*[\s\S]*@deprecated[\s\S]*RenderFrameCallback[\s\S]*\*\/\s*export type OnRenderCallback/
    )

    expect(deprecatedLegacyType).not.toBeNull()
  })

  test('continues to pass RunState to legacy five-argument callbacks at runtime', () => {
    const legacyRuns: RunState[] = []
    const onRender: OnRenderCallback = (_sessionRef, _projectId, _runId, _frame, run) => {
      legacyRuns.push(run)
    }
    const manager = new SessionEventsManager('test', onRender)

    manager.subscribe(TEST_SESSION, 'test-proj')
    receive(manager, {
      projectId: 'test-proj',
      runId: 'run-legacy',
      seq: 1,
      event: {
        type: 'run_started',
        runId: 'run-legacy',
        projectId: 'test-proj',
        startedAt: 1,
      },
    })

    expect(legacyRuns).toHaveLength(1)
    expect(legacyRuns[0]).toBe(manager.getRunState(TEST_SESSION, 'run-legacy'))
    expect(legacyRuns[0]?.lastSeq).toBe(1)
  })
})
