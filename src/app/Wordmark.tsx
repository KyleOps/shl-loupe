/**
 * The wordmark, which has one job beyond saying the name: making the pun legible
 * without anybody having to explain it.
 *
 * "SHLoupe" is `SHL` and `loupe` sharing their L. That overlap is the whole idea
 * and it is invisible in plain text, because a reader meeting the word cold sees
 * an unfamiliar string rather than two familiar ones. So the two halves get
 * different treatments and the shared letter gets its own:
 *
 *   SH      the initialism, in the mono face, tracked out the way an initialism
 *           wants to be, and quiet
 *   L       the hinge. Mono, so it still belongs to SHL, but in the accent colour
 *           so the eye stops on it
 *   oupe    the word, in the text face, at full contrast
 *
 * Two faces meeting mid-word is the signal. A reader does not have to work out
 * why; they just see the seam and the word comes apart into its parts.
 *
 * The lens glyph stays to the left. It is doing the other half of the work, since
 * "loupe" only explains itself if you can see what a loupe is.
 *
 * Accessibility: the split is presentational, so the letters are hidden from
 * assistive technology and the link carries one accessible name. A screen reader
 * reading "S H, L, oupe" as three fragments would be strictly worse than the
 * plain word.
 */
import type { ReactNode } from 'react';

export function Wordmark({ href = '#' }: { href?: string }): ReactNode {
  return (
    <a className="wordmark" href={href} aria-label="SHLoupe, home" title="SHL + loupe">
      <svg
        className="wordmark-lens"
        viewBox="0 0 32 32"
        width="22"
        height="22"
        aria-hidden
        focusable="false"
      >
        <circle cx="13" cy="13" r="8.5" fill="none" stroke="currentColor" strokeWidth="2.5" />
        <path d="M19.5 19.5 L27 27" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      </svg>
      <span className="wordmark-text" aria-hidden="true">
        <span className="wordmark-abbr">SH</span>
        <span className="wordmark-hinge">L</span>
        <span className="wordmark-word">oupe</span>
      </span>
    </a>
  );
}
