/** The client of the API contract (contract/) and its TanStack Query utilities. A 401 is reported to the app (lib/http.ts). */
import { contract } from '@minerva/contract'
import { createORPCClient } from '@orpc/client'
import type { ContractRouterClient } from '@orpc/contract'
import type { JsonifiedClient } from '@orpc/openapi-client'
import { OpenAPILink } from '@orpc/openapi-client/fetch'
import { createTanstackQueryUtils } from '@orpc/tanstack-query'
import { NetworkError, noteAnswer } from '@/lib/http'

/**
 * What a call may ask of its request: `keepalive` lets it finish after the page is gone (a delete as the page closes); `signedOutIsAnswer`
 * is for asking who is signed in (lib/auth.ts), whose 401 is the answer, not news that the session ended.
 */
type CallContext = { keepalive?: boolean; signedOutIsAnswer?: boolean }

/** The client of a Minerva instance's API, at its origin. */
function apiClient(instanceUrl: string): JsonifiedClient<ContractRouterClient<typeof contract, CallContext>> {
  const link = new OpenAPILink<CallContext>(contract, {
    url: `${instanceUrl}/api`,
    fetch: async (request, init, { context }) => {
      let response: Response
      let body: ArrayBuffer | null
      try {
        response = await fetch(request, { ...init, credentials: 'same-origin', ...(context.keepalive && { keepalive: true }) })
        // oRPC asks fetch not to follow redirects, which the API never sends: one comes from something in front of it (a sign-in proxy).
        if (response.type === 'opaqueredirect') throw new TypeError('Redirected')
        if (!context.signedOutIsAnswer) noteAnswer(response)
        // The whole answer is read here, so one cut short is fetch's failure (a success, a streamed read included, did not arrive) or,
        // for an error answer, keeps its status (below).
        body = await response.arrayBuffer().catch((error: unknown) => {
          if (response.ok || request.signal.aborted) throw error
          return null
        })
      } catch (error) {
        if (request.signal.aborted) throw error
        throw new NetworkError({ cause: error })
      }
      return response.ok ? new Response(body?.byteLength ? body : null, response) : keepStatus(response, body)
    },
  })
  return createORPCClient(link)
}

/**
 * An error answer whose body cannot be read as JSON (cut short, or labelled JSON by a proxy when it is not) comes out of the link as a parse
 * error without its status; it is passed on without a body instead, which the link reads as an undeclared error with the status.
 */
function keepStatus(response: Response, body: ArrayBuffer | null): Response {
  try {
    const text = new TextDecoder().decode(body ?? new ArrayBuffer(0))
    JSON.parse(text)
    return new Response(text, response)
  } catch {
    return new Response(null, { status: response.status, statusText: response.statusText })
  }
}

/** The API of the instance that served this page. */
export const orpc = createTanstackQueryUtils(apiClient(window.location.origin))
