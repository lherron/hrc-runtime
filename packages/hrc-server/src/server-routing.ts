export function exactRouteKey(method: string, pathname: string): string {
  return `${method} ${pathname}`
}

const SESSION_TITLE_ROUTE = /^\/v1\/sessions\/([^/]+)\/title$/

const RUNTIME_SEAT_ROUTE = /^\/v1\/runtimes\/([^/]+)\/seat$/

export function matchRuntimeSeatRoute(
  method: string,
  pathname: string
): { runtimeId: string } | undefined {
  if (method !== 'GET') return undefined
  const match = pathname.match(RUNTIME_SEAT_ROUTE)
  const encodedRuntimeId = match?.[1]
  if (encodedRuntimeId === undefined || encodedRuntimeId.length === 0) return undefined
  return { runtimeId: decodeURIComponent(encodedRuntimeId) }
}

export function matchSessionTitleRoute(
  method: string,
  pathname: string
): { encodedHostSessionId: string } | undefined {
  if (method !== 'POST' && method !== 'DELETE') return undefined
  const match = pathname.match(SESSION_TITLE_ROUTE)
  const encodedHostSessionId = match?.[1]
  return encodedHostSessionId === undefined ? undefined : { encodedHostSessionId }
}
