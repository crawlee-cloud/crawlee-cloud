'use client';

import Link from 'next/link';
import type { ComponentProps } from 'react';
import { prefixPath } from '@/lib/path-prefix';

type AppLinkProps = ComponentProps<typeof Link>;

/**
 * Drop-in replacement for next/link that applies NEXT_PUBLIC_ROUTE_PREFIX
 * to href values. Use this instead of <Link> for all internal navigation
 * when the dashboard may be deployed behind a path-stripping reverse proxy.
 */
export function AppLink({ href, ...props }: AppLinkProps) {
  const prefixed = typeof href === 'string' ? prefixPath(href) : href;
  return <Link href={prefixed} {...props} />;
}
