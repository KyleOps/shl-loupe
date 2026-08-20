/**
 * FHIR display primitives: pure, tested, and deliberately pessimistic.
 *
 * Everything here takes `unknown`. That is not defensive style for its own sake:
 * the input is a decrypted payload from a party we have never met, so a field
 * the specification says is a string may be a number, an object, or absent, and
 * a renderer that assumes otherwise blanks the page for one bad character. Every
 * reader below narrows at runtime and returns `undefined` rather than throwing.
 *
 * Two rules run through the whole file:
 *
 *  1. Never invent a display for a code we do not have. A `CodeableConcept` with
 *     no `text` and no `coding.display` renders as `system#code`, never as a bare
 *     code and never as a guessed English label. Guessing is how a viewer comes
 *     to show "No known allergy" as if it were an allergy.
 *  2. Never destroy the wire format. Every human-facing date, code and quantity
 *     keeps the verbatim source value alongside it, because this is a debugger
 *     and the argument at the table is usually about the exact bytes.
 */

// ---------------------------------------------------------------------------
// Narrowing
// ---------------------------------------------------------------------------

/** A FHIR resource or datatype as it arrives: an object of unknown fields. */
export type FhirNode = Record<string, unknown>;

export function asRecord(value: unknown): FhirNode | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as FhirNode)
    : undefined;
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/**
 * Any FHIR element with `0..*` cardinality may arrive as a bare object from a
 * producer that collapsed a single-item array, so a single object is treated as
 * a one-item list rather than skipped.
 */
export function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

export function field(node: unknown, key: string): unknown {
  return asRecord(node)?.[key];
}

export function strField(node: unknown, key: string): string | undefined {
  return asString(field(node, key));
}

export function numField(node: unknown, key: string): number | undefined {
  return asNumber(field(node, key));
}

export function recField(node: unknown, key: string): FhirNode | undefined {
  return asRecord(field(node, key));
}

export function arrField(node: unknown, key: string): unknown[] {
  return asArray(field(node, key));
}

export function resourceTypeOf(value: unknown): string | undefined {
  return strField(value, 'resourceType');
}

/**
 * Find a choice element (`effective[x]`, `onset[x]`, `value[x]`) without knowing
 * which suffix the producer used. Returning the suffix as well as the value
 * matters: `valueQuantity` and `valueString` are different facts, and a debugger
 * has to be able to say which one arrived.
 */
export function pickChoice(
  node: unknown,
  base: string,
): { key: string; suffix: string; value: unknown } | undefined {
  const record = asRecord(node);
  if (record === undefined) return undefined;
  for (const key of Object.keys(record)) {
    if (!key.startsWith(base) || key.length === base.length) continue;
    const suffix = key.slice(base.length);
    // The suffix must be an actual R4 datatype name, not merely capitalised.
    // `Questionnaire.item.answerValueSet` sits beside `answer[x]` and would
    // otherwise be read as a choice element whose type is "Set".
    if (!CHOICE_SUFFIXES.has(suffix)) continue;
    const value = record[key];
    if (value === undefined || value === null) continue;
    return { key, suffix, value };
  }
  return undefined;
}

/**
 * The datatype names a `[x]` choice element can take, as of R4. A closed set
 * rather than a shape guess, because the alternative (any capitalised suffix)
 * matches sibling elements that are not choices at all.
 */
const CHOICE_SUFFIXES = new Set([
  'Base64Binary',
  'Boolean',
  'Canonical',
  'Code',
  'Date',
  'DateTime',
  'Decimal',
  'Id',
  'Instant',
  'Integer',
  'Markdown',
  'Oid',
  'PositiveInt',
  'String',
  'Time',
  'UnsignedInt',
  'Uri',
  'Url',
  'Uuid',
  'Address',
  'Age',
  'Annotation',
  'Attachment',
  'CodeableConcept',
  'CodeableReference',
  'Coding',
  'ContactDetail',
  'ContactPoint',
  'Contributor',
  'Count',
  'DataRequirement',
  'Distance',
  'Dosage',
  'Duration',
  'Expression',
  'HumanName',
  'Identifier',
  'Meta',
  'Money',
  'ParameterDefinition',
  'Period',
  'Quantity',
  'Range',
  'Ratio',
  'Reference',
  'RelatedArtifact',
  'SampledData',
  'Signature',
  'SimpleQuantity',
  'Timing',
  'TriggerDefinition',
  'UsageContext',
]);

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

export type DatePrecision = 'none' | 'year' | 'month' | 'day' | 'time';

export type DateShape =
  | 'dateTime'
  | 'period'
  | 'timing'
  | 'age'
  | 'range'
  | 'string'
  | 'unparsed';

export interface RenderableDate {
  /** Human form, never more precise than the source was. */
  text: string;
  /** The source value verbatim, for the tooltip and the copy value. */
  raw: string;
  precision: DatePrecision;
  shape: DateShape;
  /** Set when the value is well formed but says something worth flagging. */
  note?: string;
}

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

const FHIR_DATE_TIME =
  /^(\d{4})(?:-(\d{2})(?:-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:\d{2})?)?)?)?$/;

/**
 * Format a FHIR `date`, `dateTime` or `instant` by reading the string, not by
 * constructing a `Date`.
 *
 * A `Date` would silently shift the value into the reader's own time zone and
 * would invent a day for a year-only value, both of which are wrong in a tool
 * whose job is to report what the sender actually sent.
 */
export function formatDateValue(raw: string): RenderableDate {
  const match = FHIR_DATE_TIME.exec(raw.trim());
  if (match === null) {
    return { text: raw, raw, precision: 'none', shape: 'unparsed' };
  }
  const [, year, month, day, hour, minute, second, zone] = match;
  if (year === undefined) return { text: raw, raw, precision: 'none', shape: 'unparsed' };
  if (month === undefined) return { text: year, raw, precision: 'year', shape: 'dateTime' };
  const monthName = MONTHS[Number(month) - 1] ?? month;
  if (day === undefined) {
    return { text: `${monthName} ${year}`, raw, precision: 'month', shape: 'dateTime' };
  }
  const dayText = `${Number(day)} ${monthName} ${year}`;
  if (hour === undefined || minute === undefined) {
    return { text: dayText, raw, precision: 'day', shape: 'dateTime' };
  }
  const clock = second === undefined ? `${hour}:${minute}` : `${hour}:${minute}:${second}`;
  const suffix = zone === undefined ? '' : zone === 'Z' ? ' UTC' : ` ${zone}`;
  return {
    text: `${dayText}, ${clock}${suffix}`,
    raw,
    precision: 'time',
    shape: 'dateTime',
    ...(zone === undefined
      ? {
          note: 'This value carries a time of day but no time zone offset, which R4 requires on a dateTime that includes a time.',
        }
      : {}),
  };
}

/** A `Period` as one line, using "to" rather than a dash. */
export function periodText(value: unknown): string | undefined {
  const start = strField(value, 'start');
  const end = strField(value, 'end');
  if (start !== undefined && end !== undefined) {
    return `${formatDateValue(start).text} to ${formatDateValue(end).text}`;
  }
  if (start !== undefined) return `from ${formatDateValue(start).text}`;
  if (end !== undefined) return `until ${formatDateValue(end).text}`;
  return undefined;
}

/**
 * The `dateTime` / `Period` / `Timing` choice, plus the `Age`, `Range` and
 * `string` forms the onset and abatement elements also allow, resolved to one
 * renderable value.
 *
 * The reference viewer calls its equivalent `renderCrazyDateTime`, and the name
 * is earned: six datatypes can occupy one logical "when" slot, and a renderer
 * that handles only the first shows nothing at all for the rest.
 */
export function renderableDate(value: unknown): RenderableDate | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return undefined;
    const parsed = formatDateValue(trimmed);
    if (parsed.shape === 'unparsed') {
      return { text: trimmed, raw: trimmed, precision: 'none', shape: 'string' };
    }
    return parsed;
  }
  const record = asRecord(value);
  if (record === undefined) return undefined;

  if ('start' in record || 'end' in record) {
    const text = periodText(record);
    if (text === undefined) return undefined;
    return { text, raw: JSON.stringify(record), precision: 'day', shape: 'period' };
  }

  if ('low' in record || 'high' in record) {
    const text = rangeText(record);
    if (text === undefined) return undefined;
    return { text, raw: JSON.stringify(record), precision: 'none', shape: 'range' };
  }

  // An Age is tested before a Timing because both carry `code`, and an Age of 54
  // years would otherwise be read as a Timing whose code is the UCUM unit.
  if (asNumber(record['value']) !== undefined) {
    const text = quantityText(record);
    if (text === undefined) return undefined;
    return { text, raw: JSON.stringify(record), precision: 'none', shape: 'age' };
  }

  if ('event' in record || 'repeat' in record || 'code' in record) {
    return timingDate(record);
  }
  return undefined;
}

function timingDate(record: FhirNode): RenderableDate | undefined {
  const events = arrField(record, 'event')
    .map((event) => asString(event))
    .filter((event): event is string => event !== undefined);
  const raw = JSON.stringify(record);
  if (events.length > 0) {
    const first = events[0] as string;
    const head = formatDateValue(first).text;
    const text = events.length === 1 ? head : `${head} and ${events.length - 1} more`;
    return { text, raw, precision: formatDateValue(first).precision, shape: 'timing' };
  }
  const bounds = periodText(field(recField(record, 'repeat'), 'boundsPeriod'));
  if (bounds !== undefined) return { text: bounds, raw, precision: 'day', shape: 'timing' };
  const schedule = timingScheduleText(record);
  if (schedule !== undefined) return { text: schedule, raw, precision: 'none', shape: 'timing' };
  const code = codeableConceptText(field(record, 'code'));
  if (code !== undefined) return { text: code, raw, precision: 'none', shape: 'timing' };
  return undefined;
}

const TIMING_UNITS: Record<string, string> = {
  s: 'second',
  min: 'minute',
  h: 'hour',
  d: 'day',
  wk: 'week',
  mo: 'month',
  a: 'year',
};

/** "twice a day", "every 8 hours": the readable half of `Timing.repeat`. */
export function timingScheduleText(value: unknown): string | undefined {
  const repeat = recField(value, 'repeat');
  if (repeat === undefined) return undefined;
  const frequency = numField(repeat, 'frequency');
  const period = numField(repeat, 'period');
  const unitCode = strField(repeat, 'periodUnit');
  const unit = unitCode === undefined ? undefined : (TIMING_UNITS[unitCode] ?? unitCode);
  const when = arrField(repeat, 'when')
    .map((entry) => asString(entry))
    .filter((entry): entry is string => entry !== undefined);
  const parts: string[] = [];
  if (frequency !== undefined && period !== undefined && unit !== undefined) {
    const times = frequency === 1 ? 'once' : frequency === 2 ? 'twice' : `${frequency} times`;
    parts.push(period === 1 ? `${times} a ${unit}` : `${times} every ${period} ${unit}s`);
  } else if (period !== undefined && unit !== undefined) {
    parts.push(period === 1 ? `every ${unit}` : `every ${period} ${unit}s`);
  } else if (frequency !== undefined) {
    parts.push(frequency === 1 ? 'once' : `${frequency} times`);
  }
  if (when.length > 0) parts.push(when.join(', '));
  const duration = numField(repeat, 'duration');
  const durationUnit = strField(repeat, 'durationUnit');
  if (duration !== undefined && durationUnit !== undefined) {
    parts.push(`over ${duration} ${TIMING_UNITS[durationUnit] ?? durationUnit}`);
  }
  return parts.length === 0 ? undefined : parts.join(', ');
}

// ---------------------------------------------------------------------------
// Codes
// ---------------------------------------------------------------------------

export interface CodeRef {
  system?: string;
  code: string;
  display?: string;
  version?: string;
  /** `LOINC 8716-3` style, for a mono chip. Falls back to the bare system URI. */
  label: string;
}

export interface ConceptDisplay {
  /** What a human reads. Never a bare code with no context. */
  text: string;
  codes: CodeRef[];
  /**
   * True when nothing carried a human label, so `text` is `system#code`. The UI
   * uses this to say so rather than implying the payload named the concept.
   */
  codeOnly: boolean;
  /** Where `text` came from, so a conformance note can name the element. */
  from: 'text' | 'display' | 'code';
}

const CODE_SYSTEM_NAMES: Record<string, string> = {
  'http://snomed.info/sct': 'SNOMED CT',
  'http://loinc.org': 'LOINC',
  'http://unitsofmeasure.org': 'UCUM',
  'http://www.nlm.nih.gov/research/umls/rxnorm': 'RxNorm',
  'http://hl7.org/fhir/sid/icd-10': 'ICD-10',
  'http://hl7.org/fhir/sid/icd-10-am': 'ICD-10-AM',
  'http://www.whocc.no/atc': 'ATC',
  'http://pbs.gov.au/code/item': 'PBS item',
  'http://terminology.hl7.org.au/CodeSystem/medication-type': 'AU medication type',
  'https://healthterminologies.gov.au/fhir/CodeSystem/australian-indigenous-status-1':
    'AU Indigenous status',
  'https://healthterminologies.gov.au/fhir/CodeSystem/ihi-status-1': 'IHI status',
  'https://healthterminologies.gov.au/fhir/CodeSystem/ihi-record-status-1': 'IHI record status',
};

/**
 * A short name for a code system, or the URI itself.
 *
 * Anything under `terminology.hl7.org/CodeSystem/` is named by its last segment,
 * which is both accurate and short: there are dozens of them in one AU PS bundle
 * and spelling each URI out in a chip destroys the column rhythm.
 */
export function codeSystemLabel(system: string | undefined): string | undefined {
  if (system === undefined) return undefined;
  const known = CODE_SYSTEM_NAMES[system];
  if (known !== undefined) return known;
  const hl7 = /^https?:\/\/terminology\.hl7\.org(?:\.au)?\/CodeSystem\/(.+)$/.exec(system);
  if (hl7?.[1] !== undefined) return hl7[1];
  const fhir = /^https?:\/\/hl7\.org\/fhir\/(?:sid\/)?([a-z0-9-]+)$/.exec(system);
  if (fhir?.[1] !== undefined) return fhir[1];
  return system;
}

export function codingRef(value: unknown): CodeRef | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const code = strField(record, 'code');
  if (code === undefined) return undefined;
  const system = strField(record, 'system');
  const display = strField(record, 'display');
  const version = strField(record, 'version');
  const systemName = codeSystemLabel(system);
  return {
    ...(system === undefined ? {} : { system }),
    code,
    ...(display === undefined ? {} : { display }),
    ...(version === undefined ? {} : { version }),
    label: systemName === undefined ? code : `${systemName} ${code}`,
  };
}

/**
 * A `CodeableConcept` resolved to one line plus its codes.
 *
 * Order is fixed by the specification's own intent: `text` is "a human language
 * representation of the concept as seen/selected/uttered by the user", so it
 * wins; then the first coding that carries a `display`; then `system#code`,
 * which is honest rather than pretty. A bare code with no system is the one
 * thing this never emits alone, because "160245001" on its own tells a reader
 * standing at a table nothing at all.
 */
export function codeableConcept(value: unknown): ConceptDisplay | undefined {
  const record = asRecord(value);
  if (record === undefined) {
    // A `code` primitive arriving where a CodeableConcept was expected is common
    // in hand-built payloads, and showing it beats showing nothing.
    const bare = asString(value);
    return bare === undefined
      ? undefined
      : { text: codeToWords(bare), codes: [], codeOnly: false, from: 'code' };
  }
  const codes = arrField(record, 'coding')
    .map((coding) => codingRef(coding))
    .filter((coding): coding is CodeRef => coding !== undefined);
  const text = strField(record, 'text');
  if (text !== undefined) return { text, codes, codeOnly: false, from: 'text' };
  const withDisplay = codes.find((code) => code.display !== undefined);
  if (withDisplay?.display !== undefined) {
    return { text: withDisplay.display, codes, codeOnly: false, from: 'display' };
  }
  const first = codes[0];
  if (first !== undefined) {
    return {
      text: first.system === undefined ? first.code : `${first.system}#${first.code}`,
      codes,
      codeOnly: true,
      from: 'code',
    };
  }
  return undefined;
}

export function codeableConceptText(value: unknown): string | undefined {
  return codeableConcept(value)?.text;
}

/** Every concept in a `0..*` element, in order, skipping the unreadable ones. */
export function codeableConcepts(value: unknown): ConceptDisplay[] {
  return asArray(value)
    .map((entry) => codeableConcept(entry))
    .filter((entry): entry is ConceptDisplay => entry !== undefined);
}

/**
 * `entered-in-error` to "Entered in error".
 *
 * Applied only to FHIR `code` values, which are a closed kebab-case vocabulary.
 * It is never applied to a terminology code, where re-casing would be inventing
 * a display.
 */
export function codeToWords(code: string): string {
  if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(code)) return code;
  const words = code.split('-').join(' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// ---------------------------------------------------------------------------
// Quantities
// ---------------------------------------------------------------------------

const COMPARATORS: Record<string, string> = {
  '<': 'less than',
  '<=': 'at most',
  '>=': 'at least',
  '>': 'more than',
};

/**
 * `Quantity`, `Age`, `Duration`, `Count` and `SimpleQuantity` all render here.
 * `unit` is the sender's own wording and wins over `code`; when only `code` is
 * present it is shown as-is, because a UCUM code is not a word we may reword.
 */
export function quantityText(value: unknown): string | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const amount = numField(record, 'value');
  const unit = strField(record, 'unit') ?? strField(record, 'code');
  const comparatorCode = strField(record, 'comparator');
  const comparator = comparatorCode === undefined ? undefined : COMPARATORS[comparatorCode];
  if (amount === undefined) {
    if (unit === undefined) return undefined;
    return comparator === undefined ? unit : `${comparator} ${unit}`;
  }
  const head = comparator === undefined ? `${amount}` : `${comparator} ${amount}`;
  return unit === undefined ? head : `${head} ${unit}`;
}

/**
 * A note for the tooltip when the human unit and the UCUM code disagree, which
 * is where unit-conversion bugs hide.
 */
export function ucumNote(value: unknown): string | undefined {
  const unit = strField(value, 'unit');
  const code = strField(value, 'code');
  const system = strField(value, 'system');
  if (code === undefined) return undefined;
  if (unit !== undefined && unit === code) return undefined;
  const systemName = codeSystemLabel(system) ?? 'unstated system';
  return `Coded as ${code} (${systemName})`;
}

export function rangeText(value: unknown): string | undefined {
  const low = quantityText(field(value, 'low'));
  const high = quantityText(field(value, 'high'));
  if (low !== undefined && high !== undefined) return `${low} to ${high}`;
  if (low !== undefined) return `from ${low}`;
  if (high !== undefined) return `up to ${high}`;
  return undefined;
}

export function ratioText(value: unknown): string | undefined {
  const numerator = quantityText(field(value, 'numerator'));
  const denominator = asRecord(field(value, 'denominator'));
  if (numerator === undefined) return undefined;
  if (denominator === undefined) return numerator;
  const amount = numField(denominator, 'value');
  const unit = strField(denominator, 'unit') ?? strField(denominator, 'code');
  // "5 mg per mL" reads better than "5 mg per 1 mL", and the two mean the same.
  if (amount === 1 && unit !== undefined) return `${numerator} per ${unit}`;
  const bottom = quantityText(denominator);
  return bottom === undefined ? numerator : `${numerator} per ${bottom}`;
}

// ---------------------------------------------------------------------------
// Dosage
// ---------------------------------------------------------------------------

/**
 * A `Dosage` as one readable line.
 *
 * `Dosage.text` is preferred whole and verbatim when present: it is the
 * prescriber's own sig, and recomposing it from the structured parts is how a
 * viewer ends up displaying a dose the prescriber never wrote.
 */
export function dosageText(value: unknown): string | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const text = strField(record, 'text');
  if (text !== undefined) return text;

  const parts: string[] = [];
  const dose = arrField(record, 'doseAndRate')
    .map((entry) => {
      const chosen = pickChoice(entry, 'dose');
      if (chosen === undefined) return undefined;
      return chosen.suffix === 'Range'
        ? rangeText(chosen.value)
        : quantityText(chosen.value);
    })
    .find((entry): entry is string => entry !== undefined);
  if (dose !== undefined) parts.push(dose);

  // A Dosage carries its schedule in a `timing` member; a Timing carries it at
  // the top level. Reading the wrong one loses every frequency in the payload.
  const schedule = timingScheduleText(field(record, 'timing'));
  if (schedule !== undefined) parts.push(schedule);

  const asNeeded = asBoolean(field(record, 'asNeededBoolean'));
  const asNeededFor = codeableConceptText(field(record, 'asNeededCodeableConcept'));
  if (asNeededFor !== undefined) parts.push(`as needed for ${asNeededFor}`);
  else if (asNeeded === true) parts.push('as needed');

  const route = codeableConceptText(field(record, 'route'));
  if (route !== undefined) parts.push(route);
  const site = codeableConceptText(field(record, 'site'));
  if (site !== undefined) parts.push(site);
  const method = codeableConceptText(field(record, 'method'));
  if (method !== undefined) parts.push(method);

  const instruction = codeableConceptText(field(record, 'additionalInstruction'));
  if (instruction !== undefined) parts.push(instruction);
  const patientInstruction = strField(record, 'patientInstruction');
  if (patientInstruction !== undefined) parts.push(patientInstruction);

  return parts.length === 0 ? undefined : parts.join(', ');
}

// ---------------------------------------------------------------------------
// People, places, identifiers
// ---------------------------------------------------------------------------

/** A `HumanName` as one line. `text` wins, because the sender wrote it. */
export function humanName(value: unknown): string | undefined {
  const record = asRecord(value);
  if (record === undefined) return asString(value);
  const text = strField(record, 'text');
  if (text !== undefined) return text;
  const parts = [
    ...arrField(record, 'prefix'),
    ...arrField(record, 'given'),
    ...(strField(record, 'family') === undefined ? [] : [strField(record, 'family')]),
    ...arrField(record, 'suffix'),
  ]
    .map((part) => asString(part))
    .filter((part): part is string => part !== undefined);
  return parts.length === 0 ? undefined : parts.join(' ');
}

/**
 * The best name among several, preferring `use: official` then `usual`.
 *
 * A resource carrying an `old` name first (common after a name change) would
 * otherwise be labelled with the name the patient no longer uses.
 */
export function bestHumanName(value: unknown): string | undefined {
  const names = asArray(value);
  const ranked = [...names].sort((a, b) => nameRank(a) - nameRank(b));
  for (const name of ranked) {
    const text = humanName(name);
    if (text !== undefined) return text;
  }
  return undefined;
}

function nameRank(value: unknown): number {
  const use = strField(value, 'use');
  switch (use) {
    case 'official':
      return 0;
    case 'usual':
      return 1;
    case undefined:
      return 2;
    case 'old':
      return 9;
    default:
      return 3;
  }
}

export function addressLine(value: unknown): string | undefined {
  const record = asRecord(value);
  if (record === undefined) return asString(value);
  const text = strField(record, 'text');
  if (text !== undefined) return text;
  const parts = [
    ...arrField(record, 'line').map((line) => asString(line)),
    strField(record, 'city'),
    strField(record, 'district'),
    strField(record, 'state'),
    strField(record, 'postalCode'),
    strField(record, 'country'),
  ].filter((part): part is string => part !== undefined);
  return parts.length === 0 ? undefined : parts.join(', ');
}

const IDENTIFIER_SYSTEMS: Record<string, string> = {
  'http://ns.electronichealth.net.au/id/hi/ihi/1.0': 'IHI',
  'http://ns.electronichealth.net.au/id/hi/hpii/1.0': 'HPI-I',
  'http://ns.electronichealth.net.au/id/hi/hpio/1.0': 'HPI-O',
  'http://ns.electronichealth.net.au/id/medicare-number': 'Medicare number',
  'http://ns.electronichealth.net.au/id/dva': 'DVA number',
  'http://hl7.org.au/id/medicare-provider-number': 'Medicare provider number',
  'http://hl7.org.au/id/dva': 'DVA number',
  'http://hl7.org.au/id/pbs-prescriber-number': 'PBS prescriber number',
  'http://hl7.org.au/id/abn': 'ABN',
  'urn:ietf:rfc:3986': 'URI',
  'urn:ietf:rfc:4122': 'UUID',
  'urn:oid:1.2.36.1.2001.1003.0': 'HPI-O (OID form)',
};

/**
 * A human label for an identifier system.
 *
 * The Australian national identifiers are named because they are the ones a
 * clinician reads out loud, and because an unlabelled IHI is indistinguishable
 * from a random 16-digit number.
 */
export function identifierSystemLabel(system: string | undefined): string | undefined {
  if (system === undefined) return undefined;
  return IDENTIFIER_SYSTEMS[system] ?? codeSystemLabel(system);
}

export interface IdentifierDisplay {
  label: string;
  value: string;
  system?: string;
  use?: string;
  typeText?: string;
}

export function identifier(value: unknown): IdentifierDisplay | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const raw = strField(record, 'value');
  const system = strField(record, 'system');
  const typeText = codeableConceptText(field(record, 'type'));
  if (raw === undefined) {
    // An identifier with a system and no value is a real and confusing shape:
    // say so rather than dropping the row.
    if (system === undefined) return undefined;
    return {
      label: identifierSystemLabel(system) ?? system,
      value: '(no value)',
      system,
      ...(typeText === undefined ? {} : { typeText }),
    };
  }
  const use = strField(record, 'use');
  return {
    label: identifierSystemLabel(system) ?? typeText ?? 'Identifier',
    value: raw,
    ...(system === undefined ? {} : { system }),
    ...(use === undefined ? {} : { use }),
    ...(typeText === undefined ? {} : { typeText }),
  };
}

export function identifierText(value: unknown): string | undefined {
  const parsed = identifier(value);
  return parsed === undefined ? undefined : `${parsed.label} ${parsed.value}`;
}

/**
 * Shorten a `urn:uuid:` or long opaque value for a key/value column, keeping
 * enough of both ends to be recognisable. The caller always pairs this with a
 * copy button carrying the full value: truncating without one would make the
 * tool useless for the argument it exists to settle.
 */
export function shortenUrn(value: string, keep = 4): string {
  const urn = /^(urn:uuid:)([0-9a-fA-F-]{20,})$/.exec(value);
  if (urn?.[1] !== undefined && urn[2] !== undefined) {
    const id = urn[2];
    return `${urn[1]}${id.slice(0, keep + 4)}…${id.slice(-keep)}`;
  }
  if (value.length <= 40) return value;
  return `${value.slice(0, 24)}…${value.slice(-8)}`;
}

/**
 * The label for a `Reference` on its own, with no bundle to resolve against.
 *
 * `Reference.display` exists in the specification precisely for "applications
 * unable to resolve references", so it is preferred over the URI. The URI is
 * shown shortened when there is nothing else, and an identifier-only reference
 * (legal, and used by AU eRequesting) falls back to that.
 */
export function referenceLabel(value: unknown): string | undefined {
  const record = asRecord(value);
  if (record === undefined) return asString(value);
  const display = strField(record, 'display');
  if (display !== undefined) return display;
  const reference = strField(record, 'reference');
  if (reference !== undefined) return shortenUrn(reference);
  const ident = identifierText(field(record, 'identifier'));
  if (ident !== undefined) return ident;
  const type = strField(record, 'type');
  return type === undefined ? undefined : `A ${type}, named only by type`;
}

export function annotationText(value: unknown): { text: string; caption?: string } | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const text = strField(record, 'text');
  if (text === undefined) return undefined;
  const author =
    referenceLabel(field(record, 'authorReference')) ?? strField(record, 'authorString');
  const time = strField(record, 'time');
  const captionParts = [author, time === undefined ? undefined : formatDateValue(time).text].filter(
    (part): part is string => part !== undefined,
  );
  return {
    text,
    ...(captionParts.length === 0 ? {} : { caption: captionParts.join(', ') }),
  };
}

// ---------------------------------------------------------------------------
// Absence: an empty element and a stated absence are different facts
// ---------------------------------------------------------------------------

export const DATA_ABSENT_REASON_URL =
  'http://hl7.org/fhir/StructureDefinition/data-absent-reason';

/**
 * Read a primitive extension's `data-absent-reason`.
 *
 * The value lives in the `_`-prefixed sibling key (`_effectiveDateTime`), not in
 * the element, so a renderer that walks named fields drops it silently. AU PS
 * raises elements AU Core leaves optional, so this extension is the *conformant*
 * answer for a source that did not supply the value, and it must not render as
 * a blank cell.
 */
export function primitiveAbsentReason(node: unknown, element: string): string | undefined {
  const sibling = recField(node, `_${element}`);
  if (sibling === undefined) return undefined;
  for (const extension of arrField(sibling, 'extension')) {
    if (strField(extension, 'url') !== DATA_ABSENT_REASON_URL) continue;
    const code = strField(extension, 'valueCode');
    if (code !== undefined) return code;
  }
  return undefined;
}

/** The same reason carried as an ordinary extension on a complex element. */
export function elementAbsentReason(node: unknown): string | undefined {
  for (const extension of arrField(node, 'extension')) {
    if (strField(extension, 'url') !== DATA_ABSENT_REASON_URL) continue;
    const code = strField(extension, 'valueCode');
    if (code !== undefined) return code;
  }
  return undefined;
}

/**
 * SNOMED CT concepts that state an absence, keyed by the resource type they may
 * legally appear on.
 *
 * Scoping by resource type is not tidiness: a code read as an absence for the
 * wrong section is how "No known allergy" ends up displayed as a medication.
 * The lists are Platypus's written and recognised sets, which are the ones these
 * events will carry.
 */

/**
 * The IPS absent-and-unknown code system, read from the published CodeSystem
 * (http://hl7.org/fhir/uv/ips/CodeSystem/absent-unknown-uv-ips, version 1.1.0)
 * rather than from memory.
 *
 * This exists because a SNOMED-only check misses the way the International
 * Patient Summary actually says it, including in the IG's own example bundle,
 * where the resource then renders as a bare system#code URL. That is the exact
 * shape of the failure this module is meant to prevent.
 *
 * The `no-*-info` codes carry the opposite meaning to the `no-known-*` ones and
 * are deliberately kept apart: see AbsenceStatement.meaning.
 */
const IPS_ABSENT_SYSTEM = 'http://hl7.org/fhir/uv/ips/CodeSystem/absent-unknown-uv-ips';

const IPS_ABSENT_CODES: Record<string, { text: string; meaning: AbsenceStatement['meaning'] }> = {
  'no-allergy-info': { text: 'No information about allergies', meaning: 'no-information' },
  'no-known-allergies': { text: 'No known allergies', meaning: 'asserted-none' },
  'no-device-info': { text: 'No information about devices', meaning: 'no-information' },
  'no-known-devices': { text: 'No known devices in use', meaning: 'asserted-none' },
  'no-immunization-info': { text: 'No information about immunizations', meaning: 'no-information' },
  'no-known-immunizations': { text: 'No known immunizations', meaning: 'asserted-none' },
  'no-medication-info': { text: 'No information about medications', meaning: 'no-information' },
  'no-known-medications': { text: 'No known medications', meaning: 'asserted-none' },
  'no-problem-info': { text: 'No information about problems', meaning: 'no-information' },
  'no-known-problems': { text: 'No known problems', meaning: 'asserted-none' },
  'no-procedure-info': {
    text: 'No information about past history of procedures',
    meaning: 'no-information',
  },
  'no-known-procedures': { text: 'No known procedures', meaning: 'asserted-none' },
};

/**
 * Codes that appear in real payloads, including the IPS IG's own example bundle,
 * and are NOT in version 1.1.0 of the code system. They are recognised anyway,
 * because refusing to read a payload the specification itself publishes makes
 * this tool the thing that is wrong, and reported, because a producer sending
 * one is sending a code no current terminology server will validate.
 */
const IPS_ABSENT_RETIRED_CODES: Record<string, string> = {
  'no-known-food-allergies': 'No known food allergies',
  'no-known-medication-allergies': 'No known medication allergies',
  'no-known-environmental-allergies': 'No known environmental allergies',
};

const ABSENCE_CODES: Record<string, Record<string, string>> = {
  AllergyIntolerance: {
    '716186003': 'No known allergies',
    '409137002': 'No known drug allergy',
    '429625007': 'No known food allergy',
    '428607008': 'No known environmental allergy',
    '428197003': 'No known latex allergy',
    '716220001': 'No known allergy to eggs',
    '1003774007': 'No known allergy to peanut',
    '160244002': 'No known allergies',
  },
  MedicationStatement: {
    '787481004': 'No known medications',
    '1234391000168107': 'No known current medicines',
  },
  Condition: {
    '160245001': 'No current problems or disability',
  },
  Procedure: {
    '787480003': 'No known procedures',
  },
};

const ABSENCE_TEXT: Record<string, RegExp> = {
  AllergyIntolerance: /^no known (drug |food |environmental |latex |medication )?allerg/i,
  MedicationStatement: /^no (known )?(current )?(medication|medicine)/i,
  Condition: /^no (known )?(current )?(problem|condition)/i,
  Procedure: /^no (known )?procedure/i,
};

export interface AbsenceStatement {
  /** The wording to show, taken from the payload where it supplied one. */
  text: string;
  /** How we recognised it, so the UI can say the source stated this explicitly. */
  basis: 'code' | 'text';
  code?: string;
  /**
   * The distinction the whole absence contract turns on.
   *
   * `asserted-none` is a positive clinical statement: somebody asked and the
   * answer was none. `no-information` says only that nobody asked, which is the
   * same information an empty section carries and must not be rendered as though
   * it were a clean bill of health. The IPS code system names both, and a viewer
   * that collapses them into "None" tells the reader something nobody said.
   */
  meaning: 'asserted-none' | 'no-information';
  /** Set when the code is not in the current version of its code system. */
  deprecatedCode?: string;
}

/**
 * Recognise a resource that asserts an absence rather than recording a finding.
 *
 * A patient with no allergies and a patient nobody asked are different facts,
 * and the positive statement arrives as a normal resource of the section's own
 * type carrying a negation concept, never as a flag and never as an empty
 * section. Rendering one as an ordinary row is the classic viewer bug: it shows
 * "No known allergy" as though the patient were allergic to something with that
 * name.
 */
export function absenceAssertion(resource: unknown): AbsenceStatement | undefined {
  const type = resourceTypeOf(resource);
  if (type === undefined) return undefined;
  const concept =
    field(resource, 'code') ?? field(resource, 'medicationCodeableConcept') ?? undefined;
  const parsed = codeableConcept(concept);

  // The IPS code system first, and independently of the resource type: it is
  // keyed by what is absent rather than by which resource carries the statement,
  // and it is checked for every type because a producer may hang
  // "no-known-medications" on a MedicationStatement or a List.
  for (const code of parsed?.codes ?? []) {
    if (code.system !== IPS_ABSENT_SYSTEM) continue;
    const current = IPS_ABSENT_CODES[code.code];
    if (current !== undefined) {
      return {
        text: code.display ?? current.text,
        basis: 'code',
        code: code.code,
        meaning: current.meaning,
      };
    }
    const retired = IPS_ABSENT_RETIRED_CODES[code.code];
    if (retired !== undefined) {
      return {
        text: code.display ?? retired,
        basis: 'code',
        code: code.code,
        meaning: 'asserted-none',
        deprecatedCode: `"${code.code}" is not in version 1.1.0 of the IPS absent-and-unknown code system, so a terminology-aware validator will reject it. It is read here because the IPS implementation guide's own example bundle still uses it.`,
      };
    }
  }

  const codes = ABSENCE_CODES[type];
  if (codes === undefined) return undefined;
  for (const code of parsed?.codes ?? []) {
    if (code.system !== 'http://snomed.info/sct') continue;
    const known = codes[code.code];
    if (known === undefined) continue;
    // Every SNOMED code in that table is a positive "none" assertion; the
    // "no information" sense has no SNOMED equivalent in use here.
    return { text: code.display ?? known, basis: 'code', code: code.code, meaning: 'asserted-none' };
  }
  const pattern = ABSENCE_TEXT[type];
  if (parsed !== undefined && pattern !== undefined && pattern.test(parsed.text)) {
    // Recognised from wording alone, so the claim is weaker: say so rather than
    // presenting a text match with the confidence of a coded assertion.
    return { text: parsed.text, basis: 'text', meaning: 'asserted-none' };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// The IPS / AU PS section set
// ---------------------------------------------------------------------------

export interface SectionSlice {
  /** The profile's own slice name, used only for ordering and for grouping. */
  slice: string;
  loinc: string;
  /**
   * The display LOINC itself publishes, where it has been verified against a
   * terminology server. Absent means we do not know it, and we do not guess:
   * three of the commonly written displays for these codes are wrong, all in
   * the same direction (a lab-style name read as a section heading).
   */
  verifiedDisplay?: string;
}

/** The sixteen IPS Composition slices, in the profile's own order. */
export const IPS_SECTIONS: readonly SectionSlice[] = [
  { slice: 'sectionProblems', loinc: '11450-4', verifiedDisplay: 'Problem list - Reported' },
  {
    slice: 'sectionAllergies',
    loinc: '48765-2',
    verifiedDisplay: 'Allergies and adverse reactions Document',
  },
  {
    slice: 'sectionMedications',
    loinc: '10160-0',
    verifiedDisplay: 'History of Medication use Narrative',
  },
  { slice: 'sectionImmunizations', loinc: '11369-6', verifiedDisplay: 'History of Immunization note' },
  {
    slice: 'sectionResults',
    loinc: '30954-2',
    verifiedDisplay: 'Relevant diagnostic tests/laboratory data note',
  },
  { slice: 'sectionProceduresHx', loinc: '47519-4', verifiedDisplay: 'History of Procedures Document' },
  { slice: 'sectionMedicalDevices', loinc: '46264-8' },
  { slice: 'sectionAdvanceDirectives', loinc: '42348-3' },
  { slice: 'sectionAlerts', loinc: '104605-1', verifiedDisplay: 'Alert' },
  { slice: 'sectionFunctionalStatus', loinc: '47420-5' },
  { slice: 'sectionPastProblems', loinc: '11348-0' },
  { slice: 'sectionPregnancyHx', loinc: '10162-6' },
  { slice: 'sectionPatientStory', loinc: '81338-6' },
  { slice: 'sectionPlanOfCare', loinc: '18776-5' },
  { slice: 'sectionSocialHistory', loinc: '29762-2' },
  { slice: 'sectionVitalSigns', loinc: '8716-3', verifiedDisplay: 'Vital signs note' },
];

const SECTION_BY_LOINC = new Map(IPS_SECTIONS.map((section) => [section.loinc, section]));

export function sectionSlice(loinc: string | undefined): SectionSlice | undefined {
  return loinc === undefined ? undefined : SECTION_BY_LOINC.get(loinc);
}

/**
 * The LOINC code a section is identified by. Identity comes from the code and
 * never from the display: Platypus writes section codings with no `display` at
 * all, so a viewer keying on the display renders nothing for its documents.
 */
export function sectionLoinc(section: unknown): string | undefined {
  for (const coding of arrField(field(section, 'code'), 'coding')) {
    if (strField(coding, 'system') !== 'http://loinc.org') continue;
    const code = strField(coding, 'code');
    if (code !== undefined) return code;
  }
  return undefined;
}

/**
 * Profile order first, document order for anything the profile does not name.
 * Two payloads from different vendors then look the same on screen, which is the
 * entire point of a comparison tool at a connectathon.
 */
export function sectionSortKey(section: unknown, documentIndex: number): number {
  const slice = sectionSlice(sectionLoinc(section));
  if (slice === undefined) return 1000 + documentIndex;
  return IPS_SECTIONS.indexOf(slice);
}

const PROFILE_NAMES: Record<string, string> = {
  'http://hl7.org/fhir/uv/ips/StructureDefinition/Bundle-uv-ips': 'IPS Bundle',
  'http://hl7.org/fhir/uv/ips/StructureDefinition/Composition-uv-ips': 'IPS Composition',
  'http://hl7.org/fhir/uv/ips/StructureDefinition/Patient-uv-ips': 'IPS Patient',
  'http://hl7.org.au/fhir/ps/StructureDefinition/au-ps-bundle': 'AU PS Bundle',
  'http://hl7.org.au/fhir/ps/StructureDefinition/au-ps-composition': 'AU PS Composition',
  'http://hl7.org.au/fhir/ps/StructureDefinition/au-ps-patient': 'AU PS Patient',
};

/** A short name for a profile canonical, or its own last segment. */
export function profileName(canonical: string): string {
  const known = PROFILE_NAMES[canonical];
  if (known !== undefined) return known;
  const tail = canonical.split('/').pop();
  return tail === undefined || tail === '' ? canonical : tail;
}

export function profilesOf(resource: unknown): string[] {
  return arrField(field(resource, 'meta'), 'profile')
    .map((profile) => asString(profile))
    .filter((profile): profile is string => profile !== undefined);
}

/** True when any claimed profile is an AU PS one, which tightens the checks. */
export function claimsAuPs(resource: unknown): boolean {
  return profilesOf(resource).some((profile) => profile.includes('hl7.org.au/fhir/ps'));
}

// ---------------------------------------------------------------------------
// A one-line summary for any resource
// ---------------------------------------------------------------------------

/**
 * The fields worth trying, in the order a clinician would read them. Derived,
 * not alphabetical: alphabetical order puts `abatementDateTime` above `code`,
 * which is how every generic FHIR renderer ends up looking machine-generated.
 */
const SUMMARY_CONCEPT_FIELDS = [
  'code',
  'medicationCodeableConcept',
  'vaccineCode',
  'type',
  'category',
  'activity',
  'serviceType',
  'reasonCode',
  'class',
];

const SUMMARY_TEXT_FIELDS = ['title', 'description', 'name'];

/**
 * One line naming a resource, for a row in a list of types nothing rendered.
 *
 * This is what stops an unhandled type reading as an absence. The incumbent
 * viewer logs a console warning and renders nothing, which is indistinguishable
 * from the server never having sent the resource.
 */
export function summariseResource(resource: unknown): string {
  const record = asRecord(resource);
  if (record === undefined) return 'Not a FHIR resource';
  const type = resourceTypeOf(record);

  const absence = absenceAssertion(record);
  if (absence !== undefined) return absence.text;

  const name = bestHumanName(field(record, 'name'));
  if (name !== undefined) return name;

  for (const key of SUMMARY_CONCEPT_FIELDS) {
    const value = field(record, key);
    const first = Array.isArray(value) ? value[0] : value;
    const text = codeableConceptText(first);
    if (text !== undefined) return text;
  }

  const medication = referenceLabel(field(record, 'medicationReference'));
  if (medication !== undefined) return medication;

  for (const key of SUMMARY_TEXT_FIELDS) {
    const text = strField(record, key);
    if (text !== undefined) return text;
  }

  const deviceName = strField(arrField(record, 'deviceName')[0], 'name');
  if (deviceName !== undefined) return deviceName;

  if (type === 'Provenance') {
    const targets = arrField(record, 'target').length;
    return `Provenance for ${targets} ${targets === 1 ? 'entry' : 'entries'}`;
  }

  const status = strField(record, 'status');
  if (status !== undefined) return `${type ?? 'Resource'}, ${codeToWords(status)}`;
  const id = strField(record, 'id');
  if (id !== undefined) return `${type ?? 'Resource'} ${id}`;
  return type ?? 'Resource with no resourceType';
}

// ---------------------------------------------------------------------------
// Narrative sanitisation
// ---------------------------------------------------------------------------

/**
 * The allowlist, matching the FHIR narrative invariant txt-1 ("only the basic
 * html formatting elements"), not a browser's idea of harmless.
 */
const ALLOWED_TAGS = new Set([
  'p',
  'div',
  'span',
  'br',
  'b',
  'i',
  'em',
  'strong',
  'u',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'th',
  'td',
  'ul',
  'ol',
  'li',
  'a',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'pre',
  'code',
  'hr',
  'sup',
  'sub',
]);

const VOID_TAGS = new Set(['br', 'hr']);

/**
 * Elements whose *content* goes with them. For everything else outside the
 * allowlist the tag is dropped and the children are kept, because an unknown
 * wrapper around real clinical text should not delete the text.
 */
const DROP_SUBTREE = new Set([
  'script',
  'style',
  'iframe',
  'object',
  'embed',
  'applet',
  'form',
  'input',
  'button',
  'select',
  'option',
  'textarea',
  'svg',
  'math',
  'template',
  'noscript',
  'frame',
  'frameset',
  'base',
  'link',
  'meta',
  'title',
  'head',
  'audio',
  'video',
  'canvas',
]);

const ALLOWED_ATTRS = new Set(['href', 'class', 'colspan', 'rowspan']);

const DANGEROUS_SCHEME = /^(javascript|vbscript|data|blob|file):/i;

interface ParsedTag {
  kind: 'open' | 'close' | 'ignore';
  name: string;
  attrs: Array<[string, string]>;
  selfClosing: boolean;
  end: number;
}

/**
 * Sanitise a `Narrative.div` for insertion.
 *
 * The design decision that matters: this **reserialises from a parse** rather
 * than stripping patterns out of the input. A stripper can always be defeated by
 * a payload the browser's own parser reads differently to the regex (the whole
 * mutation-XSS family), whereas an output built only from allowlisted tags and
 * attributes cannot carry through anything the allowlist does not name. The cost
 * is a small tokeniser; the benefit is that the failure mode is lost formatting
 * rather than executed script.
 *
 * String in, string out, with no DOM, so it is unit testable against real
 * attack payloads rather than only eyeballed in a browser.
 */
export function sanitiseNarrativeHtml(input: string): string {
  const out: string[] = [];
  const stack: string[] = [];
  let index = 0;

  while (index < input.length) {
    const lt = input.indexOf('<', index);
    if (lt === -1) {
      out.push(escapeText(input.slice(index)));
      break;
    }
    if (lt > index) out.push(escapeText(input.slice(index, lt)));

    const tag = parseTag(input, lt);
    if (tag === undefined) {
      // A bare "<" that is not a tag start is text, and it must be escaped or
      // the browser will resume tag parsing at it.
      out.push('&lt;');
      index = lt + 1;
      continue;
    }
    index = tag.end;

    if (tag.kind === 'ignore') continue;

    if (tag.kind === 'close') {
      const at = stack.lastIndexOf(tag.name);
      if (at !== -1) {
        for (let depth = stack.length - 1; depth >= at; depth -= 1) {
          out.push(`</${stack[depth] as string}>`);
        }
        stack.length = at;
      }
      continue;
    }

    if (DROP_SUBTREE.has(tag.name)) {
      index = skipSubtree(input, index, tag.name);
      continue;
    }
    if (!ALLOWED_TAGS.has(tag.name)) continue;

    const attrs = serialiseAttrs(tag.name, tag.attrs);
    if (VOID_TAGS.has(tag.name)) {
      out.push(`<${tag.name}${attrs} />`);
      continue;
    }
    if (tag.selfClosing) {
      out.push(`<${tag.name}${attrs}></${tag.name}>`);
      continue;
    }
    out.push(`<${tag.name}${attrs}>`);
    stack.push(tag.name);
  }

  while (stack.length > 0) out.push(`</${stack.pop() as string}>`);
  return out.join('');
}

function parseTag(input: string, start: number): ParsedTag | undefined {
  if (input.startsWith('<!--', start)) {
    const close = input.indexOf('-->', start + 4);
    return {
      kind: 'ignore',
      name: '',
      attrs: [],
      selfClosing: false,
      end: close === -1 ? input.length : close + 3,
    };
  }
  const second = input[start + 1];
  if (second === '!' || second === '?') {
    const close = input.indexOf('>', start);
    return {
      kind: 'ignore',
      name: '',
      attrs: [],
      selfClosing: false,
      end: close === -1 ? input.length : close + 1,
    };
  }
  const closing = second === '/';
  let cursor = start + (closing ? 2 : 1);
  const nameMatch = /^[A-Za-z][A-Za-z0-9]*/.exec(input.slice(cursor, cursor + 32));
  if (nameMatch === null) return undefined;
  const name = nameMatch[0].toLowerCase();
  cursor += nameMatch[0].length;

  const attrs: Array<[string, string]> = [];
  let selfClosing = false;
  while (cursor < input.length) {
    while (cursor < input.length && /\s/.test(input[cursor] as string)) cursor += 1;
    const char = input[cursor];
    if (char === undefined) break;
    if (char === '>') {
      cursor += 1;
      break;
    }
    if (char === '/') {
      // HTML5 ignores a solidus inside a start tag unless it sits immediately
      // before the '>'. Treating every '/' as self-closing would split
      // `<p/onclick=x>hi</p>` into an empty paragraph and orphaned text.
      if (input[cursor + 1] === '>') {
        selfClosing = true;
        cursor += 2;
        break;
      }
      cursor += 1;
      continue;
    }
    const attrName = /^[^\s=/>]+/.exec(input.slice(cursor));
    if (attrName === null) {
      cursor += 1;
      continue;
    }
    cursor += attrName[0].length;
    while (cursor < input.length && /\s/.test(input[cursor] as string)) cursor += 1;
    let value = '';
    if (input[cursor] === '=') {
      cursor += 1;
      while (cursor < input.length && /\s/.test(input[cursor] as string)) cursor += 1;
      const quote = input[cursor];
      if (quote === '"' || quote === "'") {
        cursor += 1;
        const close = input.indexOf(quote, cursor);
        value = input.slice(cursor, close === -1 ? input.length : close);
        cursor = close === -1 ? input.length : close + 1;
      } else {
        const unquoted = /^[^\s>]*/.exec(input.slice(cursor));
        value = unquoted === null ? '' : unquoted[0];
        cursor += value.length;
      }
    }
    attrs.push([attrName[0].toLowerCase(), value]);
  }

  return { kind: closing ? 'close' : 'open', name, attrs, selfClosing, end: cursor };
}

function skipSubtree(input: string, from: number, name: string): number {
  const lower = input.toLowerCase();
  const close = lower.indexOf(`</${name}`, from);
  if (close === -1) return input.length;
  const gt = input.indexOf('>', close);
  return gt === -1 ? input.length : gt + 1;
}

function serialiseAttrs(tag: string, attrs: Array<[string, string]>): string {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const [name, raw] of attrs) {
    if (!ALLOWED_ATTRS.has(name) || seen.has(name)) continue;
    if (name === 'href') {
      if (tag !== 'a') continue;
      const href = safeHref(raw);
      if (href === undefined) continue;
      seen.add(name);
      out.push(` href="${escapeAttr(href)}"`);
      continue;
    }
    if (name === 'colspan' || name === 'rowspan') {
      if (!/^\d{1,4}$/.test(raw.trim())) continue;
      seen.add(name);
      out.push(` ${name}="${raw.trim()}"`);
      continue;
    }
    seen.add(name);
    out.push(` ${name}="${escapeAttr(raw)}"`);
  }
  return out.join('');
}

/**
 * A URL is checked after entity decoding and after control characters are
 * removed, because a browser decodes both before it dispatches the scheme:
 * `java&#115;cript:` and `java\tscript:` are live vectors against a naive
 * string comparison.
 */
function safeHref(raw: string): string | undefined {
  const decoded = decodeEntities(raw);
  const probe = decoded.replace(/[\u0000-\u0020\u007f-\u009f]/g, '').toLowerCase();
  if (DANGEROUS_SCHEME.test(probe)) return undefined;
  if (probe === '') return undefined;
  return decoded.trim();
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  colon: ':',
  tab: '\t',
  newline: '\n',
  sol: '/',
  nbsp: ' ',
};

function decodeEntities(value: string): string {
  return value.replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z]+);?/g, (whole, body: string) => {
    if (body.startsWith('#')) {
      const hex = body[1] === 'x' || body[1] === 'X';
      const digits = hex ? body.slice(2) : body.slice(1);
      const point = Number.parseInt(digits, hex ? 16 : 10);
      if (!Number.isFinite(point) || point <= 0 || point > 0x10ffff) return whole;
      return String.fromCodePoint(point);
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

const VALID_ENTITY = /^&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,30});/;

function escapeText(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i] as string;
    if (char === '<') {
      out += '&lt;';
    } else if (char === '>') {
      out += '&gt;';
    } else if (char === '&') {
      // An already-valid entity is passed through so `&amp;` does not become
      // `&amp;amp;` on screen; anything else is escaped.
      const rest = value.slice(i);
      if (VALID_ENTITY.test(rest)) out += '&';
      else out += '&amp;';
    } else {
      out += char;
    }
  }
  return out;
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Plain text of a narrative, for the txt-2 "some non-whitespace" check. */
export function narrativeTextContent(html: string): string {
  return sanitiseNarrativeHtml(html)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;?/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A cheap divergence signal: how many rows or list items the narrative shows.
 *
 * Compared against the section's entry count, a mismatch means the narrative and
 * the structured entries do not say the same thing, which is worth reporting
 * because a structured-only renderer would be losing clinical content.
 */
export function narrativeRowCount(html: string): number {
  const clean = sanitiseNarrativeHtml(html);
  const bodyRows = (clean.match(/<tr\b/g) ?? []).length;
  if (bodyRows > 0) {
    // A header row is not a data row. One header is the overwhelming norm.
    const headers = (clean.match(/<th\b/g) ?? []).length > 0 ? 1 : 0;
    return Math.max(0, bodyRows - headers);
  }
  return (clean.match(/<li\b/g) ?? []).length;
}
