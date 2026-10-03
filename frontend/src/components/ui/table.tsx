import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

/** Ruled tables: a strong rule under the head, hairlines between rows, no zebra stripes. */
export function Table({ className, ...props }: ComponentProps<'table'>) {
  return (
    <div className="w-full overflow-x-auto">
      <table className={cn('w-full border-collapse text-[13px]', className)} {...props} />
    </div>
  )
}

export function TableHeader(props: ComponentProps<'thead'>) {
  return <thead {...props} />
}

export function TableBody({ className, ...props }: ComponentProps<'tbody'>) {
  return <tbody className={cn('[&_tr:last-child_td]:border-b-0', className)} {...props} />
}

export function TableRow({ className, ...props }: ComponentProps<'tr'>) {
  return <tr className={cn('hover:[&>td]:bg-secondary/60', className)} {...props} />
}

export function TableHead({ className, ...props }: ComponentProps<'th'>) {
  return <th className={cn('border-b border-border-strong px-3 py-[7px] text-left font-semibold whitespace-nowrap text-foreground', className)} {...props} />
}

export function TableCell({ className, ...props }: ComponentProps<'td'>) {
  return <td className={cn('border-b px-3 py-1.5 align-middle', className)} {...props} />
}
