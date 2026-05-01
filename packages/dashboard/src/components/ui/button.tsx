import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

/*
  Operator Console button.
  - Flat. No glow shadow. No fill swap that fights the signal accent.
  - All variants resolve through tokens, so they invert correctly between
    light and dark themes.
*/

const buttonVariants = cva(
  'inline-flex items-center justify-center whitespace-nowrap rounded-sm text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default: 'bg-signal text-background hover:brightness-110',
        destructive: 'bg-fail/10 text-fail border border-fail/40 hover:bg-fail/20',
        outline: 'border border-border bg-transparent hover:bg-secondary text-foreground',
        secondary: 'bg-secondary text-foreground hover:bg-secondary/70',
        ghost: 'text-muted-foreground hover:text-foreground hover:bg-secondary',
        link: 'text-foreground underline-offset-4 hover:underline hover:text-signal',
        glass: 'bg-secondary text-foreground border border-border hover:bg-secondary/70',
      },
      size: {
        default: 'h-9 px-3 py-2 text-[13px]',
        sm: 'h-8 px-3 text-[12px]',
        lg: 'h-10 px-5 text-sm',
        icon: 'h-9 w-9',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />
    );
  }
);
Button.displayName = 'Button';

export { Button, buttonVariants };
