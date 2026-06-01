'use client';

import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useToast } from '@/components/ui/toast';

/**
 * Copy-to-clipboard button. Two display modes:
 *   - icon-only ("inline"): tiny square button, designed to sit next to a
 *     value (e.g., copy an ID listed in a table row). The success state
 *     flashes a checkmark in place for ~1.2s — quieter than a toast for
 *     high-frequency use.
 *   - labeled ("button"): standard button chrome with "copy" text, used
 *     when the affordance needs to be discoverable (e.g., copy whole JSON).
 *
 * Both modes also fire a toast on success so screen-reader users get
 * confirmation; the inline checkmark is purely visual reinforcement.
 *
 * Falls back gracefully when navigator.clipboard is unavailable (insecure
 * context, older Safari): toasts an error rather than silently failing.
 */
export function CopyButton({
  value,
  label,
  variant = 'inline',
  title,
  className,
}: {
  /** Text to copy to the clipboard. Empty / whitespace-only values disable the button. */
  value: string;
  /** Used in the success toast ("Run ID copied"). Falls back to "Value copied". */
  label?: string;
  variant?: 'inline' | 'button';
  /** Tooltip override. Default: "Copy {label}" / "Copy". */
  title?: string;
  className?: string;
}) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  const disabled = !value || !value.trim();

  async function handleClick(e: React.MouseEvent) {
    // Stop both bubbling and the browser's default. Critical when this
    // button is nested inside a Next.js <Link> (e.g., row that's a card
    // navigation target) — without these, clicking copy would *also*
    // navigate to the link target. No-op outside Link contexts because
    // type="button" has no default action and nothing is listening above.
    e.stopPropagation();
    e.preventDefault();
    if (disabled) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      // 1.2s matches the typical toast linger — the two visual signals
      // appear and clear together, which feels less noisy than staggered.
      window.setTimeout(() => setCopied(false), 1200);
      toast.success(`${label ?? 'Value'} copied`);
    } catch {
      // navigator.clipboard requires a secure context (https or localhost).
      // On http origins the call throws — toast tells the user honestly
      // instead of leaving the button broken-looking.
      toast.error('Copy failed', { description: 'Clipboard API unavailable' });
    }
  }

  const Icon = copied ? Check : Copy;
  const titleText = title ?? `Copy${label ? ` ${label.toLowerCase()}` : ''}`;

  if (variant === 'button') {
    return (
      <button
        type="button"
        onClick={(e) => void handleClick(e)}
        disabled={disabled}
        title={titleText}
        className={cn(
          'h-7 px-2 inline-flex items-center gap-1.5 text-[11px] font-mono uppercase tracking-wider border rounded-sm transition-colors disabled:opacity-50',
          copied
            ? 'border-signal/40 text-signal'
            : 'border-border text-muted-foreground hover:text-foreground hover:border-signal/40',
          className
        )}
      >
        <Icon className="h-3 w-3" />
        {copied ? 'copied' : 'copy'}
      </button>
    );
  }

  // Inline mode: square icon button, designed for end-of-row placement.
  return (
    <button
      type="button"
      onClick={(e) => void handleClick(e)}
      disabled={disabled}
      title={titleText}
      className={cn(
        'inline-flex items-center justify-center h-5 w-5 shrink-0 rounded-sm transition-colors disabled:opacity-30',
        copied
          ? 'text-signal'
          : 'text-muted-foreground/60 hover:text-foreground hover:bg-secondary/60',
        className
      )}
    >
      <Icon className="h-3 w-3" />
    </button>
  );
}
