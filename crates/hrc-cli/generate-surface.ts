import type { Command } from 'commander'
// Build-time data only: rusthrc never invokes Bun or the legacy CLI.
import { buildProgram } from '../../packages/hrc-cli/src/cli/build-program'
import { renderRootHelp } from '../../packages/hrc-cli/src/cli/help'
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
  return {
    path,
    name: command.name(),
    aliases: command.aliases(),
    usage: command.usage(),
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
const output = `${JSON.stringify(surface(root, []), null, 2)}\n`
const target = new URL('./surface.json', import.meta.url)
if (process.argv.includes('--check')) {
  if ((await Bun.file(target).text()) !== output)
    throw new Error('rusthrc surface drift; run bun crates/hrc-cli/generate-surface.ts')
} else await Bun.write(target, output)
