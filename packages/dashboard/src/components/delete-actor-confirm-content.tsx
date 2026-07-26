'use client';

import React from 'react';

interface DeleteActorConfirmContentProps {
  onForceChange: (force: boolean) => void;
  showUndoneWarning?: boolean;
}

export function DeleteActorConfirmContent({
  onForceChange,
  showUndoneWarning = false,
}: DeleteActorConfirmContentProps) {
  return (
    <>
      <p>
        Deletes this actor, all actor versions, build history, and schedules. Actor-scoped webhooks
        are kept but detached from the actor.
      </p>
      <p className="mt-2">
        Existing runs block deletion by default. Datasets, key-value stores, and request queues
        created by those runs are never deleted.
      </p>
      <label className="flex items-start gap-2 text-[12px] mt-3 cursor-pointer">
        <input
          type="checkbox"
          className="mt-0.5 accent-red-500"
          onChange={(event) => {
            onForceChange(event.currentTarget.checked);
          }}
        />
        <span>
          Force delete: permanently delete the actor&apos;s runs and their webhook deliveries too.
          Active runs must be aborted and fully terminated first.
        </span>
      </label>
      {showUndoneWarning && (
        <span className="text-foreground font-mono">This cannot be undone.</span>
      )}
    </>
  );
}
