import { cn } from '@/lib/utils'
import { LOCKUP_WIDTH, MARK_RULED, MARK_SOLID, NAME_IN_LOCKUP, OWL, OWL_VIEWBOX } from './logo-paths'

/** The mark form for a rendered height: ruled from 40px, solid from 20px, the owl alone below. */
function markFor(size: number) {
  if (size >= 40) return { d: MARK_RULED, viewBox: '0 0 100 100' }
  if (size > 16) return { d: MARK_SOLID, viewBox: '0 0 100 100' }
  return { d: OWL, viewBox: OWL_VIEWBOX }
}

/** The owl mark. Colour follows `currentColor`; the default is the logo token. */
export function LogoMark({ size = 32, className, title = 'Minerva' }: { size?: number; className?: string; title?: string }) {
  const { d, viewBox } = markFor(size)
  return (
    <svg viewBox={viewBox} width={size} height={size} role="img" aria-label={title} className={cn('shrink-0 text-logo', className)}>
      <path d={d} fill="currentColor" />
    </svg>
  )
}

/** Mark and wordmark. `height` is the mark's height; the width follows. */
export function Logo({ height = 32, className, title = 'Minerva' }: { height?: number; className?: string; title?: string }) {
  const mark = height >= 40 ? MARK_RULED : MARK_SOLID
  return (
    <svg
      viewBox={`0 0 ${LOCKUP_WIDTH} 100`}
      height={height}
      width={(height * LOCKUP_WIDTH) / 100}
      role="img"
      aria-label={title}
      className={cn('shrink-0 text-logo', className)}
    >
      <path d={mark} fill="currentColor" />
      <path d={NAME_IN_LOCKUP} fill="currentColor" />
    </svg>
  )
}
