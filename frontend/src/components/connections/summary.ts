/** What a connection is ready for, in words: shared by the connections page, agents and the sidebar. */
import type { AllowedOut, ConnectionOut } from '@/api/types.gen'
import type { StatusTone } from '@/components/ui/misc'
import { ACCOUNT } from './access-editor'

export type Setup = { tone: StatusTone; label: string; attention: boolean }

/** Whether a connection works, and whether the user still has something to do before agents can use it. */
export function setupOf(connection: ConnectionOut): Setup {
  if (connection.status === 'error') return { tone: 'warning', label: 'Needs reconnecting', attention: true }
  if (connection.status === 'revoked') return { tone: 'danger', label: 'Revoked', attention: true }
  if (connection.consent_needed.length > 0) return { tone: 'warning', label: 'Needs permission', attention: true }
  if (connection.allowed.length === 0) return { tone: 'neutral', label: 'Not set up', attention: true }
  return { tone: 'success', label: 'Active', attention: false }
}

/** "Read files and create files in My Drive · Read mail in all labels", from what the user allows. */
export function summarize(allowed: AllowedOut[]) {
  if (allowed.length === 0) return 'Nothing allowed yet, so agents cannot use it.'
  const scope = (a: AllowedOut) => {
    if (a.kind === ACCOUNT) return ''
    if (a.all) return ` in all ${a.kind_label.toLowerCase()}s`
    const more = a.count - a.names.length
    return ` in ${a.names.join(', ')}${more > 0 ? ` and ${more} more` : ''}`
  }
  const groups: { labels: string[]; scope: string }[] = []
  for (const a of allowed) {
    const last = groups.at(-1)
    if (last && last.scope === scope(a)) last.labels.push(a.action_label.toLowerCase())
    else groups.push({ labels: [a.action_label], scope: scope(a) })
  }
  return groups.map(g => `${g.labels.join(', ').replace(/, ([^,]*)$/, ' and $1')}${g.scope}`).join(' · ')
}
