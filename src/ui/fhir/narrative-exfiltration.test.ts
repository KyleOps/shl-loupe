/**
 * The narrative attack surface, from a second angle.
 *
 * `Narrative.test.ts` covers script execution thoroughly: handlers,
 * `javascript:` in its encoded and whitespace-split forms, and svg subtrees.
 * This file covers the vectors that do not run any script and are therefore easy
 * to leave out of an allowlist: the ones that make the reader's browser fetch
 * something, or that rewrite where a relative link points.
 *
 * They matter here more than in a general-purpose viewer. This tool renders a
 * narrative written by a stranger's clinical system, on a laptop at a testing
 * event, and it promises that the only requests it makes are the ones listed in
 * the trace. A single tracking pixel in a narrative would break that promise and
 * hand the payload's author the reader's IP address, and nothing on screen would
 * show it happened.
 *
 * Written from an independent list rather than derived from the implementation,
 * which is the point: a test written from the code inherits the code's blind
 * spots.
 */
import { describe, expect, it } from 'vitest';
import { sanitiseNarrativeHtml } from './display';

/** Anything that would cause a fetch, or redirect one, must not survive. */
const NETWORK_REACHING =
  /src\s*=|srcset|href\s*=\s*["']?https?:|background\s*=|url\(|<img|<iframe|<object|<embed|<link|<base|<meta|http-equiv|xlink/i;

const cases: Array<[string, string]> = [
  ['a tracking pixel', '<p>Dispensed today</p><img src="https://tracker.example/p.gif?id=1">'],
  ['a pixel via srcset', '<img srcset="https://tracker.example/p.png 1x, https://tracker.example/q.png 2x">'],
  ['a table background image', '<table background="https://tracker.example/t.gif"><tr><td>Result</td></tr></table>'],
  ['a stylesheet link', '<link rel="stylesheet" href="https://tracker.example/x.css">'],
  ['a preload link', '<link rel="preload" as="image" href="https://tracker.example/x.png">'],
  ['a style block with a remote url', '<style>body{background:url(https://tracker.example/x)}</style>'],
  ['a style attribute with a remote url', '<div style="background:url(https://tracker.example/x)">Result</div>'],
  ['a base tag rewriting every relative link', '<base href="https://evil.example/"><a href="/x">Report</a>'],
  ['a meta refresh redirect', '<meta http-equiv="refresh" content="0;url=https://evil.example">'],
  ['an xlink href inside svg', '<svg><a xlink:href="https://evil.example">x</a></svg>'],
  ['a video poster', '<video poster="https://tracker.example/p.jpg"></video>'],
  ['an audio source', '<audio><source src="https://tracker.example/a.mp3"></audio>'],
  ['a picture source', '<picture><source srcset="https://tracker.example/p.webp"><img src="https://tracker.example/p.png"></picture>'],
  ['an object data reference', '<object data="https://evil.example/x.swf"></object>'],
  ['an iframe', '<iframe src="https://evil.example/"></iframe>'],
  ['a track element', '<track src="https://tracker.example/t.vtt">'],
  ['an input with a remote formaction', '<input type="image" src="https://tracker.example/b.png">'],
];

describe('a narrative cannot make the browser fetch anything', () => {
  for (const [name, input] of cases) {
    it(`strips ${name}`, () => {
      const output = sanitiseNarrativeHtml(input);
      expect(output, output).not.toMatch(NETWORK_REACHING);
      expect(output.toLowerCase()).not.toContain('tracker.example');
      expect(output.toLowerCase()).not.toContain('evil.example');
    });
  }

  it('keeps the surrounding clinical text when it strips a payload', () => {
    // Stripping the whole narrative would be safe and useless: the point is that
    // the clinician still reads what the source wrote.
    const output = sanitiseNarrativeHtml(
      '<div><p>Amoxicillin 500mg, three times daily</p><img src="https://tracker.example/p.gif"><p>Review in 7 days</p></div>',
    );
    expect(output).toContain('Amoxicillin 500mg, three times daily');
    expect(output).toContain('Review in 7 days');
    expect(output).not.toContain('tracker.example');
  });
});

describe('malformed markup does not open a hole', () => {
  const malformed: Array<[string, string]> = [
    ['an unclosed script', '<script>alert(1)'],
    ['a script split by a comment', '<scr<!---->ipt>alert(1)</script>'],
    ['a comment breakout', '<!--><script>alert(1)</script>'],
    ['an unterminated attribute', '<a href="javascript:alert(1)>text</a>'],
    ['a stray closing tag', '</p><script>alert(1)</script>'],
    ['nested identical tags', '<b><b><b>bold</b></b></b>'],
    ['an unknown element', '<blink>text</blink>'],
    ['a namespaced element', '<x:script>alert(1)</x:script>'],
  ];

  for (const [name, input] of malformed) {
    it(`survives ${name} without emitting script`, () => {
      const output = sanitiseNarrativeHtml(input).toLowerCase();
      expect(output).not.toContain('<script');
      expect(output).not.toContain('javascript:');
      expect(output).not.toMatch(/\son[a-z]+\s*=/);
    });
  }
});

describe('the shape of the output', () => {
  it('reserialises from a parse rather than deleting patterns from the input', () => {
    // A pattern-stripping sanitiser leaves the surrounding text intact and can be
    // defeated by nesting; a reserialiser cannot emit a tag that is not on the
    // allowlist. The give-away is that a disallowed element vanishes along with
    // its attributes rather than leaving fragments behind.
    const output = sanitiseNarrativeHtml('<p>before<iframe src="x" data-a="b">mid</iframe>after</p>');
    expect(output).not.toContain('data-a');
    expect(output).not.toContain('iframe');
    expect(output).toContain('before');
    expect(output).toContain('after');
  });

  it('leaves an anchor usable when its target is safe', () => {
    const output = sanitiseNarrativeHtml('<a href="https://hl7.org/fhir">the specification</a>');
    expect(output).toContain('href="https://hl7.org/fhir"');
    expect(output).toContain('the specification');
  });

  it('keeps the table structure a clinical narrative depends on', () => {
    const output = sanitiseNarrativeHtml(
      '<table><thead><tr><th colspan="2">Medicines</th></tr></thead><tbody><tr><td>Metformin</td><td>500mg</td></tr></tbody></table>',
    );
    for (const fragment of ['<table', '<tr', '<th', '<td', 'colspan="2"', 'Metformin', '500mg']) {
      expect(output, fragment).toContain(fragment);
    }
  });
});
