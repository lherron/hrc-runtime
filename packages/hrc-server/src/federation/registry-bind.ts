import { isIP } from 'node:net'

export type RegistryListenerConfig = {
  readonly bind: string
}

function isTailscaleIpv4(host: string): boolean {
  const parts = host.split('.').map((part) => Number(part))
  const second = parts[1]
  return (
    parts.length === 4 &&
    parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) &&
    parts[0] === 100 &&
    second !== undefined &&
    second >= 64 &&
    second <= 127
  )
}

function isTailscaleIpv6(host: string): boolean {
  return host.toLowerCase().startsWith('fd7a:115c:a1e0:')
}

export function isTailnetHost(rawHost: string): boolean {
  const host = rawHost.replace(/^\[|\]$/g, '').toLowerCase()
  const family = isIP(host)
  if (family === 4) return isTailscaleIpv4(host)
  if (family === 6) return isTailscaleIpv6(host)
  return host.endsWith('.ts.net') && host.length > '.ts.net'.length
}

export function parseRegistryBind(raw: string, where: string): RegistryListenerConfig {
  const bind = raw.trim()
  let url: URL
  try {
    url = new URL(bind)
  } catch {
    throw new Error(`${where} bind is not a valid URL: ${JSON.stringify(bind)}`)
  }
  if (url.protocol !== 'http:') {
    throw new Error(`${where} bind must use http: (tailnet supplies transport encryption)`)
  }
  if (url.port.length === 0) {
    throw new Error(`${where} bind must include an explicit port`)
  }
  const port = Number(url.port)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${where} bind port must be between 1 and 65535`)
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname && url.pathname !== '/')
  ) {
    throw new Error(`${where} bind must contain only a tailnet host and explicit port`)
  }
  if (!isTailnetHost(url.hostname)) {
    throw new Error(
      `${where} bind must name a specific tailnet host (100.64.0.0/10, fd7a:115c:a1e0::/48, or *.ts.net), got ${JSON.stringify(url.hostname)}`
    )
  }
  return { bind }
}
