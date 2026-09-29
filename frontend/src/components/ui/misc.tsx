import { cva, type VariantProps } from 'class-variance-authority'
import { Checkbox as CheckboxPrimitive } from 'radix-ui'
import { CheckIcon, CircleAlertIcon, LoaderCircleIcon } from 'lucide-react'
import type { ComponentProps, ReactNode } from 'react'
import { cn } from '@/lib/utils'

const badgeVariants = cva('inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium', {
  variants: {
    variant: {
      default: 'border-transparent bg-primary text-primary-foreground',
      secondary: 'border-transparent bg-secondary text-secondary-foreground',
      outline: 'text-foreground',
      destructive: 'border-transparent bg-destructive/10 text-destructive',
    },
  },
  defaultVariants: { variant: 'secondary' },
})

export function Badge({ className, variant, ...props }: ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />
}

export function Checkbox({ className, ...props }: ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      className={cn(
        'peer size-4 shrink-0 rounded-[4px] border border-input shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground',
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator className="flex items-center justify-center">
        <CheckIcon className="size-3.5" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  )
}

export function ErrorNote({ children, className }: { children: ReactNode; className?: string }) {
  if (!children) return null
  return (
    <div role="alert" className={cn('flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive', className)}>
      <CircleAlertIcon className="mt-0.5 size-4 shrink-0" />
      <div>{children}</div>
    </div>
  )
}

export function Notice({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('rounded-md border bg-muted/50 px-3 py-2 text-sm', className)}>{children}</div>
}

export function Spinner({ className }: { className?: string }) {
  return <LoaderCircleIcon className={cn('size-4 animate-spin text-muted-foreground', className)} />
}

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4 border-b px-8 py-6">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold">{title}</h1>
        {description && <p className="max-w-2xl text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions}
    </div>
  )
}
