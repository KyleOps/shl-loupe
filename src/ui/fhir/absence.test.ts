/**
 * Absence, which is the one clinical distinction a viewer must not blur.
 *
 * "This patient has no known allergies" and "nobody has asked this patient about
 * allergies" are different facts, and both arrive looking like a short list. The
 * positive statement travels as an ordinary resource of the section's own type
 * carrying a negation concept, so a renderer that treats it as a normal row shows
 * a clinician a mysterious entry, and one that ignores it shows an empty section
 * that reads as a clean bill of health.
 *
 * The defect these tests were written for: the check matched SNOMED CT only, so
 * the way the International Patient Summary actually says it, including in the
 * IPS implementation guide's own example bundle, fell through and rendered as a
 * bare "system#code" URL on screen.
 */
import { describe, expect, it } from 'vitest';
import { absenceAssertion } from './display';
import { IG_IPS_BUNDLE } from '../../fixtures/ips-bundle';

const IPS = 'http://hl7.org/fhir/uv/ips/CodeSystem/absent-unknown-uv-ips';

const allergy = (system: string, code: string, display?: string): unknown => ({
  resourceType: 'AllergyIntolerance',
  code: { coding: [{ system, code, ...(display === undefined ? {} : { display }) }] },
});

describe('the IPS absent-and-unknown code system', () => {
  it('recognises a positive "none" assertion', () => {
    const result = absenceAssertion(allergy(IPS, 'no-known-allergies'));
    expect(result?.text).toBe('No known allergies');
    expect(result?.basis).toBe('code');
    expect(result?.meaning).toBe('asserted-none');
  });

  it('keeps "no information" apart from "no known", which is the whole point', () => {
    // Collapsing these into one "None" tells the reader something nobody said.
    expect(absenceAssertion(allergy(IPS, 'no-allergy-info'))?.meaning).toBe('no-information');
    expect(absenceAssertion(allergy(IPS, 'no-known-allergies'))?.meaning).toBe('asserted-none');
    expect(absenceAssertion(allergy(IPS, 'no-problem-info'))?.meaning).toBe('no-information');
    expect(absenceAssertion(allergy(IPS, 'no-known-problems'))?.meaning).toBe('asserted-none');
  });

  it('covers every code in version 1.1.0 of the published code system', () => {
    const codes = [
      'no-allergy-info',
      'no-known-allergies',
      'no-device-info',
      'no-known-devices',
      'no-immunization-info',
      'no-known-immunizations',
      'no-medication-info',
      'no-known-medications',
      'no-problem-info',
      'no-known-problems',
      'no-procedure-info',
      'no-known-procedures',
    ];
    for (const code of codes) {
      expect(absenceAssertion(allergy(IPS, code)), code).toBeDefined();
    }
  });

  it('prefers the display the payload supplied over our own wording', () => {
    const result = absenceAssertion(allergy(IPS, 'no-known-allergies', 'Nil known allergies'));
    expect(result?.text).toBe('Nil known allergies');
  });

  it('reads a retired code and says it is retired', () => {
    // Refusing a payload the specification itself publishes would make this tool
    // the thing that is wrong, but a producer sending it should still be told.
    const result = absenceAssertion(allergy(IPS, 'no-known-food-allergies'));
    expect(result?.text).toBe('No known food allergies');
    expect(result?.meaning).toBe('asserted-none');
    expect(result?.deprecatedCode).toContain('version 1.1.0');
    expect(result?.deprecatedCode).toContain('terminology-aware validator');
  });

  it('recognises the IPS system whatever resource type carries it', () => {
    // The codes are keyed by what is absent, not by which resource states it, and
    // producers do hang "no-known-medications" on more than one type.
    for (const resourceType of ['MedicationStatement', 'List', 'Condition', 'Observation']) {
      const result = absenceAssertion({
        resourceType,
        code: { coding: [{ system: IPS, code: 'no-known-medications' }] },
      });
      expect(result?.meaning, resourceType).toBe('asserted-none');
    }
  });
});

describe('SNOMED CT absence codes still work', () => {
  it('recognises the common ones', () => {
    const sct = 'http://snomed.info/sct';
    expect(absenceAssertion(allergy(sct, '716186003'))?.text).toBe('No known allergies');
    expect(absenceAssertion(allergy(sct, '409137002'))?.meaning).toBe('asserted-none');
  });

  it('ignores an ordinary clinical code', () => {
    expect(absenceAssertion(allergy('http://snomed.info/sct', '91936005'))).toBeUndefined();
  });

  it('ignores a code from a system it does not know', () => {
    expect(
      absenceAssertion(allergy('http://example.org/codes', 'no-known-allergies')),
    ).toBeUndefined();
  });
});

describe('the IPS implementation guide’s own example bundle', () => {
  it('has its absence assertion recognised, rather than rendered as a URL', () => {
    // This is the regression. Before the fix, this resource reached the screen as
    // "http://hl7.org/fhir/uv/ips/CodeSystem/absent-unknown-uv-ips#no-known-food-allergies".
    const entries = (IG_IPS_BUNDLE as unknown as { entry: Array<{ resource: unknown }> }).entry;
    const statements = entries
      .map((entry) => absenceAssertion(entry.resource))
      .filter((statement) => statement !== undefined);

    expect(statements).toHaveLength(1);
    expect(statements[0]?.text).toBe('No known food allergies');
    expect(statements[0]?.deprecatedCode).toBeDefined();
  });
});
