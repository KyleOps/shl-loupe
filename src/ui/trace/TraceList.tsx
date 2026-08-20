/**
 * The trace: an ordered list of steps, nested by causation.
 *
 * Two decisions worth knowing before changing anything here.
 *
 * ONE TAB STOP, REAL FOCUS. The list is a single tab stop: exactly one step
 * header carries `tabindex=0` and the rest carry `-1`, and `j`/`k` move real DOM
 * focus between them. The design note asked for `aria-activedescendant` as well,
 * and this deliberately does not use it: that attribute needs a container role
 * that supports it (`listbox`, `tree`, `grid`), none of which may contain
 * buttons, and pairing it with real focus movement makes a screen reader
 * announce every row twice. Roving tabindex over real `<button>` headers gets
 * the same single tab stop with semantics that already work.
 *
 * WHAT EXPANDS ITSELF. A step that did not pass opens as soon as it settles, so
 * the failing step is open and its neighbours are not. The one thing that
 * suppresses it is "Walk through", below, which exists for showing the trace to
 * somebody rather than reading it yourself.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { Check, Footprints, ListTree } from 'lucide-react';
import { useSession } from '../../app/store';
import type { TraceRun } from '../../core/trace';
import { Button, CopyButton, EmptyState } from '../primitives';
import { FindingCard } from './FindingCard';
import { TraceStep } from './TraceStep';
import {
  buildStepTree,
  durationBarWidths,
  flattenStepTree,
  stepDomId,
  stepToText,
  type StepNode,
} from './format';

const COPY_NOTICE_MS = 1600;

export function TraceList({ run }: { run: TraceRun }): ReactNode {
  const redactor = useSession((state) => state.redactor);
  const selected = useSession((state) => state.expandedStep);
  const expandStep = useSession((state) => state.expandStep);

  const tree = useMemo(() => buildStepTree(run.steps), [run.steps]);
  const flat = useMemo(() => flattenStepTree(tree), [tree]);
  const bars = useMemo(() => durationBarWidths(run.steps), [run.steps]);

  const mask = useMemo(() => {
    const active = redactor?.isActive === true ? redactor : undefined;
    return active ? (text: string) => active.text(text) : undefined;
  }, [redactor]);

  /**
   * Expansion is DERIVED, not stored, and the distinction matters.
   *
   * A step that failed should be open the moment it fails, which invites the
   * obvious implementation: watch the steps in an effect and expand the
   * interesting ones. That is a cascading render per snapshot (and the recorder
   * emits one per mutation), and it needs a second ref to remember which steps it
   * has already judged so a user's collapse is not undone on the next tick.
   *
   * So instead: `autoExpanded` is a pure function of the run, `overrides` records
   * only the decisions a person actually made, and the person wins. A new run
   * needs no reset, because the overrides are keyed by step id and a new run has
   * new ids.
   */
  const [overrides, setOverrides] = useState<ReadonlyMap<string, boolean>>(() => new Map());

  /**
   * Walk-through: nothing opens itself, the presenter opens each step.
   *
   * This behaviour used to be a side effect of "projector mode", which meant the
   * only way to get it was to change the app's colours and type at the same time,
   * and nothing in the interface said it was happening. It is a presentation
   * affordance rather than a theme, so it is named and sits on the trace, which
   * is the thing it changes.
   *
   * Local state on purpose, in both directions. Not the settings store, because
   * persisting it means coming back tomorrow to a trace where a failure quietly
   * does not open and no obvious reason why. Not the session store either: it
   * says nothing about the run, and clearing the session should not turn it off
   * mid-demonstration.
   */
  const [walkThrough, setWalkThrough] = useState(false);
  const [notice, setNotice] = useState('');
  const noticeTimer = useRef<number | undefined>(undefined);
  const listRef = useRef<HTMLOListElement | null>(null);
  // Set before every internal selection change, so the jump-in effect below can
  // tell "somebody else asked for this step" from "the user pressed j".
  const lastRequested = useRef<string | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(noticeTimer.current), []);

  /**
   * The steps worth opening on their own: anything that did not simply pass.
   *
   * A step still in flight is left closed rather than judged on an interim
   * status. In walk-through nothing qualifies, which is the whole of what that
   * mode does: the overrides map is untouched, so a step somebody deliberately
   * opened stays open and turning walk-through off restores the derived set.
   */
  const autoExpanded = useMemo(() => {
    if (walkThrough) return new Set<string>();
    return new Set(
      run.steps
        .filter(
          (step) =>
            step.status !== 'ok' &&
            step.status !== 'skipped' &&
            step.status !== 'running' &&
            step.status !== 'pending',
        )
        .map((step) => step.id),
    );
  }, [run.steps, walkThrough]);

  const isExpanded = useCallback(
    (id: string): boolean => overrides.get(id) ?? autoExpanded.has(id),
    [overrides, autoExpanded],
  );

  const focusStep = useCallback((id: string) => {
    const row = document.getElementById(stepDomId(id));
    row?.querySelector<HTMLButtonElement>('.step-head')?.focus();
  }, []);

  const select = useCallback(
    (id: string) => {
      lastRequested.current = id;
      expandStep(id);
    },
    [expandStep],
  );

  // Somewhere else asked for a step: the verdict banner's jump, or a payload
  // pane pointing at the fetch that produced it. Open it, show it, focus it.
  useEffect(() => {
    if (selected === undefined || selected === lastRequested.current) return;
    lastRequested.current = selected;
    setOverrides((previous) => new Map(previous).set(selected, true));
    const row = document.getElementById(stepDomId(selected));
    if (!row) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    row.scrollIntoView({ block: 'nearest', behavior: reduced ? 'auto' : 'smooth' });
    row.querySelector<HTMLButtonElement>('.step-head')?.focus();
  }, [selected]);

  const activeId = useMemo(() => {
    if (selected !== undefined && flat.some((node) => node.step.id === selected)) return selected;
    return flat[0]?.step.id;
  }, [flat, selected]);

  const toggle = useCallback(
    (id: string) => {
      const next = !isExpanded(id);
      setOverrides((previous) => new Map(previous).set(id, next));
    },
    [isExpanded],
  );

  const setOpen = useCallback((id: string, open: boolean) => {
    setOverrides((previous) => new Map(previous).set(id, open));
  }, []);

  /**
   * Turning it on also puts focus on a step, because the keys that make
   * walk-through worth having are only live while a step header has focus (see
   * `onKeyDown`: it deliberately ignores everything outside `.step-head` so `c`
   * cannot fire a copy while somebody is tabbing through evidence). Without this,
   * pressing the button and then an arrow key does nothing, which reads as the
   * feature being broken.
   */
  const toggleWalkThrough = useCallback(() => {
    const next = !walkThrough;
    setWalkThrough(next);
    // Outside the state updater, not inside it: an updater has to stay pure or
    // React's development double-invoke runs the side effect twice.
    if (next && activeId !== undefined) focusStep(activeId);
  }, [activeId, focusStep, walkThrough]);

  const announce = useCallback((message: string) => {
    setNotice(message);
    window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(''), COPY_NOTICE_MS);
  }, []);

  const expandAll = useCallback(() => {
    setOverrides(new Map(flat.map((node) => [node.step.id, true])));
  }, [flat]);

  const collapseAll = useCallback(() => {
    // An explicit false per step, not an empty map: an empty map would fall back
    // to the derived set and re-open every step that had failed.
    setOverrides(new Map(flat.map((node) => [node.step.id, false])));
  }, [flat]);

  const traceText = useCallback(
    () =>
      flat
        .map((node) =>
          stepToText(node.step, run.findings, {
            number: node.number,
            ...(mask === undefined ? {} : { mask }),
          }),
        )
        .join('\n\n'),
    [flat, mask, run.findings],
  );

  const copyStep = useCallback(
    (node: StepNode) => {
      const text = stepToText(node.step, run.findings, {
        number: node.number,
        ...(mask === undefined ? {} : { mask }),
      });
      void navigator.clipboard.writeText(text).then(() => announce(`Step ${node.number} copied.`));
    },
    [announce, mask, run.findings],
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLOListElement>) => {
      const target = event.target as HTMLElement;
      // Only a step header owns these keys. Inside an expanded body a copy
      // button, a JSON node and a text selection all keep their own behaviour:
      // "c" must not fire a copy while somebody is tabbing through evidence.
      if (!target.classList.contains('step-head')) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (activeId === undefined) return;
      const index = flat.findIndex((node) => node.step.id === activeId);
      const node = flat[index];
      if (!node) return;

      const move = (delta: number): void => {
        const next = flat[Math.min(flat.length - 1, Math.max(0, index + delta))];
        if (!next || next.step.id === activeId) return;
        event.preventDefault();
        select(next.step.id);
        focusStep(next.step.id);
      };

      switch (event.key) {
        case 'j':
        case 'ArrowDown':
          move(1);
          return;
        case 'k':
        case 'ArrowUp':
          move(-1);
          return;
        case 'ArrowRight':
          event.preventDefault();
          setOpen(activeId, true);
          return;
        case 'ArrowLeft':
          event.preventDefault();
          setOpen(activeId, false);
          return;
        case 'Enter':
          // Shift+Enter would otherwise also fire the header button's click and
          // collapse the very step it just expanded.
          if (event.shiftKey) {
            event.preventDefault();
            expandAll();
          }
          return;
        case 'Backspace':
          if (event.shiftKey) {
            event.preventDefault();
            collapseAll();
          }
          return;
        case 'c':
          event.preventDefault();
          copyStep(node);
          return;
        default:
          return;
      }
    },
    [activeId, collapseAll, copyStep, expandAll, flat, focusStep, select, setOpen],
  );

  const attributedFindingIds = new Set(run.steps.flatMap((step) => step.findingIds));
  const unattributed = run.findings.filter((finding) => !attributedFindingIds.has(finding.id));

  if (run.steps.length === 0) {
    return (
      <EmptyState icon={<ListTree size={20} aria-hidden />} title="Nothing has run yet">
        <p>
          Open a link and every step of it appears here, including the ones that need no network at
          all.
        </p>
      </EmptyState>
    );
  }

  const renderNodes = (nodes: readonly StepNode[]): ReactNode =>
    nodes.map((node) => (
      <TraceStep
        key={node.step.id}
        step={node.step}
        run={run}
        number={node.number}
        {...(bars.get(node.step.id) === undefined ? {} : { bar: bars.get(node.step.id) })}
        expanded={isExpanded(node.step.id)}
        active={node.step.id === activeId}
        onToggle={toggle}
        onSelect={select}
        {...(mask === undefined ? {} : { mask })}
      >
        {node.children.length > 0 && (
          <ol className="trace trace-children">{renderNodes(node.children)}</ol>
        )}
      </TraceStep>
    ));

  return (
    <div className="trace-wrap">
      <div className="trace-toolbar">
        <p className="trace-hint">
          {walkThrough ? (
            <>
              <kbd>↓</kbd> <kbd>↑</kbd> or <kbd>j</kbd> <kbd>k</kbd> step, <kbd>→</kbd> opens,{' '}
              <kbd>←</kbd> closes. Nothing opens on its own.
            </>
          ) : (
            <>
              <kbd>j</kbd> <kbd>k</kbd> move, <kbd>Enter</kbd> opens, <kbd>c</kbd> copies a step.
            </>
          )}
        </p>
        <div className="trace-toolbar-actions">
          {/*
           * The name stays put and `aria-pressed` carries the state, which is the
           * toggle-button pattern: a label that changes with the state makes a
           * screen reader announce the action and the state as one string. So the
           * visible state is the icon silhouette (a tick against a pair of
           * footprints), the filled surface, and the hint line beside it changing
           * to say that nothing opens on its own.
           */}
          <Button
            size="sm"
            variant={walkThrough ? 'primary' : 'default'}
            aria-pressed={walkThrough}
            onClick={toggleWalkThrough}
            title="Stop steps opening themselves, and step through the trace with the arrow keys"
          >
            {walkThrough ? <Check size={13} aria-hidden /> : <Footprints size={13} aria-hidden />}
            Walk through
          </Button>
          <Button size="sm" onClick={expandAll}>
            Expand all
          </Button>
          <Button size="sm" onClick={collapseAll}>
            Collapse all
          </Button>
          <CopyButton value={traceText} label="Copy the whole trace" />
        </div>
      </div>

      <ol className="trace" ref={listRef} onKeyDown={onKeyDown}>
        {renderNodes(tree)}
      </ol>

      {unattributed.length > 0 && (
        <section className="trace-orphans">
          <h3>Findings that belong to the run rather than to one step</h3>
          {unattributed.map((finding) => (
            <FindingCard key={finding.id} finding={finding} />
          ))}
        </section>
      )}

      <p role="status" aria-live="polite" className="trace-notice">
        {notice}
      </p>
    </div>
  );
}
