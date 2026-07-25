const HRC_OTLP_PREFERRED_PORT_ENV = 'HRC_OTLP_PREFERRED_PORT'
const HRC_OTEL_PREFERRED_PORT_ENV = 'HRC_OTEL_PREFERRED_PORT'

type EnvMap = Record<string, string | undefined>

function readOptionalEnv(env: EnvMap, name: string): string | undefined {
  const value = env[name]
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

export function resolveOtelPreferredPortFromEnv(env: EnvMap = process.env): number | undefined {
  const raw =
    readOptionalEnv(env, HRC_OTLP_PREFERRED_PORT_ENV) ??
    readOptionalEnv(env, HRC_OTEL_PREFERRED_PORT_ENV)
  if (raw === undefined) return undefined

  if (!/^\d+$/.test(raw)) {
    throw new Error(
      `${HRC_OTLP_PREFERRED_PORT_ENV} must be an integer port, got ${JSON.stringify(raw)}`
    )
  }
  const port = Number.parseInt(raw, 10)
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`${HRC_OTLP_PREFERRED_PORT_ENV} must be between 0 and 65535, got ${raw}`)
  }
  return port
}
