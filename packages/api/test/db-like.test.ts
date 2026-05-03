/**
 * `escapeLikePattern` unit tests — locks the contract that user-supplied
 * search strings can't accidentally turn into SQL wildcards.
 */

import { describe, it, expect } from 'vitest';
import { escapeLikePattern } from '../src/db/like.js';

describe('escapeLikePattern', () => {
  it('passes plain text through unchanged', () => {
    expect(escapeLikePattern('hello world')).toBe('hello world');
  });

  it('escapes percent (LIKE "any sequence") so user-typed % matches literally', () => {
    expect(escapeLikePattern('100%')).toBe('100\\%');
  });

  it('escapes underscore (LIKE "any single char") so foo_bar matches literally', () => {
    expect(escapeLikePattern('foo_bar')).toBe('foo\\_bar');
  });

  it('escapes backslash first so we do not double-escape our own escape sequences', () => {
    expect(escapeLikePattern('path\\to')).toBe('path\\\\to');
  });

  it('escapes a mix in one pass', () => {
    expect(escapeLikePattern('a%b_c\\d')).toBe('a\\%b\\_c\\\\d');
  });

  it('handles empty string', () => {
    expect(escapeLikePattern('')).toBe('');
  });
});
