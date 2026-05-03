'use client';

import { useEffect, useMemo, useState } from 'react';
import { CalendarClock, Clock, Loader2, Plus, Save, Trash2 } from 'lucide-react';
import { AppLink } from '@/components/app-link';
import { Pagination } from '@/components/pagination';
import { useConfirm } from '@/components/ui/confirm';
import { useToast } from '@/components/ui/toast';
import {
  createSchedule,
  deleteSchedule,
  getActors,
  getSchedules,
  updateSchedule,
  type Actor,
  type Schedule,
} from '@/lib/api';
import { FETCH_ALL_LIMIT, PAGE_SIZE } from '@/lib/constants';
import { usePageParam } from '@/lib/use-page-param';
import { cn } from '@/lib/utils';

const COMMON_CRONS: { label: string; value: string; hint: string }[] = [
  { label: 'Every hour', value: '0 * * * *', hint: 'top of every hour' },
  { label: 'Every 6 hours', value: '0 */6 * * *', hint: '4× per day' },
  { label: 'Daily · 3am UTC', value: '0 3 * * *', hint: 'overnight refresh' },
  { label: 'Weekdays · 9am UTC', value: '0 9 * * 1-5', hint: 'Mon–Fri' },
  { label: 'Mondays · 8am UTC', value: '0 8 * * 1', hint: 'weekly' },
  { label: 'Custom', value: '', hint: 'enter your own' },
];

export default function SchedulesPage() {
  const confirm = useConfirm();
  const toast = useToast();
  const { offset, setOffset } = usePageParam();
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [total, setTotal] = useState(0);
  const [actors, setActors] = useState<Actor[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);

  useEffect(() => {
    let alive = true;
    void Promise.all([
      getSchedules({ offset, limit: PAGE_SIZE }).catch(() => null),
      getActors({ limit: FETCH_ALL_LIMIT }).catch(() => null),
    ]).then(([s, a]) => {
      if (!alive) return;
      if (s) {
        setSchedules(s.items);
        setTotal(s.total);
      }
      if (a) setActors(a.items);
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [offset]);

  async function handleToggle(s: Schedule) {
    try {
      const updated = await updateSchedule(s.id, { isEnabled: !s.isEnabled });
      setSchedules((prev) => prev.map((x) => (x.id === s.id ? updated : x)));
      toast.success(updated.isEnabled ? 'Schedule enabled' : 'Schedule paused');
    } catch (err) {
      toast.error('Failed to update schedule', { description: (err as Error).message });
    }
  }

  async function handleDelete(s: Schedule) {
    const ok = await confirm({
      tone: 'danger',
      title: `Delete "${s.name}"?`,
      description: 'The cron job is removed. Existing runs from this schedule are not affected.',
      confirmLabel: 'delete schedule',
    });
    if (!ok) return;
    try {
      await deleteSchedule(s.id);
      setSchedules((prev) => prev.filter((x) => x.id !== s.id));
      toast.success('Schedule deleted');
    } catch (err) {
      toast.error('Failed to delete schedule', { description: (err as Error).message });
    }
  }

  const actorById = useMemo(() => new Map(actors.map((a) => [a.id, a])), [actors]);

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-6 pb-4 border-b border-border">
        <div>
          <p className="eyebrow mb-2">RUN · SCHEDULES</p>
          <h1 className="text-[28px] leading-none font-medium tracking-tight">Schedules</h1>
          <p className="text-muted-foreground mt-2 text-[13px]">
            Cron-driven actor runs. Times are interpreted in the schedule&apos;s timezone.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowForm((v) => !v)}
          disabled={actors.length === 0}
          className="h-8 px-3 inline-flex items-center gap-1.5 text-[12px] font-mono uppercase tracking-wider bg-signal text-background hover:brightness-110 rounded-sm disabled:opacity-50"
        >
          <Plus className="h-3.5 w-3.5" /> new schedule
        </button>
      </div>

      {showForm && (
        <CreateScheduleForm
          actors={actors}
          onCreated={(s) => {
            setSchedules((prev) => [s, ...prev]);
            setShowForm(false);
            toast.success('Schedule created', { description: s.cronExpression });
          }}
          onCancel={() => setShowForm(false)}
        />
      )}

      {loading ? (
        <div className="grid place-items-center py-24">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : actors.length === 0 ? (
        <div className="panel grid-bg p-16 text-center">
          <CalendarClock className="h-6 w-6 text-muted-foreground/40 mx-auto mb-3" />
          <p className="font-mono text-[11px] tracking-wider text-muted-foreground">
            [ NO ACTORS YET ]
          </p>
          <p className="text-[13px] text-muted-foreground mt-2">
            Create an actor first — schedules need something to run.
          </p>
        </div>
      ) : schedules.length === 0 ? (
        <div className="panel grid-bg p-16 text-center">
          <CalendarClock className="h-6 w-6 text-muted-foreground/40 mx-auto mb-3" />
          <p className="font-mono text-[11px] tracking-wider text-muted-foreground">
            [ NO SCHEDULES ]
          </p>
          <p className="text-[13px] text-muted-foreground mt-2">
            Set up a cron schedule to run an actor on a recurring basis.
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {schedules.map((s) => {
            const actor = actorById.get(s.actorId);
            return (
              <li key={s.id} className="panel p-4 flex items-start gap-4">
                <button
                  type="button"
                  onClick={() => void handleToggle(s)}
                  title={s.isEnabled ? 'Pause' : 'Resume'}
                  className={cn(
                    'mt-1 shrink-0 font-mono text-[10px] tracking-widest px-1.5 py-0.5 rounded-sm border transition-colors',
                    s.isEnabled
                      ? 'text-signal border-signal/40 hover:bg-signal/10'
                      : 'text-muted-foreground border-border hover:text-foreground'
                  )}
                >
                  {s.isEnabled ? '[LIVE]' : '[PAUSED]'}
                </button>

                <div className="flex-1 min-w-0">
                  <p className="text-[13px] text-foreground truncate">{s.name}</p>
                  <div className="flex flex-wrap items-center gap-3 mt-1.5">
                    <span className="font-mono text-[11px] text-foreground bg-secondary border border-border px-1.5 py-0.5 rounded-sm">
                      {s.cronExpression}
                    </span>
                    <span className="font-mono text-[10px] text-muted-foreground tracking-wider">
                      tz · {s.timezone}
                    </span>
                    {actor ? (
                      <AppLink
                        href={`/actors/${actor.name}`}
                        className="font-mono text-[10px] text-muted-foreground hover:text-foreground tracking-wider"
                      >
                        actor · {actor.name}
                      </AppLink>
                    ) : (
                      <span className="font-mono text-[10px] text-muted-foreground/60 italic">
                        actor · deleted
                      </span>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-3 mt-2 font-mono text-[10px] text-muted-foreground tracking-wider">
                    <span className="flex items-center gap-1">
                      <Clock className="h-2.5 w-2.5" /> last ·{' '}
                      {s.lastRunAt ? timeAgo(s.lastRunAt) : '—'}
                    </span>
                    <span className="flex items-center gap-1">
                      <Clock className="h-2.5 w-2.5" /> next ·{' '}
                      {s.nextRunAt ? timeFromNow(s.nextRunAt) : '—'}
                    </span>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => void handleDelete(s)}
                  className="text-muted-foreground hover:text-fail p-1"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <Pagination total={total} offset={offset} limit={PAGE_SIZE} onChange={setOffset} />
    </div>
  );
}

function CreateScheduleForm({
  actors,
  onCreated,
  onCancel,
}: {
  actors: Actor[];
  onCreated: (s: Schedule) => void;
  onCancel: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [actorId, setActorId] = useState(actors[0]?.id ?? '');
  const [preset, setPreset] = useState(COMMON_CRONS[2].value); // Daily 3am
  const [customCron, setCustomCron] = useState('');
  const [timezone, setTimezone] = useState('UTC');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cronExpression = preset === '' ? customCron : preset;

  async function handleCreate() {
    if (!name.trim() || !actorId || !cronExpression) {
      setError('all fields required');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const created = await createSchedule({
        name: name.trim(),
        actorId,
        cronExpression: cronExpression.trim(),
        timezone: timezone.trim() || 'UTC',
      });
      onCreated(created);
    } catch (err) {
      const msg = (err as Error).message;
      setError(msg);
      toast.error('Failed to create schedule', { description: msg });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="panel p-5 space-y-4 bg-secondary/30">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Field label="Name">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Daily refresh"
            className={INPUT}
          />
        </Field>
        <Field label="Actor">
          <select value={actorId} onChange={(e) => setActorId(e.target.value)} className={SELECT}>
            {actors.map((a) => (
              <option key={a.id} value={a.id}>
                {a.title || a.name}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <Field label="Cron · 5-field">
        <div className="grid grid-cols-2 md:grid-cols-3 gap-1.5">
          {COMMON_CRONS.map((p) => {
            const isOn = preset === p.value;
            return (
              <button
                key={p.label}
                type="button"
                onClick={() => setPreset(p.value)}
                className={cn(
                  'text-left px-3 py-2 border rounded-sm transition-colors',
                  isOn ? 'border-signal/50 bg-signal/5' : 'border-border bg-background'
                )}
              >
                <p className="text-[12px] text-foreground leading-tight">{p.label}</p>
                <p className="font-mono text-[10px] text-muted-foreground mt-1">
                  {p.value || p.hint}
                </p>
              </button>
            );
          })}
        </div>
        {preset === '' && (
          <input
            value={customCron}
            onChange={(e) => setCustomCron(e.target.value)}
            placeholder="* * * * *"
            className={cn(INPUT, 'mt-2 font-mono')}
          />
        )}
      </Field>

      <Field label="Timezone · IANA" hint="e.g. UTC, America/New_York, Europe/Paris">
        <input value={timezone} onChange={(e) => setTimezone(e.target.value)} className={INPUT} />
      </Field>

      {error && <p className="font-mono text-[11px] text-fail">[ERR] {error}</p>}

      <div className="flex justify-end gap-2 pt-2 border-t border-border">
        <button
          type="button"
          onClick={onCancel}
          className="h-8 px-3 text-[12px] font-mono uppercase tracking-wider text-muted-foreground hover:text-foreground"
        >
          cancel
        </button>
        <button
          type="button"
          onClick={() => void handleCreate()}
          disabled={submitting}
          className="h-8 px-3 inline-flex items-center gap-1.5 text-[12px] font-mono uppercase tracking-wider bg-signal text-background rounded-sm disabled:opacity-50"
        >
          {submitting ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Save className="h-3.5 w-3.5" />
          )}
          create
        </button>
      </div>
    </section>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label className="block font-mono text-[10px] tracking-widest text-muted-foreground uppercase">
        {label}
      </label>
      {children}
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

const INPUT =
  'w-full h-9 px-3 rounded-sm border border-border bg-input text-[13px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-signal/50';
const SELECT =
  'w-full h-9 px-2 rounded-sm border border-border bg-input text-[13px] text-foreground focus:outline-none focus:border-signal/50';

function timeAgo(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function timeFromNow(iso: string): string {
  const s = Math.floor((new Date(iso).getTime() - Date.now()) / 1000);
  if (s < 0) return 'overdue';
  if (s < 60) return `in ${s}s`;
  if (s < 3600) return `in ${Math.floor(s / 60)}m`;
  if (s < 86400) return `in ${Math.floor(s / 3600)}h`;
  return `in ${Math.floor(s / 86400)}d`;
}
