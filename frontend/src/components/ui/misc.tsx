import { cva, type VariantProps } from 'class-variance-authority'
import { Checkbox as CheckboxPrimitive, RadioGroup as RadioGroupPrimitive, Switch as SwitchPrimitive } from 'radix-ui'
import { CheckIcon, CircleAlertIcon, InfoIcon, LoaderCircleIcon, TriangleAlertIcon } from 'lucide-react'
import type { ComponentProps, ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { useDocumentTitle } from '@/lib/title'

/** A small square tag for names and counts. Use Status for state. */
const badgeVariants = cva('inline-flex h-5 items-center gap-1 border px-1.5 font-mono text-[11.5px] whitespace-nowrap', {
  variants: {
    variant: {
      default: 'border-primary bg-primary text-primary-foreground',
      secondary: 'border-transparent bg-secondary text-secondary-foreground',
      outline: 'border-border-strong text-muted-foreground',
      destructive: 'border-destructive/50 text-destructive',
    },
  },
  defaultVariants: { variant: 'outline' },
})

export function Badge({ className, variant, ...props }: ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />
}

const STATUS_DOT = {
  neutral: 'bg-faint',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-destructive',
  info: 'bg-info',
} as const

export type StatusTone = keyof typeof STATUS_DOT

/** State as a dot and a word. Never colour a whole row or add a side stripe. */
export function Status({ tone = 'neutral', live = false, className, children }: {
  tone?: StatusTone
  live?: boolean
  className?: string
  children: ReactNode
}) {
  return (
    <span className={cn('inline-flex h-5 items-center gap-[7px] text-[13px] whitespace-nowrap text-foreground', className)}>
      <span
        aria-hidden
        className={cn('size-2 shrink-0 rounded-full ring-1 ring-foreground/70', STATUS_DOT[tone], live && 'animate-pulse')}
      />
      {children}
    </span>
  )
}

const ALERT_TONE = {
  info: { box: 'border-info/35 bg-info/7', icon: 'text-info', Icon: InfoIcon },
  warning: { box: 'border-warning/40 bg-warning/8', icon: 'text-warning', Icon: TriangleAlertIcon },
  danger: { box: 'border-destructive/35 bg-destructive/7', icon: 'text-destructive', Icon: CircleAlertIcon },
} as const

/** A boxed message. Tone shows in the icon and a tinted border; the text stays full contrast. */
export function Alert({ tone = 'info', className, children, ...props }: ComponentProps<'div'> & { tone?: keyof typeof ALERT_TONE }) {
  const { box, icon, Icon } = ALERT_TONE[tone]
  return (
    <div className={cn('flex items-start gap-2.5 border px-3 py-2.5 text-[13px] text-foreground', box, className)} {...props}>
      <Icon className={cn('mt-0.5 size-4 shrink-0', icon)} />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

export function ErrorNote({ children, className }: { children: ReactNode; className?: string }) {
  if (!children) return null
  return <Alert tone="danger" role="alert" className={className}>{children}</Alert>
}

export function Notice({ children, className }: { children: ReactNode; className?: string }) {
  return <Alert tone="info" className={className}>{children}</Alert>
}

export function Checkbox({ className, ...props }: ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      className={cn(
        'peer grid size-4 shrink-0 place-items-center border border-input bg-card shadow-(--inset-well) outline-none focus-visible:ring-[3px] focus-visible:ring-ring/25 disabled:cursor-not-allowed disabled:opacity-45 data-[state=checked]:border-info data-[state=checked]:bg-info data-[state=checked]:text-info-foreground data-[state=checked]:shadow-none',
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator>
        <CheckIcon className="size-3" strokeWidth={3} />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  )
}

export function Switch({ className, ...props }: ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        'peer inline-flex h-5 w-9 shrink-0 items-center bg-border-strong p-[3px] shadow-(--inset-track) outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/25 disabled:cursor-not-allowed disabled:opacity-45 data-[state=checked]:bg-info',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="block size-3.5 bg-white shadow-(--raise-knob) transition-transform data-[state=checked]:translate-x-4" />
    </SwitchPrimitive.Root>
  )
}

export function RadioGroup({ className, ...props }: ComponentProps<typeof RadioGroupPrimitive.Root>) {
  return <RadioGroupPrimitive.Root className={cn('grid gap-2', className)} {...props} />
}

export function RadioItem({ className, ...props }: ComponentProps<typeof RadioGroupPrimitive.Item>) {
  return (
    <RadioGroupPrimitive.Item
      className={cn(
        'grid size-4 shrink-0 place-items-center rounded-full border border-input bg-card shadow-(--inset-well) outline-none focus-visible:ring-[3px] focus-visible:ring-ring/25 disabled:opacity-45',
        className,
      )}
      {...props}
    >
      <RadioGroupPrimitive.Indicator className="size-2 rounded-full bg-info" />
    </RadioGroupPrimitive.Item>
  )
}

export function Kbd({ className, ...props }: ComponentProps<'kbd'>) {
  return (
    <kbd
      className={cn('inline-flex h-5 items-center border border-b-2 border-border-strong bg-card px-1.5 shadow-(--raise-surface) font-mono text-[11px] text-muted-foreground', className)}
      {...props}
    />
  )
}

export function Progress({ value, className }: { value: number; className?: string }) {
  return (
    <div role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={100} className={cn('h-1.5 border bg-secondary', className)}>
      <div className="h-full bg-info transition-[width]" style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
    </div>
  )
}

export function Spinner({ className }: { className?: string }) {
  return <LoaderCircleIcon className={cn('size-4 animate-spin text-muted-foreground', className)} />
}

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  useDocumentTitle(title)
  return (
    <div className="flex flex-wrap items-start justify-between gap-4 border-b px-4 py-6 md:px-8">
      <div className="space-y-1.5">
        <h1 className="text-2xl font-medium tracking-[-0.015em]">{title}</h1>
        {description && <p className="max-w-2xl text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions}
    </div>
  )
}
