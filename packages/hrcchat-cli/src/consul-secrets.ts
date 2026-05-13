export type ExecProcessResult = {
  stdout: string
  stderr: string
  exitCode: number
}

export type ExecProcess = (argv: string[]) => Promise<ExecProcessResult>

export async function execProcess(argv: string[]): Promise<ExecProcessResult> {
  const proc = Bun.spawn(argv, {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, exitCode }
}

export async function consulKvGet(
  key: string,
  runProcess: ExecProcess = execProcess
): Promise<string | undefined> {
  let result: ExecProcessResult
  try {
    result = await runProcess(['consul', 'kv', 'get', key])
  } catch {
    return undefined
  }

  if (result.exitCode !== 0) {
    return undefined
  }

  const value = result.stdout.trim()
  return value.length > 0 ? value : undefined
}
