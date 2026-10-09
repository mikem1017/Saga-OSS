import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { CheckSquare, ListChecks, X } from 'lucide-react';
import type { TitleCard } from '../../shared/types.ts';
import { Button } from './ui.tsx';
import { BulkAddDialog } from './AddDialog.tsx';

/**
 * Multi-select across Discover: one selection for the whole app, so titles can be picked from several rails
 * and browse pages, then added in one bulk add. Only titles not yet in the library can be selected.
 */
export const MAX_SELECT = 250;

export const selectable = (c: TitleCard) => c.state.kind === 'none' || c.state.kind === 'requested';
const keyOf = (c: TitleCard) => `${c.mediaType}:${c.tmdbId}`;

interface SelectionCtx {
  active: boolean;
  setActive: (v: boolean) => void;
  selected: Map<string, TitleCard>;
  isSelected: (c: TitleCard) => boolean;
  toggle: (c: TitleCard) => void;
  /** Adds every selectable card (up to the cap). Returns how many were added. */
  selectMany: (cards: TitleCard[]) => number;
  deselectMany: (cards: TitleCard[]) => void;
  clear: () => void;
}

const Ctx = createContext<SelectionCtx | null>(null);

export function SelectionProvider({ children }: { children: ReactNode }) {
  const [active, setActiveState] = useState(false);
  const [selected, setSelected] = useState<Map<string, TitleCard>>(new Map());
  const toggle = useCallback((c: TitleCard) => {
    if (!selectable(c)) return;
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(keyOf(c))) next.delete(keyOf(c));
      else if (next.size < MAX_SELECT) next.set(keyOf(c), c);
      return next;
    });
  }, []);
  const selectMany = useCallback((cards: TitleCard[]) => {
    let added = 0;
    setSelected((prev) => {
      const next = new Map(prev);
      for (const c of cards) {
        if (next.size >= MAX_SELECT) break;
        if (selectable(c) && !next.has(keyOf(c))) {
          next.set(keyOf(c), c);
          added++;
        }
      }
      return next;
    });
    setActiveState(true);
    return added;
  }, []);
  const deselectMany = useCallback((cards: TitleCard[]) => {
    setSelected((prev) => {
      const next = new Map(prev);
      for (const c of cards) next.delete(keyOf(c));
      return next;
    });
  }, []);
  const clear = useCallback(() => setSelected(new Map()), []);
  const setActive = useCallback((v: boolean) => {
    setActiveState(v);
    if (!v) setSelected(new Map());
  }, []);
  const value = useMemo<SelectionCtx>(
    () => ({ active, setActive, selected, isSelected: (c) => selected.has(keyOf(c)), toggle, selectMany, deselectMany, clear }),
    [active, setActive, selected, toggle, selectMany, deselectMany, clear],
  );
  return (
    <Ctx.Provider value={value}>
      {children}
      <SelectionBar />
    </Ctx.Provider>
  );
}

export function useSelection() {
  return useContext(Ctx);
}

/** "Select" on/off for page headers. */
export function SelectToggle() {
  const sel = useSelection();
  if (!sel) return null;
  return (
    <Button variant={sel.active ? 'primary' : 'secondary'} size="sm" onClick={() => sel.setActive(!sel.active)} aria-pressed={sel.active}>
      <ListChecks className="size-4" /> {sel.active ? 'Selecting' : 'Select'}
    </Button>
  );
}

/** "Select all N missing" for a set of visible cards (a rail, a grid). Toggles off when they're all selected. */
export function SelectAllButton({ cards, label = 'Select all' }: { cards: TitleCard[]; label?: string }) {
  const sel = useSelection();
  if (!sel) return null;
  const candidates = cards.filter(selectable);
  if (!candidates.length) return <span className="text-xs text-muted">Nothing to add here</span>;
  const all = candidates.every((c) => sel.isSelected(c));
  return (
    <button
      className="text-xs font-medium text-accent hover:underline inline-flex items-center gap-1"
      onClick={() => (all ? sel.deselectMany(candidates) : sel.selectMany(candidates))}
    >
      <CheckSquare className="size-3.5" />
      {all ? `Deselect ${candidates.length}` : `${label} ${candidates.length} missing`}
    </button>
  );
}

function SelectionBar() {
  const sel = useSelection()!;
  const [open, setOpen] = useState(false);
  if (!sel.active) return null;
  const cards = [...sel.selected.values()];
  return (
    <>
      <div className="fixed z-40 inset-x-3 bottom-20 md:bottom-5 md:left-60 md:right-5 flex justify-center pointer-events-none">
        <div className="pointer-events-auto flex flex-wrap items-center gap-3 rounded-2xl border border-line bg-surface/95 backdrop-blur shadow-2xl px-4 py-3 max-w-2xl w-full">
          <span className="text-sm font-medium tabular-nums">
            {cards.length} selected{cards.length >= MAX_SELECT && <span className="text-warn"> (max {MAX_SELECT})</span>}
          </span>
          <span className="text-xs text-muted hidden sm:inline">Tap posters to pick, or use "Select all" on a row.</span>
          <div className="ml-auto flex items-center gap-2">
            {cards.length > 0 && (
              <Button variant="ghost" size="sm" onClick={sel.clear}>
                Clear
              </Button>
            )}
            <Button variant="primary" size="sm" disabled={!cards.length} onClick={() => setOpen(true)}>
              Add {cards.length || ''}…
            </Button>
            <button onClick={() => sel.setActive(false)} className="text-muted hover:text-fg p-1" aria-label="Stop selecting">
              <X className="size-4" />
            </button>
          </div>
        </div>
      </div>
      {open && (
        <BulkAddDialog
          open={open}
          onClose={() => setOpen(false)}
          onDone={() => sel.setActive(false)}
          cards={cards}
          title={`Add ${cards.length} selected title${cards.length === 1 ? '' : 's'}`}
        />
      )}
    </>
  );
}
