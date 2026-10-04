/** One ruled row of the account settings list: what it is on the left, its control on the right, details below. */
import type { ReactNode } from 'react'

export function SettingsList({ children }: { children: ReactNode }) {
  return <div className="divide-y divide-border border border-border-strong bg-card">{children}</div>
}

export function Setting({ title, description, action, children }: {
  title: string
  description?: ReactNode
  action?: ReactNode
  children?: ReactNode
}) {
  return (
    <section className="px-4 py-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 space-y-0.5">
          <h2 className="text-sm font-medium">{title}</h2>
          {description && <div className="text-[13px] text-muted-foreground">{description}</div>}
        </div>
        {action && <div className="flex shrink-0 flex-wrap items-center gap-3">{action}</div>}
      </div>
      <div className="mt-4 empty:hidden">{children}</div>
    </section>
  )
}
