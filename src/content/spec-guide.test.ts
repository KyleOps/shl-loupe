/**
 * Tests for the teaching content.
 *
 * The content is prose, so these do not test wording. They test the three
 * things that make prose in a debugger dangerous when it rots:
 *
 *  - a citation that cannot be followed (no section, or a URL nobody checked),
 *  - a rule the Checks screen describes that the engine no longer runs,
 *  - an "example" that is not actually what it claims to decode to.
 *
 * The last one is why the anatomy carries a `literal` flag and a `whole`: a
 * teaching page whose worked example is subtly wrong is worse than no page.
 */
import { describe, expect, it } from 'vitest';
import {
  allAnatomySegments,
  allGuideCitations,
  anchorForTarget,
  ANATOMIES,
  DIFFERENTIAL_NOTES,
  EXAMPLE_LINK,
  EXAMPLE_PAYLOAD_BASE64URL,
  EXAMPLE_PAYLOAD_JSON,
  GUIDE_SECTIONS,
  labelForTarget,
  RULE_GROUPS,
  RULE_GUIDE,
  sectionById,
  type GuideSection,
  type SectionId,
} from './spec-guide';
import { GLOSSARY, glossaryEntry } from './glossary';
import { base64urlToString } from '../core/bytes';
import { STATIC_RULES } from '../core/diagnose/rules';

const RULE_IDS = new Set(STATIC_RULES.map((rule) => rule.id));
const SECTION_IDS = new Set<string>(GUIDE_SECTIONS.map((section) => section.id));

/** Hosts a citation is allowed to point at. A new one is a deliberate edit. */
const CITATION_HOSTS = new Set([
  'build.fhir.org',
  'www.rfc-editor.org',
  'fetch.spec.whatwg.org',
  'ktc-spec.github.io',
]);

/** Every string in a value, with a path, so a failure names the offending field. */
function strings(value: unknown, path = ''): Array<{ path: string; text: string }> {
  if (typeof value === 'string') return [{ path, text: value }];
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => strings(item, `${path}[${index}]`));
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, member]) =>
      strings(member, path === '' ? key : `${path}.${key}`),
    );
  }
  return [];
}

describe('citations', () => {
  const citations = allGuideCitations();

  it('renders a citation in every section that quotes the specification', () => {
    expect(citations.length).toBeGreaterThan(20);
  });

  it('gives every citation a spec, a section heading and a URL', () => {
    for (const citation of citations) {
      expect(citation.spec.length, JSON.stringify(citation)).toBeGreaterThan(0);
      expect(citation.section.length, JSON.stringify(citation)).toBeGreaterThan(0);
      expect(citation.url, JSON.stringify(citation)).toMatch(/^https:\/\//);
      expect(CITATION_HOSTS, citation.url).toContain(new URL(citation.url).host);
    }
  });

  it('writes a section heading as a heading, not as a sentence', () => {
    for (const citation of citations) {
      expect(citation.section.endsWith('.'), citation.section).toBe(false);
    }
  });

  it('never renders an empty quote, which would read as a quote of nothing', () => {
    for (const citation of citations) {
      if (citation.quote !== undefined) expect(citation.quote.trim().length).toBeGreaterThan(10);
    }
  });

  it('quotes without markdown emphasis, which is never in the spec text', () => {
    for (const citation of citations) {
      if (citation.quote !== undefined) expect(citation.quote).not.toMatch(/\*\*/);
    }
  });
});

describe('the checks the Checks screen describes', () => {
  it('describes only rules the engine actually runs', () => {
    for (const entry of RULE_GUIDE) {
      expect(RULE_IDS, `${entry.ruleId} is described but not implemented`).toContain(entry.ruleId);
    }
  });

  it('describes every rule the engine runs, so a new rule cannot ship undocumented', () => {
    const described = new Set(RULE_GUIDE.map((entry) => entry.ruleId));
    for (const id of RULE_IDS) {
      expect(described, `${id} is implemented but not described`).toContain(id);
    }
  });

  it('describes each rule exactly once', () => {
    const seen = new Set<string>();
    for (const entry of RULE_GUIDE) {
      expect(seen, entry.ruleId).not.toContain(entry.ruleId);
      seen.add(entry.ruleId);
    }
  });

  it('puts every rule in a group that exists', () => {
    const groups = new Set(RULE_GROUPS.map((group) => group.id));
    for (const entry of RULE_GUIDE) expect(groups, entry.ruleId).toContain(entry.group);
  });

  it('names a sandbox preset by the rule id, so a rule and its preset cannot drift apart', () => {
    for (const entry of RULE_GUIDE) {
      if (entry.tryPreset !== undefined) expect(entry.tryPreset).toBe(entry.ruleId);
    }
  });

  it('says what would make each rule fire', () => {
    for (const entry of RULE_GUIDE) {
      expect(entry.fires.length, entry.ruleId).toBeGreaterThan(40);
    }
  });

  it('explains a varying severity rather than stating one of the two as the truth', () => {
    const notHttps = RULE_GUIDE.find((entry) => entry.ruleId === 'SHL-URL-NOT-HTTPS');
    expect(notHttps?.severityVaries).toContain('mixed content');
  });
});

describe('the network differential', () => {
  it('gives every candidate cause a discriminating test', () => {
    for (const [id, note] of Object.entries(DIFFERENTIAL_NOTES)) {
      expect(note.discriminator.length, id).toBeGreaterThan(10);
      expect(note.what.length, id).toBeGreaterThan(40);
    }
  });

  it('keeps the mixed-content branch honest about no request being made', () => {
    expect(DIFFERENTIAL_NOTES['mixed-content'].what).toContain('no request was made');
  });
});

describe('the interactive anatomy', () => {
  it('reproduces the artefact exactly, for every anatomy claiming to be literal', () => {
    for (const anatomy of Object.values(ANATOMIES)) {
      if (!anatomy.literal) continue;
      expect(anatomy.whole, anatomy.id).toBeDefined();
      const joined = anatomy.segments.map((segment) => segment.text).join('');
      expect(joined, anatomy.id).toBe(anatomy.whole);
    }
  });

  it('marks an anatomy non-literal only when something in it is elided', () => {
    for (const anatomy of Object.values(ANATOMIES)) {
      const elided = anatomy.segments.some((segment) => segment.elided === true);
      expect(elided, anatomy.id).toBe(!anatomy.literal);
      if (!anatomy.literal) expect(anatomy.whole, anatomy.id).toBeUndefined();
    }
  });

  it('decodes the example link to the payload the payload anatomy shows', () => {
    expect(base64urlToString(EXAMPLE_PAYLOAD_BASE64URL)).toBe(EXAMPLE_PAYLOAD_JSON);
    expect(ANATOMIES.payload.whole).toBe(EXAMPLE_PAYLOAD_JSON);
    expect(EXAMPLE_LINK).toContain(`shlink:/${EXAMPLE_PAYLOAD_BASE64URL}`);
  });

  it('shows a payload whose members are the ones the guide documents', () => {
    const payload: unknown = JSON.parse(EXAMPLE_PAYLOAD_JSON);
    expect(Object.keys(payload as Record<string, unknown>)).toEqual([
      'url',
      'flag',
      'key',
      'label',
    ]);
  });

  it('states the key length the key member documents', () => {
    const payload = JSON.parse(EXAMPLE_PAYLOAD_JSON) as { key: string };
    expect(payload.key).toHaveLength(43);
  });

  it('points every clickable segment at something that exists', () => {
    for (const { anatomy, segment } of allAnatomySegments()) {
      const target = segment.target;
      if (target === undefined) continue;
      const where = `${anatomy.id}/${segment.id}`;
      if (target.to === 'section') expect(SECTION_IDS, where).toContain(target.section);
      if (target.to === 'anatomy') expect(Object.keys(ANATOMIES), where).toContain(target.anatomy);
      if (target.to === 'member') {
        const members = memberNames(sectionById('payload'));
        expect(members, where).toContain(target.member);
      }
    }
  });

  it('anchors a target to the id its pane renders', () => {
    expect(anchorForTarget({ to: 'member', member: 'key' })).toBe('member-key');
    expect(anchorForTarget({ to: 'section', section: 'cors' })).toBe('section-cors');
    expect(anchorForTarget({ to: 'anatomy', anatomy: 'jwe' })).toBe('anatomy-jwe');
  });

  it('labels a target with where it goes, not with the fact that it is a link', () => {
    expect(labelForTarget({ to: 'member', member: 'exp' })).toBe('Go to the exp member');
    expect(labelForTarget({ to: 'section', section: 'flags' })).toBe('Go to The three flags');
  });

  it('explains every segment, including the punctuation ones', () => {
    for (const { anatomy, segment } of allAnatomySegments()) {
      expect(segment.explains.length, `${anatomy.id}/${segment.id}`).toBeGreaterThan(8);
    }
  });

  it('keeps segment ids unique within an anatomy, since they key the DOM', () => {
    for (const anatomy of Object.values(ANATOMIES)) {
      const ids = anatomy.segments.map((segment) => segment.id);
      expect(new Set(ids).size, anatomy.id).toBe(ids.length);
    }
  });
});

function memberNames(section: GuideSection | undefined): string[] {
  if (section === undefined) return [];
  return section.blocks.flatMap((block) =>
    block.kind === 'members' ? block.members.map((member) => member.name) : [],
  );
}

describe('the sections', () => {
  it('covers the life of a link, in order', () => {
    const expected: SectionId[] = [
      'what',
      'payload',
      'flags',
      'manifest',
      'encryption',
      'cards',
      'errors',
      'cors',
    ];
    expect(GUIDE_SECTIONS.map((section) => section.id)).toEqual(expected);
  });

  it('documents all six payload members, in the order the spec lists them', () => {
    expect(memberNames(sectionById('payload'))).toEqual(['url', 'key', 'exp', 'flag', 'label', 'v']);
  });

  it('gives every payload member a cardinality, a worked example and a note about it', () => {
    for (const block of sectionById('payload')?.blocks ?? []) {
      if (block.kind !== 'members') continue;
      for (const member of block.members) {
        expect(member.cardinality, member.name).toMatch(/^\d\.\.\d$/);
        expect(member.example.length, member.name).toBeGreaterThan(0);
        expect(member.exampleNote.length, member.name).toBeGreaterThan(40);
      }
    }
  });

  it('lists the two illegal flag combinations and says why', () => {
    const flagBlocks = (sectionById('flags')?.blocks ?? []).filter(
      (block) => block.kind === 'flags',
    );
    const illegal = flagBlocks.flatMap((block) =>
      block.kind === 'flags' ? block.combinations.filter((combo) => !combo.legal) : [],
    );
    expect(illegal.map((combo) => combo.combo)).toEqual(['PU', 'UP']);
    for (const combo of illegal) expect(combo.note.length).toBeGreaterThan(40);
  });

  it('leads the CORS section with the fact that the spec never mentions CORS', () => {
    const first = sectionById('cors')?.blocks[0];
    expect(first?.kind).toBe('callout');
    if (first?.kind === 'callout') {
      expect(first.tone).toBe('fail');
      expect(first.title).toContain('never mentions CORS');
    }
  });

  it('generates the CORS checklist and the preflight command rather than restating them', () => {
    const generated = (sectionById('cors')?.blocks ?? []).flatMap((block) =>
      block.kind === 'generated' ? [block.generator] : [],
    );
    expect(generated).toEqual(['cors-headers', 'preflight-curl']);
  });

  it('gives every section a nav label short enough for a table of contents', () => {
    for (const section of GUIDE_SECTIONS) {
      expect(section.nav.length, section.id).toBeLessThanOrEqual(16);
      expect(section.lede.length, section.id).toBeGreaterThan(20);
    }
  });
});

describe('the glossary', () => {
  it('defines each term once', () => {
    const terms = GLOSSARY.map((entry) => entry.term.toLowerCase());
    expect(new Set(terms).size).toBe(terms.length);
  });

  it('resolves every "confused with" pointer to another entry', () => {
    for (const entry of GLOSSARY) {
      for (const other of entry.confusedWith ?? []) {
        expect(glossaryEntry(other), `${entry.term} points at ${other}`).toBeDefined();
      }
    }
  });

  it('never points an entry at itself', () => {
    for (const entry of GLOSSARY) {
      expect(entry.confusedWith ?? [], entry.term).not.toContain(entry.term);
    }
  });

  it('keeps the one-sentence summary to one sentence', () => {
    for (const entry of GLOSSARY) {
      expect(entry.short, entry.term).toMatch(/\.$/);
      expect(entry.short.slice(0, -1), entry.term).not.toMatch(/\. /);
    }
  });

  it('looks a term up case-insensitively, since callers type it as prose', () => {
    expect(glossaryEntry('cors')?.term).toBe('CORS');
    expect(glossaryEntry('Preflight')?.aka).toContain('OPTIONS request');
    expect(glossaryEntry('not a term')).toBeUndefined();
  });
});

describe('house style', () => {
  const sources: Array<[string, unknown]> = [
    ['sections', GUIDE_SECTIONS],
    ['anatomies', ANATOMIES],
    ['rules', RULE_GUIDE],
    ['groups', RULE_GROUPS],
    ['differential', DIFFERENTIAL_NOTES],
    ['glossary', GLOSSARY],
  ];

  it('uses no em dash or en dash anywhere in the content', () => {
    for (const [name, value] of sources) {
      for (const { path, text } of strings(value, name)) {
        expect(text, `${path}: ${text}`).not.toMatch(/[—–]/);
      }
    }
  });

  it('uses the ellipsis character rather than three full stops', () => {
    for (const [name, value] of sources) {
      for (const { path, text } of strings(value, name)) {
        expect(text, `${path}: ${text}`).not.toMatch(/\.\.\./);
      }
    }
  });

  it('spells the Australian forms', () => {
    for (const [name, value] of sources) {
      for (const { path, text } of strings(value, name)) {
        // Deliberately narrow: only forms that appear in this content, so the
        // check cannot fail on a quoted American spelling from a spec.
        expect(text, `${path}: ${text}`).not.toMatch(/\boptimization\b|\bminimization\b/);
      }
    }
  });
});
