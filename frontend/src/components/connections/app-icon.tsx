/** An app's mark in a square tile, in the foreground colour so it follows the theme. */
import { CalendarIcon, CloudIcon, GlobeIcon, HashIcon, type LucideIcon, MailIcon, PlugIcon, UsersIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { BRAND_PATHS } from './brand-paths'

// Simple Icons does not carry these brands; a plain glyph stands in.
const GLYPHS: Record<string, LucideIcon> = {
  outlook: MailIcon,
  outlook_calendar: CalendarIcon,
  onedrive: CloudIcon,
  teams: UsersIcon,
  slack: HashIcon,
  web: GlobeIcon,
}

const SIZES = {
  xs: { tile: 'size-5', mark: 'size-3' },
  sm: { tile: 'size-7', mark: 'size-3.5' },
  md: { tile: 'size-9', mark: 'size-[18px]' },
} as const

export function AppIcon({ slug, size = 'md', className }: { slug: string; size?: keyof typeof SIZES; className?: string }) {
  const path = BRAND_PATHS[slug]
  const Glyph = GLYPHS[slug] ?? PlugIcon
  const { tile, mark } = SIZES[size]
  return (
    <span aria-hidden className={cn('grid shrink-0 place-items-center border border-border-strong bg-card text-foreground', tile, className)}>
      {path
        ? <svg viewBox="0 0 24 24" className={mark} fill="currentColor"><path d={path} /></svg>
        : <Glyph className={mark} strokeWidth={1.75} />}
    </span>
  )
}
