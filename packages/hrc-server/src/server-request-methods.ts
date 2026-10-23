import { markLoopActivity } from './event-loop-lag.js'
import type { HrcServerInstance } from './index.js'
import { handleGetInput, handleWatchInput, matchInputRoute } from './input-handlers.js'
import { normalizeRoute, observeRequest } from './request-metrics.js'
import {
  exactRouteKey,
  matchLaunchSubroute,
  matchRuntimeSeatRoute,
  matchSessionTitleRoute,
} from './server-routing.js'
import { errorResponse } from './server-util.js'
import {
  decodeSessionTitleHostSessionId,
  legacyLaunchIngestRetired,
  refuseExecutionFormatAtSealedDoor,
} from './session-title-helpers.js'

export const serverRequestMethods = {
  async handleRequest(this: HrcServerInstance, request: Request): Promise<Response> {
    const startedAt = performance.now()
    const method = request.method
    const pathname = new URL(request.url).pathname
    // Routes are all registered in the constructor, before the first request.
    this.exactRouteKeys ??= new Set(Object.keys(this.exactRouteHandlers))
    const route = normalizeRoute(method, pathname, this.exactRouteKeys)
    markLoopActivity(`request:${method} ${route}`)
    // dispatchRequest answers every throw with errorResponse, so the request
    // line and metric always see a status.
    const response = await this.dispatchRequest(request)
    return observeRequest({
      request,
      response,
      listener: 'main',
      route,
      path: pathname,
      startedAt,
      sink: this.requestMetricsSink,
    })
  },

  async dispatchRequest(this: HrcServerInstance, request: Request): Promise<Response> {
    try {
      const url = new URL(request.url)
      const pathname = url.pathname
      await refuseExecutionFormatAtSealedDoor(request, pathname)
      const exactRouteHandler = this.exactRouteHandlers[exactRouteKey(request.method, pathname)]
      if (exactRouteHandler) {
        return await exactRouteHandler(request, url)
      }

      const inputRoute = matchInputRoute(request.method, pathname)
      if (inputRoute) {
        return inputRoute.watch
          ? handleWatchInput.call(this, inputRoute.inputId, url, request)
          : handleGetInput.call(this, inputRoute.inputId)
      }

      if (request.method === 'GET' && pathname.startsWith('/v1/sessions/by-host/')) {
        const hostSessionId = pathname.slice('/v1/sessions/by-host/'.length)
        return this.handleGetSessionByHost(hostSessionId)
      }

      const sessionTitleRoute = matchSessionTitleRoute(request.method, pathname)
      if (sessionTitleRoute) {
        const hostSessionId = decodeSessionTitleHostSessionId(
          sessionTitleRoute.encodedHostSessionId
        )
        return request.method === 'POST'
          ? await this.handleSetSessionTitle(hostSessionId, request)
          : this.handleDeleteSessionTitle(hostSessionId)
      }

      const runtimeSeatRoute = matchRuntimeSeatRoute(request.method, pathname)
      if (runtimeSeatRoute) {
        // NOTE: `await` is load-bearing here. A bare `return` of the handler
        // promise would adopt its rejection outside this try/catch, escaping
        // `errorResponse` and crashing the connection (T-08606).
        return await this.handleRuntimeSeat(runtimeSeatRoute.runtimeId)
      }

      if (request.method === 'GET' && pathname.startsWith('/v1/active-run-contributions/')) {
        const inputApplicationId = decodeURIComponent(
          pathname.slice('/v1/active-run-contributions/'.length)
        )
        return this.handleGetActiveRunContribution(inputApplicationId)
      }

      // T-08566 stage 1: launch-wrapper lifecycle callbacks are retired.
      if (matchLaunchSubroute(request.method, pathname)) {
        return legacyLaunchIngestRetired(pathname)
      }

      return new Response('Not Found', { status: 404 })
    } catch (error) {
      return errorResponse(error, request)
    }
  },
}

export type ServerRequestMethods = typeof serverRequestMethods
