import { ChevronDownIcon } from 'lucide-react'
import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

const field = 'w-full min-w-0 border border-input bg-card text-sm text-foreground shadow-(--inset-well) transition-[border-color,box-shadow] outline-none placeholder:text-faint focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/25 disabled:cursor-not-allowed disabled:opacity-45 aria-invalid:border-destructive'

export function Input({ className, type, ...props }: ComponentProps<'input'>) {
  return <input type={type} className={cn(field, 'flex h-9 px-3 py-1', className)} {...props} />
}

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return <textarea className={cn(field, 'flex min-h-20 px-3 py-2', className)} {...props} />
}

/** A native select drawn like an input. Native keeps keyboard and mobile behaviour for free. */
export function Select({ className, children, ...props }: ComponentProps<'select'>) {
  return (
    <span className={cn('relative inline-flex', className)}>
      <select className={cn(field, 'h-9 appearance-none pr-8 pl-3')} {...props}>{children}</select>
      <ChevronDownIcon className="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
    </span>
  )
}

export function Label({ className, ...props }: ComponentProps<'label'>) {
  return <label className={cn('text-[13px] font-medium leading-none select-none', className)} {...props} />
}
