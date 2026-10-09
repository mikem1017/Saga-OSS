import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Bot, CheckCircle2, CircleAlert, Loader2 } from 'lucide-react';
import { get } from '../api.ts';
import { relTime } from '../format.ts';

interface AgentTask {
  id: string;
  state: 'queued' | 'waiting' | 'running' | 'done' | 'failed' | 'refused';
  created?: number;
  started?: number;
  ended?: number;
  summary?: string | null;
  note?: string;
  progress?: string[];
}

const ACTIVE = new Set(['queued', 'waiting', 'running']);
const LABEL: Record<AgentTask['state'], string> = {
  queued: 'Agent: starting',
  waiting: 'Agent: waiting for its current run to finish',
  running: 'Agent working',
  done: 'Agent finished',
  failed: 'Agent run failed',
  refused: 'Agent refused',
};

/** Live status of a maintenance-agent run started from Saga: recent steps while it works, its summary when done. */
export function AgentTaskView({ taskId }: { taskId: string }) {
  const [open, setOpen] = useState(true);
  const q = useQuery({
    queryKey: ['agent-task', taskId],
    queryFn: () => get<AgentTask>(`/agent/tasks/${taskId}`, true),
    refetchInterval: (query) => (query.state.data && !ACTIVE.has(query.state.data.state) ? false : 5000),
  });
  const t = q.data;
  if (!t) return q.isLoading ? <p className="mt-2 text-xs text-muted">Checking the agent…</p> : null;
  const active = ACTIVE.has(t.state);
  const icon = active ? <Loader2 className="size-3.5 animate-spin text-info" /> : t.state === 'done' ? <CheckCircle2 className="size-3.5 text-ok" /> : <CircleAlert className="size-3.5 text-bad" />;
  const lines = active ? t.progress ?? [] : [];

  return (
    <div className="mt-2 rounded-lg border border-line bg-surface p-2.5 text-xs">
      <button className="flex w-full items-center gap-1.5 text-left font-medium" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Bot className="size-3.5" /> {icon} {LABEL[t.state]}
        <span className="ml-auto font-normal text-muted">
          {t.ended ? `finished ${relTime(t.ended * 1000)}` : t.started ? `started ${relTime(t.started * 1000)}` : t.created ? `asked ${relTime(t.created * 1000)}` : ''}
        </span>
      </button>
      {open && (
        <>
          {t.note && active && <p className="mt-1 text-muted">{t.note}</p>}
          {lines.length > 0 && (
            <ul className="mt-1.5 max-h-48 overflow-auto space-y-0.5 font-mono text-[11px] text-muted">
              {lines.map((l, i) => (
                <li key={i} className="break-words whitespace-pre-wrap">
                  {l}
                </li>
              ))}
            </ul>
          )}
          {!active && t.summary && <p className="mt-1.5 whitespace-pre-wrap">{t.summary}</p>}
          {!active && !t.summary && <p className="mt-1.5 text-muted">No summary. Check the agent's journal on the Dashboard.</p>}
        </>
      )}
    </div>
  );
}
