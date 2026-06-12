export function exactRouteKey(method: string, pathname: string): string {
  return `${method} ${pathname}`
}

const LAUNCH_SUBROUTE_PREFIX = '/v1/internal/launches/'
const LAUNCH_SUBROUTE_SUFFIXES = [
  'continuation',
  'wrapper-started',
  'child-started',
  'event',
  'exited',
] as const

export function matchLaunchSubroute(
  method: string,
  pathname: string
): { launchId: string; suffix: (typeof LAUNCH_SUBROUTE_SUFFIXES)[number] } | undefined {
  if (method !== 'POST' || !pathname.startsWith(LAUNCH_SUBROUTE_PREFIX)) {
    return undefined
  }
  for (const suffix of LAUNCH_SUBROUTE_SUFFIXES) {
    if (pathname.endsWith(`/${suffix}`)) {
      const launchId = pathname.slice(LAUNCH_SUBROUTE_PREFIX.length).replace(`/${suffix}`, '')
      return { launchId, suffix }
    }
  }
  return undefined
}
