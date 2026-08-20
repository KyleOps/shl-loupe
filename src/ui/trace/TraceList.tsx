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
 * the failing step is open and its neighbours are not. Projector Mode suppresses
 * that: on a projector the trace stays a list of titles and the presenter walks
 * it one step at a time with `j`/`k` and the arrow keys.
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
import { ListTree } from 'lucide-react';
import { useSession, useSettings } from '../../app/store';
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
  const projector = useSettings((state) => state.projector);
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
   * Projector mode opens nothing, because there the trace is walked one step at a
   * time in front of an audience. A step still in flight is left closed rather
   * than judged on an interim status.
   */
  const autoExpanded = useMemo(() => {
    if (projector) return new Set<string>();
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
  }, [run.steps, projector]);

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
          <kbd>j</kbd> <kbd>k</kbd> move, <kbd>Enter</kbd> opens, <kbd>c</kbd> copies a step.
        </p>
        <div className="trace-toolbar-actions">
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
