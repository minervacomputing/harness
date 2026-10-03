import { cva, type VariantProps } from 'class-variance-authority'
import { Slot } from 'radix-ui'
import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

// Label and icon are the only flex children, so the content stays centred. Never add pseudo-elements here.
const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-[7px] whitespace-nowrap border text-[13px] font-medium transition-[color,background-color,border-color,box-shadow] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/25 disabled:pointer-events-none disabled:opacity-45 disabled:shadow-none [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: 'border-primary bg-primary bg-(image:--sheen) text-primary-foreground shadow-(--raise-solid) hover:bg-primary/88 active:bg-none active:shadow-(--press-solid)',
        destructive: 'border-destructive bg-destructive bg-(image:--sheen) text-destructive-foreground shadow-(--raise-solid) hover:bg-destructive/88 active:bg-none active:shadow-(--press-solid)',
        outline: 'border-border-strong bg-card text-foreground shadow-(--raise-surface) hover:bg-secondary active:shadow-(--press-surface)',
        secondary: 'border-transparent bg-secondary text-secondary-foreground shadow-(--raise-surface) hover:bg-secondary/70 active:shadow-(--press-surface)',
        ghost: 'border-transparent hover:bg-accent hover:text-accent-foreground',
        'ghost-destructive': 'border-transparent text-destructive hover:bg-destructive/8',
        link: 'border-0 text-info underline underline-offset-[3px] hover:decoration-2',
      },
      size: {
        default: 'h-[34px] px-3.5',
        sm: 'h-7 px-2.5 text-xs',
        lg: 'h-10 px-5 text-sm',
        icon: 'size-[34px]',
        'icon-sm': 'size-7',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
)

export function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: ComponentProps<'button'> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : 'button'
  return <Comp className={cn(buttonVariants({ variant, size: variant === 'link' ? null : size, className }))} {...props} />
}
