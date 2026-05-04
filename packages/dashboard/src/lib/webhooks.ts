/*
  Webhook event-type catalog.

  Source of truth: `packages/runner/src/queue.ts` line ~286, which fires
  `ACTOR.RUN.${status}` whenever a run transitions into a terminal state.
  The runner does not currently emit BUILD events; when it does, add them
  to the BUILD group below and the UI will pick them up automatically.
*/

export type WebhookEventGroup = {
  id: string;
  label: string;
  description: string;
  events: WebhookEvent[];
};

export type WebhookEvent = {
  id: string;
  label: string;
  blurb: string;
  /** Whether to highlight as a "common" subscription. */
  common?: boolean;
};

export const WEBHOOK_EVENTS: WebhookEventGroup[] = [
  {
    id: 'run',
    label: 'Run lifecycle',
    description: 'Fired when an actor run transitions into a terminal state.',
    events: [
      {
        id: 'ACTOR.RUN.SUCCEEDED',
        label: 'Run succeeded',
        blurb: 'Run finished cleanly with exit code 0.',
        common: true,
      },
      {
        id: 'ACTOR.RUN.FAILED',
        label: 'Run failed',
        blurb: 'Run exited with a non-zero status or threw uncaught.',
        common: true,
      },
      {
        id: 'ACTOR.RUN.TIMED_OUT',
        label: 'Run timed out',
        blurb: 'Run exceeded its configured timeout and was killed.',
      },
      {
        id: 'ACTOR.RUN.ABORTED',
        label: 'Run aborted',
        blurb: 'Run was aborted by the operator before completion.',
      },
    ],
  },
  // {
  //   id: 'build',
  //   label: 'Build lifecycle',
  //   description: 'Fired when an actor image build finishes.',
  //   events: [
  //     { id: 'ACTOR.BUILD.SUCCEEDED', label: 'Build succeeded', blurb: 'Image built and pushed.' },
  //     { id: 'ACTOR.BUILD.FAILED', label: 'Build failed', blurb: 'Build exited with non-zero status.' },
  //   ],
  // },
];

/** Flat list of every event id, in catalog order. */
export const ALL_EVENT_IDS = WEBHOOK_EVENTS.flatMap((g) => g.events.map((e) => e.id));

/** Look up the human label for a raw event id, with a sensible fallback. */
export function eventLabel(id: string): string {
  for (const g of WEBHOOK_EVENTS) {
    const e = g.events.find((ev) => ev.id === id);
    if (e) return e.label;
  }
  return id;
}
