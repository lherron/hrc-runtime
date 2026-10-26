import type { Command } from 'commander'
// Build-time data only: rusthrc never invokes Bun or the legacy CLI.
import { buildProgram } from '../../packages/hrc-cli/src/cli/build-program'
import { cmdAttach } from '../../packages/hrc-cli/src/cli/handlers-scope-attach'
import { printManagedScopeUsage } from '../../packages/hrc-cli/src/cli/handlers-scope-managed'
import { buildInfoText, renderRootHelp } from '../../packages/hrc-cli/src/cli/help'
const actionUsage: Record<string, string> = {}
for (const name of ['start', 'run', 'attach'] as const) {
  let text = ''
  const original = process.stdout.write
  process.stdout.write = ((chunk: string) => {
    text += chunk
    return true
  }) as typeof original
  try {
    if (name === 'attach') await cmdAttach([])
    else printManagedScopeUsage(name)
  } finally {
    process.stdout.write = original
  }
  actionUsage[name] = text
}
const root = buildProgram()
function completeHelp(command: Command): string {
  let output = ''
  command.configureOutput({
    writeOut: (text) => {
      output += text
    },
  })
  command.outputHelp()
  return output
}
function surface(command: Command, path: string[]): unknown {
  const usage = path.length === 1 ? actionUsage[path[0] ?? ''] : undefined
  return {
    path,
    name: command.name(),
    aliases: command.aliases(),
    usage: command.usage(),
    allowExcessArguments: (command as Command & { _allowExcessArguments: boolean })
      ._allowExcessArguments,
    ...(usage ? { actionUsage: usage } : {}),
    help: path.length ? completeHelp(command) : renderRootHelp(root, 'agent'),
    humanHelp: path.length ? completeHelp(command) : renderRootHelp(root, 'human'),
    arguments: command.registeredArguments.map((a) => ({
      name: a.name(),
      required: a.required,
      variadic: a.variadic,
    })),
    options: command.options.map((o) => ({
      flags: o.flags,
      short: o.short,
      long: o.long,
      required: o.required,
      optional: o.optional,
      mandatory: o.mandatory,
      negate: o.negate,
      defaultValue: o.defaultValue,
      choices: o.argChoices,
    })),
    children: command.commands.map((c) => surface(c, [...path, c.name()])),
  }
}
// `hrc info` text per view without the node block; rusthrc renders THIS NODE.
const info = {
  agent: buildInfoText(root, undefined, 'agent'),
  human: buildInfoText(root, undefined, 'human'),
}
const output = `${JSON.stringify({ ...(surface(root, []) as object), info }, null, 2)}\n`
const target = new URL('./surface.json', import.meta.url)
if (process.argv.includes('--check')) {
  if ((await Bun.file(target).text()) !== output)
    throw new Error('rusthrc surface drift; run bun crates/hrc-cli/generate-surface.ts')
} else await Bun.write(target, output)
