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
