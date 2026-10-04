import { cn } from '@/lib/utils'
import { LOCKUP_WIDTH, NAME_IN_LOCKUP, OWL, OWL_VIEWBOX } from './logo-paths'

/** The owl mark, centred in a square. Colour follows `currentColor`; the default is the logo token. */
export function LogoMark({ size = 32, className, title = 'Minerva' }: { size?: number; className?: string; title?: string }) {
  return (
    <svg viewBox={OWL_VIEWBOX} width={size} height={size} role="img" aria-label={title} className={cn('shrink-0 text-logo', className)}>
      <path d={OWL} fill="currentColor" />
    </svg>
  )
}

/** Owl and wordmark. `height` is the owl's height; the width follows. */
export function Logo({ height = 32, className, title = 'Minerva' }: { height?: number; className?: string; title?: string }) {
  return (
    <svg
      viewBox={`0 0 ${LOCKUP_WIDTH} 100`}
      height={height}
      width={(height * LOCKUP_WIDTH) / 100}
      role="img"
      aria-label={title}
      className={cn('shrink-0 text-logo', className)}
    >
      <path d={OWL} fill="currentColor" />
      <path d={NAME_IN_LOCKUP} fill="currentColor" />
    </svg>
  )
}
