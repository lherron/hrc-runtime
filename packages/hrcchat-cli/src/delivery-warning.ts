import type { HrcDeliveryWarning } from 'hrc-core'

export function writeDeliveryWarnings(warnings: HrcDeliveryWarning[] | undefined): void {
  for (const warning of warnings ?? []) {
    process.stderr.write(`hrcchat: warning [${warning.code}]: ${warning.message}\n`)
  }
}
