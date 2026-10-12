/**
 * Counts the sessions this page has ended. Work that waits before it acts (a send about to be repeated) notes
 * the count when it starts and gives up when the count has changed, so nothing is sent for one user under the
 * session of the next.
 */
let ended = 0

export const sessionsEnded = () => ended

/** Called by sign-out once the server has ended the session. */
export const noteSessionEnded = () => {
  ended++
}
