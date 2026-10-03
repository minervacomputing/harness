import { Tabs as TabsPrimitive, ToggleGroup as ToggleGroupPrimitive } from 'radix-ui'
import type { ComponentProps, ReactNode } from 'react'
import { cn } from '@/lib/utils'

export const Tabs = TabsPrimitive.Root

export function TabsList({ className, ...props }: ComponentProps<typeof TabsPrimitive.List>) {
  return <TabsPrimitive.List className={cn('flex gap-0.5 border-b', className)} {...props} />
}

export function TabsTrigger({ className, ...props }: ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        '-mb-px border-b-2 border-transparent px-3 py-2 font-mono text-xs tracking-[0.1em] text-muted-foreground uppercase outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/25 data-[state=active]:border-foreground data-[state=active]:text-foreground',
        className,
      )}
      {...props}
    />
  )
}

export function TabsContent({ className, ...props }: ComponentProps<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content className={cn('pt-4 outline-none', className)} {...props} />
}

/** A compact switch between two to four views, such as Light and Dark. */
export function Segmented({ value, onValueChange, className, children, ...props }: {
  value: string
  onValueChange: (value: string) => void
  className?: string
  children: ReactNode
  'aria-label'?: string
}) {
  return (
    <ToggleGroupPrimitive.Root
      type="single"
      value={value}
      onValueChange={next => { if (next) onValueChange(next) }}
      className={cn('inline-flex gap-0.5 border bg-secondary p-0.5 shadow-(--inset-track)', className)}
      {...props}
    >
      {children}
    </ToggleGroupPrimitive.Root>
  )
}

export function SegmentedItem({ className, ...props }: ComponentProps<typeof ToggleGroupPrimitive.Item>) {
  return (
    <ToggleGroupPrimitive.Item
      className={cn(
        'inline-flex items-center justify-center gap-1.5 px-2.5 py-1 font-mono text-xs tracking-[0.1em] text-muted-foreground uppercase outline-none focus-visible:ring-[3px] focus-visible:ring-ring/25 transition-[color,background-color,box-shadow] data-[state=on]:bg-card data-[state=on]:text-foreground data-[state=on]:shadow-(--raise-surface) data-[state=on]:ring-1 data-[state=on]:ring-border [&_svg]:size-3.5',
        className,
      )}
      {...props}
    />
  )
}
