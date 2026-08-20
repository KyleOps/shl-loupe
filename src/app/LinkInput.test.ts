/**
 * The judgement in the detection preview, tested against the detector's real
 * output rather than against invented strings.
 *
 * Both functions under test reshape prose that `src/core/detect.ts` owns, so a
 * test built from hand-written examples would keep passing after the detector's
 * wording changed. Every case here runs `detectInput` first, which is what makes
 * this a coupling with a tripwire on it rather than a coupling nobody notices.
 */
import { describe, expect, it } from 'vitest';
import { detectInput } from '../core/detect';
import {
  consequenceSentence,
  detectionFacts,
  splitSentences,
  toneForDetection,
  VARIANT_LABEL,
} from './LinkInput';

/** The IG's own IPS example: certain, and the shape the review screenshotted. */
const IG_LINK =
  'shlink:/eyJ1cmwiOiJodHRwczovL3Jhdy5naXRodWJ1c2VyY29udGVudC5jb20vc2Vhbm5vL3NoYy1kZW1vLWRhdGEvbWFpbi9pcHMvSVBTX0lHLWJ1bmRsZS0wMS1lbmMudHh0IiwiZmxhZyI6IkxVIiwia2V5IjoicnhUZ1lsT2FLSlBGdGNFZDBxY2NlTjh3RVU0cDk0U3FBd0lXUWU2dVg3USIsImxhYmVsIjoiRGVtbyBTSEwgZm9yIElQU19JRy1idW5kbGUtMDEifQ';

describe('splitSentences', () => {
  it('does not split a host, which is what a full stop usually is here', () => {
    expect(
      splitSentences('A SMART Health Link pointing at raw.githubusercontent.com. Loupe will look.'),
    ).toEqual(['A SMART Health Link pointing at raw.githubusercontent.com.', 'Loupe will look.']);
  });

  it('leaves a single sentence whole', () => {
    expect(splitSentences('This parses as JSON, but not as an object Loupe recognises.')).toEqual([
      'This parses as JSON, but not as an object Loupe recognises.',
    ]);
  });

  it('returns nothing for nothing', () => {
    expect(splitSentences('')).toEqual([]);
  });
});

describe('consequenceSentence', () => {
  it('drops the identity clause a real link detection opens with', () => {
    const detected = detectInput(IG_LINK);
    // The clause the chip already carries, and the run-on the review saw.
    expect(detected.sentence).toContain('A SMART Health Link');
    const shown = consequenceSentence(detected.sentence);
    expect(shown.startsWith('Loupe will')).toBe(true);
    expect(shown).not.toContain('A SMART Health Link');
  });

  it('keeps a leading clause that carries a finding rather than a name', () => {
    // An odd digit count means a digit is missing, and this is the only place
    // the detector says so. A rule that dropped every leading sentence would
    // throw that away.
    const detected = detectInput('shc:/12345');
    expect(detected.sentence).toContain('odd');
    expect(consequenceSentence(detected.sentence)).toContain('odd');
  });

  it('never returns nothing, however many sentences it is given', () => {
    for (const input of [IG_LINK, 'shc:/1234', '{"resourceType":"Patient"}', 'not a link at all']) {
      const detected = detectInput(input);
      expect(consequenceSentence(detected.sentence).length).toBeGreaterThan(0);
    }
  });
});

describe('detectionFacts', () => {
  it('labels the facts a link detection produces, and leaves the rest whole', () => {
    const facts = detectionFacts(detectInput(IG_LINK).details);
    const byLabel = new Map(facts.map((fact) => [fact.label, fact.value]));

    expect(byLabel.get('host')).toBe('raw.githubusercontent.com');
    expect(byLabel.get('flags')).toBe('LU');
    expect(byLabel.get('label')).toContain('IPS_IG-bundle-01');
    expect(byLabel.get('carried as')).toBe('a shlink:/ URI');
    // "N characters of payload" is a labelled fact written back to front.
    expect(byLabel.get('payload')).toMatch(/^\d+ characters$/);
    // Nothing is dropped: every detail becomes exactly one fact.
    expect(facts).toHaveLength(detectInput(IG_LINK).details.length);
  });

  it('reads a value with no spaces in mono and a phrase in the body font', () => {
    const facts = detectionFacts(['manifest host shl.example.org', 'carried as a shlink:/ URI']);
    expect(facts[0]?.mono).toBe(true);
    expect(facts[1]?.mono).toBe(false);
  });

  it('shows an unrecognised fact whole rather than guessing a label', () => {
    // The degradation that makes the prefix list safe to keep out of the
    // detector: an unlisted wording loses its label, never its content.
    const [fact] = detectionFacts(['five dot-separated parts']);
    expect(fact?.label).toBeUndefined();
    expect(fact?.value).toBe('five dot-separated parts');
  });

  it('splits a header fact on its colon', () => {
    const [fact] = detectionFacts(['access-control-allow-origin: *']);
    expect(fact?.label).toBe('allow-origin');
    expect(fact?.value).toBe('*');
  });
});

describe('the chip', () => {
  it('has a name for every variant the detector can report', () => {
    // A missing entry would render a blank chip, so the record is exhaustive by
    // type. This checks the values are worth showing as well as present.
    for (const [variant, label] of Object.entries(VARIANT_LABEL)) {
      expect(label.length, variant).toBeGreaterThan(2);
    }
  });

  it('warns rather than reassures when the input is not recognised', () => {
    expect(toneForDetection(detectInput('not a link at all'))).toBe('warn');
    expect(toneForDetection(detectInput(IG_LINK))).toBe('pass');
  });
});
