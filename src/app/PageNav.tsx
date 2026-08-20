/**
 * The on-page rail: what is on this page, and where you are in it.
 *
 * This started as the Learn screen's table of contents, and it is here because
 * that was the only screen that looked like a website. The others were one column
 * of prose at the left of a very wide page with nothing beside it, which the
 * maintainer described, accurately, as text trapped in a box. A reading page needs
 * something in the other column, and the something that earns its place on a long
 * technical page is the outline: it fills the width, says how much page there is,
 * and gets you to the part you came for.
 *
 * So this is one component now, used by every long reading screen, rather than a
 * good idea on one of them.
 *
 * Three details are load bearing, all inherited from the Learn implementation:
 *
 * THE ACTIVE ENTRY IS THE FIRST VISIBLE ONE IN DOCUMENT ORDER, not the largest on
 * screen: while two sections are both visible, the one you are reading down from
 * is the earlier one, and picking the biggest makes the marker jump backwards as
 * you scroll.
 *
 * IT IS MARKED BY THREE THINGS, never colour alone: the accent rail, the weight,
 * and the brighter text, with `aria-current` carrying it to a screen reader. A
 * hairline is 1.55:1 on this canvas (tokens.css), so a rail on its own cannot be
 * the thing that says which entry is current.
 *
 * FOCUS FOLLOWS THE SCROLL. Without `element.focus()`, a keyboard user ends up
 * reading one part of the page and tabbing from another. Every target carries
 * `tabIndex={-1}` so it can take focus without entering the tab order.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { clsx } from 'clsx';

export interface PageNavItem {
  /** The `id` of the element to scroll to. */
  anchor: string;
  /** What the rail calls it, which is usually shorter than the heading. */
  label: string;
}

export function PageNav({
  items,
  label,
  title = 'On this page',
}: {
  items: readonly PageNavItem[];
  /** Names the nav for a screen reader: "Sections of this guide". */
  label: string;
  title?: string;
}): ReactNode {
  const anchors = items.map((item) => item.anchor);
  const active = useActiveAnchor(anchors);
  const follow = useFollow();

  return (
    <nav className="page-rail" aria-label={label}>
      <p className="page-rail-title">{title}</p>
      <ol>
        {items.map((item) => (
          <li key={item.anchor}>
            <button
              type="button"
              className={clsx('page-rail-link', active === item.anchor && 'is-active')}
              {...(active === item.anchor ? { 'aria-current': 'true' as const } : {})}
              onClick={() => follow(item.anchor)}
            >
              {item.label}
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}

export function useActiveAnchor(anchors: readonly string[]): string | undefined {
  const [active, setActive] = useState<string | undefined>(anchors[0]);
  // The array identity changes every render for an inline literal, so the effect
  // keys off the contents rather than the array.
  const key = anchors.join('|');

  useEffect(() => {
    const list = key.split('|');
    const visible = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) visible.add(entry.target.id);
          else visible.delete(entry.target.id);
        }
        const first = list.find((anchor) => visible.has(anchor));
        if (first !== undefined) setActive(first);
      },
      { rootMargin: '-96px 0px -55% 0px', threshold: 0 },
    );
    for (const anchor of list) {
      const element = document.getElementById(anchor);
      if (element !== null) observer.observe(element);
    }
    return () => observer.disconnect();
  }, [key]);

  return active;
}

export function useFollow(): (anchor: string) => void {
  return useCallback((anchor: string) => {
    const element = document.getElementById(anchor);
    if (element === null) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    element.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
    element.focus({ preventScroll: true });
  }, []);
}
