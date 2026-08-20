import { describe, expect, it } from 'vitest';
import {
  absenceAssertion,
  addressLine,
  bestHumanName,
  codeableConcept,
  codeableConceptText,
  codeSystemLabel,
  codeToWords,
  dosageText,
  formatDateValue,
  humanName,
  identifierText,
  narrativeRowCount,
  narrativeTextContent,
  periodText,
  pickChoice,
  primitiveAbsentReason,
  profileName,
  quantityText,
  rangeText,
  ratioText,
  referenceLabel,
  renderableDate,
  sanitiseNarrativeHtml,
  sectionLoinc,
  sectionSortKey,
  shortenUrn,
  summariseResource,
  timingScheduleText,
  ucumNote,
} from './display';

describe('formatDateValue', () => {
  it('keeps a year-only value at year precision', () => {
    expect(formatDateValue('2026')).toMatchObject({
      text: '2026',
      precision: 'year',
      raw: '2026',
    });
  });

  it('keeps a year and month at month precision', () => {
    expect(formatDateValue('2026-08')).toMatchObject({ text: 'Aug 2026', precision: 'month' });
  });

  it('renders a date as day month year with no leading zero', () => {
    expect(formatDateValue('2026-08-04')).toMatchObject({ text: '4 Aug 2026', precision: 'day' });
  });

  it('renders the wire time of day rather than shifting it into local time', () => {
    expect(formatDateValue('2026-08-14T09:35:00+10:00').text).toBe('14 Aug 2026, 09:35:00 +10:00');
    expect(formatDateValue('2026-08-14T09:35:00Z').text).toBe('14 Aug 2026, 09:35:00 UTC');
  });

  it('flags a time with no offset, which R4 forbids', () => {
    const parsed = formatDateValue('2026-08-14T09:35:00');
    expect(parsed.precision).toBe('time');
    expect(parsed.note).toContain('no time zone offset');
  });

  it('returns the raw value unchanged when it cannot be parsed', () => {
    expect(formatDateValue('14/08/2026')).toMatchObject({
      text: '14/08/2026',
      shape: 'unparsed',
      precision: 'none',
    });
  });
});

describe('renderableDate', () => {
  it('handles the Period form', () => {
    expect(renderableDate({ start: '2026-08-14', end: '2026-08-20' })).toMatchObject({
      text: '14 Aug 2026 to 20 Aug 2026',
      shape: 'period',
    });
  });

  it('says "from" when a Period has no end', () => {
    expect(periodText({ start: '2026-08-14' })).toBe('from 14 Aug 2026');
    expect(periodText({ end: '2026-08-20' })).toBe('until 20 Aug 2026');
  });

  it('handles the Timing form via its events', () => {
    expect(renderableDate({ event: ['2026-08-14', '2026-08-15'] })).toMatchObject({
      text: '14 Aug 2026 and 1 more',
      shape: 'timing',
    });
  });

  it('handles a Timing that only carries a repeat schedule', () => {
    expect(renderableDate({ repeat: { frequency: 2, period: 1, periodUnit: 'd' } })).toMatchObject({
      text: 'twice a day',
      shape: 'timing',
    });
  });

  it('handles the Age form used by onsetAge', () => {
    expect(renderableDate({ value: 54, unit: 'years', code: 'a' })).toMatchObject({
      text: '54 years',
      shape: 'age',
    });
  });

  it('treats an unparseable string as a string, not as a date', () => {
    expect(renderableDate('when he was a boy')).toMatchObject({ shape: 'string' });
  });

  it('returns nothing for an empty choice value', () => {
    expect(renderableDate('')).toBeUndefined();
    expect(renderableDate({})).toBeUndefined();
    expect(renderableDate(null)).toBeUndefined();
  });
});

describe('timingScheduleText', () => {
  it('reads a frequency and period as English', () => {
    expect(timingScheduleText({ repeat: { frequency: 1, period: 1, periodUnit: 'd' } })).toBe(
      'once a day',
    );
    expect(timingScheduleText({ repeat: { frequency: 3, period: 1, periodUnit: 'd' } })).toBe(
      '3 times a day',
    );
    expect(timingScheduleText({ repeat: { period: 8, periodUnit: 'h' } })).toBe('every 8 hours');
  });

  it('appends a when code', () => {
    expect(
      timingScheduleText({ repeat: { frequency: 1, period: 1, periodUnit: 'd', when: ['MORN'] } }),
    ).toBe('once a day, MORN');
  });
});

describe('pickChoice', () => {
  it('finds the suffix a producer actually used', () => {
    expect(pickChoice({ effectiveDateTime: '2026-08-14' }, 'effective')).toMatchObject({
      suffix: 'DateTime',
      value: '2026-08-14',
    });
  });

  it('does not mistake a lower-cased sibling for a choice element', () => {
    expect(pickChoice({ valueSet: 'http://example.org/vs' }, 'value')).toBeUndefined();
  });
});

describe('codeableConcept', () => {
  it('prefers text, which is what the sender wrote for a human', () => {
    expect(
      codeableConcept({
        text: 'Bisoprolol 2.5mg',
        coding: [{ system: 'http://snomed.info/sct', code: '23281011000036106' }],
      }),
    ).toMatchObject({ text: 'Bisoprolol 2.5mg', from: 'text', codeOnly: false });
  });

  it('falls back to a coding display', () => {
    expect(
      codeableConcept({
        coding: [{ system: 'http://loinc.org', code: '8716-3', display: 'Vitals' }],
      }),
    ).toMatchObject({ text: 'Vitals', from: 'display' });
  });

  it('never shows a bare code with no context', () => {
    const parsed = codeableConcept({
      coding: [{ system: 'http://snomed.info/sct', code: '160245001' }],
    });
    expect(parsed).toMatchObject({ text: 'http://snomed.info/sct#160245001', codeOnly: true });
    expect(parsed?.codes[0]?.label).toBe('SNOMED CT 160245001');
  });

  it('returns nothing for an empty concept', () => {
    expect(codeableConceptText({})).toBeUndefined();
    expect(codeableConceptText(undefined)).toBeUndefined();
  });

  it('reads a bare code string where a concept was expected', () => {
    expect(codeableConceptText('entered-in-error')).toBe('Entered in error');
  });
});

describe('codeSystemLabel', () => {
  it('names the systems a summary actually carries', () => {
    expect(codeSystemLabel('http://loinc.org')).toBe('LOINC');
    expect(codeSystemLabel('http://snomed.info/sct')).toBe('SNOMED CT');
    expect(codeSystemLabel('http://pbs.gov.au/code/item')).toBe('PBS item');
  });

  it('shortens an hl7 terminology URI to its last segment', () => {
    expect(codeSystemLabel('http://terminology.hl7.org/CodeSystem/condition-clinical')).toBe(
      'condition-clinical',
    );
  });

  it('returns an unrecognised system verbatim rather than inventing a name', () => {
    expect(codeSystemLabel('https://example.org/codes')).toBe('https://example.org/codes');
  });
});

describe('codeToWords', () => {
  it('sentence-cases a FHIR code enum', () => {
    expect(codeToWords('entered-in-error')).toBe('Entered in error');
    expect(codeToWords('final')).toBe('Final');
  });

  it('leaves a terminology code alone', () => {
    expect(codeToWords('160245001')).toBe('160245001');
    expect(codeToWords('8716-3')).toBe('8716-3');
  });
});

describe('quantities', () => {
  it('prefers the human unit over the UCUM code', () => {
    expect(quantityText({ value: 5.5, unit: 'mmol/L', code: 'mmol/L' })).toBe('5.5 mmol/L');
    expect(quantityText({ value: 120, code: 'mm[Hg]' })).toBe('120 mm[Hg]');
  });

  it('renders a comparator as words', () => {
    expect(quantityText({ value: 5, comparator: '>=', unit: 'mg' })).toBe('at least 5 mg');
  });

  it('notes a UCUM code that differs from the printed unit', () => {
    expect(
      ucumNote({
        value: 120,
        unit: 'mmHg',
        system: 'http://unitsofmeasure.org',
        code: 'mm[Hg]',
      }),
    ).toBe('Coded as mm[Hg] (UCUM)');
    expect(ucumNote({ value: 120, unit: 'mm[Hg]', code: 'mm[Hg]' })).toBeUndefined();
  });

  it('says the system is unstated rather than assuming UCUM', () => {
    expect(ucumNote({ value: 120, unit: 'mmHg', code: 'mm[Hg]' })).toBe(
      'Coded as mm[Hg] (unstated system)',
    );
  });

  it('renders ranges with "to", never a dash', () => {
    expect(
      rangeText({ low: { value: 3.5, unit: 'mmol/L' }, high: { value: 6, unit: 'mmol/L' } }),
    ).toBe('3.5 mmol/L to 6 mmol/L');
    expect(rangeText({ high: { value: 6, unit: 'mmol/L' } })).toBe('up to 6 mmol/L');
    expect(rangeText({})).toBeUndefined();
  });

  it('drops a denominator of one from a ratio', () => {
    expect(
      ratioText({ numerator: { value: 5, unit: 'mg' }, denominator: { value: 1, unit: 'mL' } }),
    ).toBe('5 mg per mL');
    expect(
      ratioText({ numerator: { value: 5, unit: 'mg' }, denominator: { value: 2, unit: 'mL' } }),
    ).toBe('5 mg per 2 mL');
  });
});

describe('dosageText', () => {
  it('uses the prescriber-written text verbatim when there is one', () => {
    expect(dosageText({ text: 'ONE tablet in the MORNING', route: { text: 'Oral' } })).toBe(
      'ONE tablet in the MORNING',
    );
  });

  it('composes dose, schedule and route when there is no text', () => {
    expect(
      dosageText({
        doseAndRate: [{ doseQuantity: { value: 1, unit: 'tablet' } }],
        timing: { repeat: { frequency: 2, period: 1, periodUnit: 'd' } },
        route: { text: 'Oral' },
      }),
    ).toBe('1 tablet, twice a day, Oral');
  });

  it('names what an as-needed dose is for', () => {
    expect(
      dosageText({
        doseAndRate: [
          { doseRange: { low: { value: 1, unit: 'tablet' }, high: { value: 2, unit: 'tablet' } } },
        ],
        asNeededCodeableConcept: { text: 'pain' },
      }),
    ).toBe('1 tablet to 2 tablet, as needed for pain');
  });

  it('returns nothing for an empty dosage', () => {
    expect(dosageText({})).toBeUndefined();
  });
});

describe('names and addresses', () => {
  it('prefers HumanName.text', () => {
    expect(humanName({ text: 'Ms Mia Banks', family: 'Banks' })).toBe('Ms Mia Banks');
  });

  it('composes prefix, given and family in order', () => {
    expect(humanName({ prefix: ['Dr'], given: ['Ada', 'L'], family: 'Chen' })).toBe(
      'Dr Ada L Chen',
    );
  });

  it('prefers an official name over an old one', () => {
    expect(
      bestHumanName([
        { use: 'old', family: 'Smith' },
        { use: 'official', family: 'Banks', given: ['Mia'] },
      ]),
    ).toBe('Mia Banks');
  });

  it('composes an address line', () => {
    expect(
      addressLine({ line: ['12 Wharf St'], city: 'Brisbane', state: 'QLD', postalCode: '4000' }),
    ).toBe('12 Wharf St, Brisbane, QLD, 4000');
  });
});

describe('identifiers and references', () => {
  it('labels an IHI rather than showing sixteen unexplained digits', () => {
    expect(
      identifierText({
        system: 'http://ns.electronichealth.net.au/id/hi/ihi/1.0',
        value: '8003608000000000',
      }),
    ).toBe('IHI 8003608000000000');
  });

  it('falls back to the system URI it was given', () => {
    expect(identifierText({ system: 'https://example.org/mrn', value: 'A1' })).toBe(
      'https://example.org/mrn A1',
    );
  });

  it('prefers Reference.display, which exists for exactly this case', () => {
    expect(referenceLabel({ reference: 'urn:uuid:abc', display: 'Mia Banks' })).toBe('Mia Banks');
  });

  it('shortens a urn:uuid reference when there is nothing else', () => {
    expect(referenceLabel({ reference: 'urn:uuid:8f3a1c2d-4e5f-6071-8293-a4b5c6d7e8f9' })).toBe(
      'urn:uuid:8f3a1c2d…e8f9',
    );
  });

  it('leaves a short reference alone', () => {
    expect(shortenUrn('Patient/mia-banks')).toBe('Patient/mia-banks');
  });
});

describe('absence', () => {
  it('reads a data-absent-reason out of the primitive extension sibling', () => {
    const statement = {
      resourceType: 'MedicationStatement',
      _effectiveDateTime: {
        extension: [
          {
            url: 'http://hl7.org/fhir/StructureDefinition/data-absent-reason',
            valueCode: 'unknown',
          },
        ],
      },
    };
    expect(primitiveAbsentReason(statement, 'effectiveDateTime')).toBe('unknown');
    expect(primitiveAbsentReason(statement, 'effectivePeriod')).toBeUndefined();
  });

  it('recognises a coded absence assertion as a statement, not a finding', () => {
    expect(
      absenceAssertion({
        resourceType: 'AllergyIntolerance',
        code: { coding: [{ system: 'http://snomed.info/sct', code: '716186003' }] },
      }),
    ).toMatchObject({ text: 'No known allergies', basis: 'code', code: '716186003' });
  });

  it('presents the payload wording when the payload supplied one', () => {
    expect(
      absenceAssertion({
        resourceType: 'MedicationStatement',
        medicationCodeableConcept: {
          coding: [
            {
              system: 'http://snomed.info/sct',
              code: '1234391000168107',
              display: 'No known current medicines',
            },
          ],
        },
      })?.text,
    ).toBe('No known current medicines');
  });

  it('will not read an allergy absence code as an absence on the wrong type', () => {
    expect(
      absenceAssertion({
        resourceType: 'Condition',
        code: { coding: [{ system: 'http://snomed.info/sct', code: '716186003' }] },
      }),
    ).toBeUndefined();
  });

  it('recognises an anchored text-only absence', () => {
    expect(
      absenceAssertion({
        resourceType: 'AllergyIntolerance',
        code: { text: 'No known drug allergies' },
      }),
    ).toMatchObject({ basis: 'text' });
  });

  it('does not read a real allergy as an absence', () => {
    expect(
      absenceAssertion({ resourceType: 'AllergyIntolerance', code: { text: 'Penicillin' } }),
    ).toBeUndefined();
  });
});

describe('sections', () => {
  it('identifies a section by its LOINC code, never by a display', () => {
    expect(
      sectionLoinc({ code: { coding: [{ system: 'http://loinc.org', code: '10160-0' }] } }),
    ).toBe('10160-0');
  });

  it('orders sections by the profile, not by the document', () => {
    const medications = { code: { coding: [{ system: 'http://loinc.org', code: '10160-0' }] } };
    const problems = { code: { coding: [{ system: 'http://loinc.org', code: '11450-4' }] } };
    expect(sectionSortKey(problems, 5)).toBeLessThan(sectionSortKey(medications, 0));
  });

  it('puts a section the profile does not name after every one it does', () => {
    const unknown = { code: { coding: [{ system: 'http://loinc.org', code: '99999-9' }] } };
    const vitals = { code: { coding: [{ system: 'http://loinc.org', code: '8716-3' }] } };
    expect(sectionSortKey(unknown, 0)).toBeGreaterThan(sectionSortKey(vitals, 20));
  });

  it('names a profile canonical it knows', () => {
    expect(profileName('http://hl7.org.au/fhir/ps/StructureDefinition/au-ps-composition')).toBe(
      'AU PS Composition',
    );
    expect(profileName('https://example.org/StructureDefinition/thing')).toBe('thing');
  });
});

describe('summariseResource', () => {
  it('names a resource by its concept', () => {
    expect(
      summariseResource({
        resourceType: 'Condition',
        code: { text: 'Type 2 diabetes' },
      }),
    ).toBe('Type 2 diabetes');
  });

  it('names an organisation by its name', () => {
    expect(summariseResource({ resourceType: 'Organization', name: 'Brisbane GP' })).toBe(
      'Brisbane GP',
    );
  });

  it('names a Platypus sample-data Device, which has no type', () => {
    expect(
      summariseResource({
        resourceType: 'Device',
        deviceName: [{ name: 'Sample Data', type: 'user-friendly-name' }],
      }),
    ).toBe('Sample Data');
  });

  it('counts what a Provenance covers rather than showing nothing', () => {
    expect(
      summariseResource({
        resourceType: 'Provenance',
        target: [{ reference: 'urn:uuid:a' }, { reference: 'urn:uuid:b' }],
      }),
    ).toBe('Provenance for 2 entries');
  });

  it('falls back to type and status', () => {
    expect(summariseResource({ resourceType: 'Task', status: 'requested' })).toBe(
      'Task, Requested',
    );
  });

  it('never throws on rubbish', () => {
    expect(summariseResource(null)).toBe('Not a FHIR resource');
    expect(summariseResource({ resourceType: 42 })).toBe('Resource with no resourceType');
  });
});

describe('sanitiseNarrativeHtml', () => {
  it('keeps the formatting a narrative is allowed to use', () => {
    const html =
      '<div xmlns="http://www.w3.org/1999/xhtml"><table><thead><tr><th>Medicine</th></tr></thead>' +
      '<tbody><tr><td colspan="2">Bisoprolol</td></tr></tbody></table></div>';
    const clean = sanitiseNarrativeHtml(html);
    expect(clean).toContain('<table>');
    expect(clean).toContain('<td colspan="2">Bisoprolol</td>');
    // xmlns is not in the allowlist, so it goes; the div survives.
    expect(clean).toContain('<div>');
    expect(clean).not.toContain('xmlns');
  });

  it('drops a script element and its contents', () => {
    expect(sanitiseNarrativeHtml('<p>Hi</p><script>alert(1)</script><p>There</p>')).toBe(
      '<p>Hi</p><p>There</p>',
    );
  });

  it('drops a style element and its contents', () => {
    expect(sanitiseNarrativeHtml('<style>body{display:none}</style><p>Hi</p>')).toBe('<p>Hi</p>');
  });

  it('strips every event handler attribute', () => {
    const clean = sanitiseNarrativeHtml('<div onmouseover="alert(1)" onclick="x()">Hi</div>');
    expect(clean).toBe('<div>Hi</div>');
  });

  it('drops an img with an onerror payload, tag and all', () => {
    const clean = sanitiseNarrativeHtml('<p>a<img src=x onerror=alert(1)>b</p>');
    expect(clean).toBe('<p>ab</p>');
  });

  it('refuses a javascript: href', () => {
    expect(sanitiseNarrativeHtml('<a href="javascript:alert(1)">click</a>')).toBe('<a>click</a>');
  });

  it('refuses an entity-encoded javascript: href, which a browser would decode', () => {
    expect(sanitiseNarrativeHtml('<a href="java&#115;cript:alert(1)">click</a>')).toBe(
      '<a>click</a>',
    );
    expect(sanitiseNarrativeHtml('<a href="&#106;avascript&colon;alert(1)">click</a>')).toBe(
      '<a>click</a>',
    );
  });

  it('refuses a javascript: href broken by control characters', () => {
    expect(sanitiseNarrativeHtml('<a href="java\tscript:alert(1)">click</a>')).toBe('<a>click</a>');
    expect(sanitiseNarrativeHtml('<a href=" JaVaScRiPt:alert(1)">click</a>')).toBe('<a>click</a>');
  });

  it('refuses a data: href, which can carry a whole document', () => {
    expect(sanitiseNarrativeHtml('<a href="data:text/html;base64,PHNjcmlwdD4=">click</a>')).toBe(
      '<a>click</a>',
    );
  });

  it('keeps an ordinary link', () => {
    expect(sanitiseNarrativeHtml('<a href="https://example.org/x?a=1&amp;b=2">x</a>')).toBe(
      '<a href="https://example.org/x?a=1&amp;b=2">x</a>',
    );
  });

  it('escapes a stray angle bracket instead of resuming tag parsing at it', () => {
    expect(sanitiseNarrativeHtml('5 < 6 and 7 > 6')).toBe('5 &lt; 6 and 7 &gt; 6');
  });

  it('closes tags the payload left open', () => {
    expect(sanitiseNarrativeHtml('<div><p>unclosed')).toBe('<div><p>unclosed</p></div>');
  });

  it('closes inner tags when an outer one closes first', () => {
    expect(sanitiseNarrativeHtml('<div><b>bold</div>after')).toBe('<div><b>bold</b></div>after');
  });

  it('does not let a malformed tag smuggle an attribute through', () => {
    expect(sanitiseNarrativeHtml('<p/onclick=alert(1)>hi</p>')).toBe('<p>hi</p>');
  });

  it('drops a comment, including a conditional one', () => {
    expect(
      sanitiseNarrativeHtml('<p>a</p><!--[if IE]><script>x</script><![endif]--><p>b</p>'),
    ).toBe('<p>a</p><p>b</p>');
  });

  it('drops an svg subtree, which can carry script of its own', () => {
    expect(sanitiseNarrativeHtml('<p>a</p><svg><script>alert(1)</script></svg><p>b</p>')).toBe(
      '<p>a</p><p>b</p>',
    );
  });

  it('drops a form and its inputs', () => {
    expect(
      sanitiseNarrativeHtml('<form action="https://evil.example"><input name="p"></form><p>a</p>'),
    ).toBe('<p>a</p>');
  });

  it('keeps an unknown wrapper element out but keeps the clinical text inside it', () => {
    expect(sanitiseNarrativeHtml('<article><p>Real content</p></article>')).toBe(
      '<p>Real content</p>',
    );
  });

  it('rejects a non-numeric colspan', () => {
    expect(sanitiseNarrativeHtml('<td colspan="x&quot; onclick=&quot;y">a</td>')).toBe(
      '<td>a</td>',
    );
  });

  it('emits void elements as self-closing', () => {
    expect(sanitiseNarrativeHtml('a<br>b<hr/>c')).toBe('a<br />b<hr />c');
  });

  it('leaves an existing entity alone rather than double-escaping it', () => {
    expect(sanitiseNarrativeHtml('Smith &amp; Jones &#169; 2026')).toBe(
      'Smith &amp; Jones &#169; 2026',
    );
    expect(sanitiseNarrativeHtml('100% & rising')).toBe('100% &amp; rising');
  });
});

describe('narrative reading', () => {
  it('extracts plain text for the non-whitespace check', () => {
    expect(narrativeTextContent('<div><p>No information available.</p></div>')).toBe(
      'No information available.',
    );
    expect(narrativeTextContent('<div>  </div>')).toBe('');
  });

  it('counts data rows without counting the header row', () => {
    const html =
      '<table><thead><tr><th>Medicine</th></tr></thead><tbody>' +
      '<tr><td>a</td></tr><tr><td>b</td></tr></tbody></table>';
    expect(narrativeRowCount(html)).toBe(2);
  });

  it('counts list items when the narrative is a list', () => {
    expect(narrativeRowCount('<ul><li>a</li><li>b</li><li>c</li></ul>')).toBe(3);
  });
});
