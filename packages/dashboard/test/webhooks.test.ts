/**
 * Tests for the webhook event catalog — the dashboard's source of truth
 * for which event types exist and how they're labeled. The event ids
 * must match what the runner actually emits (ACTOR.RUN.<STATUS> with
 * underscores).
 */
import { describe, it, expect } from 'vitest';
import { WEBHOOK_EVENTS, ALL_EVENT_IDS, eventLabel } from '@/lib/webhooks';

describe('WEBHOOK_EVENTS catalog', () => {
  it('contains the four terminal run states the runner emits', () => {
    expect(ALL_EVENT_IDS).toEqual([
      'ACTOR.RUN.SUCCEEDED',
      'ACTOR.RUN.FAILED',
      'ACTOR.RUN.TIMED_OUT',
      'ACTOR.RUN.ABORTED',
    ]);
  });

  it('uses underscores (not hyphens) in event ids — the Apify wire form', () => {
    for (const id of ALL_EVENT_IDS) {
      expect(id).not.toContain('-');
      expect(id).toMatch(/^ACTOR\.RUN\.[A-Z_]+$/);
    }
  });

  it('gives every event a label and blurb for the picker UI', () => {
    for (const group of WEBHOOK_EVENTS) {
      expect(group.label).toBeTruthy();
      expect(group.description).toBeTruthy();
      for (const event of group.events) {
        expect(event.label).toBeTruthy();
        expect(event.blurb).toBeTruthy();
      }
    }
  });

  it('marks the common subscriptions', () => {
    const common = WEBHOOK_EVENTS.flatMap((g) => g.events)
      .filter((e) => e.common)
      .map((e) => e.id);
    expect(common).toEqual(['ACTOR.RUN.SUCCEEDED', 'ACTOR.RUN.FAILED']);
  });
});

describe('eventLabel', () => {
  it('resolves known ids to their labels', () => {
    expect(eventLabel('ACTOR.RUN.SUCCEEDED')).toBe('Run succeeded');
    expect(eventLabel('ACTOR.RUN.TIMED_OUT')).toBe('Run timed out');
  });

  it('falls back to the raw id for unknown events', () => {
    expect(eventLabel('ACTOR.BUILD.SUCCEEDED')).toBe('ACTOR.BUILD.SUCCEEDED');
  });
});
