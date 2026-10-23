export function exactRouteKey(method: string, pathname: string): string {
  return `${method} ${pathname}`
}

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
