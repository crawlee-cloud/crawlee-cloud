/**
 * Tests for the cn() classname combiner (clsx + tailwind-merge).
 */
import { describe, it, expect } from 'vitest';
import { cn } from '@/lib/utils';

describe('cn', () => {
  it('joins plain class strings', () => {
    expect(cn('a', 'b')).toBe('a b');
  });

  it('honors conditional clsx shapes', () => {
    expect(cn('base', { active: true, hidden: false }, ['extra'])).toBe('base active extra');
  });

  it('lets later Tailwind utilities win conflicts', () => {
    expect(cn('p-2', 'p-4')).toBe('p-4');
    expect(cn('text-red-500', 'text-blue-500')).toBe('text-blue-500');
  });

  it('ignores null/undefined inputs', () => {
    expect(cn(undefined, null, 'kept')).toBe('kept');
  });
});
