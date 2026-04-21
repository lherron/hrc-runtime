import TOML from '@iarna/toml'

import type { HrcLaunchArtifact } from 'hrc-core'

type CodexOtelLaunchConfig = NonNullable<HrcLaunchArtifact['otel']>

function isTomlTable(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function injectCodexOtelConfig(configToml: string, otel: CodexOtelLaunchConfig): string {
  const parsedConfig =
    configToml.trim().length > 0 ? (TOML.parse(configToml) as Record<string, unknown>) : {}
  const config = isTomlTable(parsedConfig) ? { ...parsedConfig } : {}
  const otelConfig = isTomlTable(config['otel']) ? { ...config['otel'] } : {}

  otelConfig['environment'] = 'hrc'
  otelConfig['log_user_prompt'] = true
  otelConfig['metrics_exporter'] = 'none'
  otelConfig['trace_exporter'] = 'none'
  otelConfig['exporter'] = {
    'otlp-http': {
      endpoint: otel.endpoint,
      protocol: 'json',
      headers: {
        [otel.authHeaderName]: otel.authHeaderValue,
      },
    },
  }

  config['otel'] = otelConfig
  return `${TOML.stringify(config as TOML.JsonMap)}\n`
}
