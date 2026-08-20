/**
 * Platypus-shaped payloads: an AU Patient Summary document, and a record
 * collection.
 *
 * Platypus is an Australian personal health record that mints SMART Health Links
 * from its own relay, and it is the interop counterpart SHLoupe is most likely to
 * be pointed at during a Sparked testing event. These two bundles are not copies
 * of one of its links; they are built from its real emitted output so that every
 * renderer path a real Platypus payload takes is exercised offline, at about 12 kB
 * instead of 155 kB.
 *
 * The codes, profile canonicals, wordings and structural quirks are taken from a
 * verified Platypus evidence run, and the SNOMED CT-AU codes were re-checked
 * against the Australian edition rather than trusted from memory. What is
 * deliberately synthetic is called out where it appears.
 *
 * Ten things in here break a viewer written against a tidier producer, and each
 * one has cost somebody an afternoon:
 *
 *  1. `fullUrl` and `resource.id` disagree for every placed record. A resource
 *     pulled from a clinical server keeps that server's id (`active-bisoprolol`)
 *     while sitting under a fresh `urn:uuid:` fullUrl, so resolving a reference by
 *     id finds nothing.
 *  2. A section code carries NO `display`. The human wording is
 *     `section.title`, in Australian spelling. Key a layout off the LOINC display
 *     and every section renders empty.
 *  3. A mandated element the source never supplied is stated absent in the
 *     `_`-prefixed primitive sibling (`_effectiveDateTime`), not in the element.
 *     A renderer that walks named fields drops it silently.
 *  4. A medication's concept can be a contained `Medication` reached by
 *     `medicationReference: '#bisoprolol'`, not `medicationCodeableConcept`.
 *  5. "No known allergy" is an ordinary AllergyIntolerance carrying a SNOMED
 *     negation code, not a flag and not an empty section. Render it as a row and
 *     you have told a clinician the patient is allergic to something called
 *     "No known allergy".
 *  6. An empty section carries `emptyReason`, which asserts nothing clinical: it
 *     means nobody has said either way. It is not the absence assertion in (5).
 *  7. References to records the patient does not hold are left exactly as they
 *     arrived (`PractitionerRole/...`, `Encounter/delivery`). That is a deliberate
 *     positive-signal-only rule, so "not carried by this bundle" is the honest
 *     rendering, never an error.
 *  8. An asserted party travels as a display-only `Provenance` agent whose text
 *     states the basis of the name, with no `Organization` minted, curly quotes
 *     included. Present it verbatim; do not tidy it and do not substitute
 *     "Unknown organisation".
 *  9. One origin `Provenance` can target dozens of entries. Render a row per
 *     target and you get a wall.
 * 10. A narrative can come from a server nobody vetted, so it is sanitised before
 *     it is rendered. One entry below carries a hostile narrative on purpose.
 */
import type { Medication } from 'fhir/r4';
import type { FixtureBundle } from './ips-bundle';

const SNOMED = 'http://snomed.info/sct';
const LOINC = 'http://loinc.org';
const UCUM = 'http://unitsofmeasure.org';
const OBS_CATEGORY = 'http://terminology.hl7.org/CodeSystem/observation-category';
const XHTML = 'http://www.w3.org/1999/xhtml';

/** The Patient entry's fullUrl, referenced from most other entries. */
const PATIENT = 'urn:uuid:efb5c76d-a028-4dea-a90b-ddde50e2fca2';
/** The assembling Organization: Composition author and custodian. */
const ASSEMBLER = 'urn:uuid:9ce3580c-a2e0-4b4d-ad05-c86b72294f2c';
/** The Device that stands for sample or device-sourced data. */
const SAMPLE_DEVICE = 'urn:uuid:f7dbac9d-55c1-4616-a0de-ae7f4bbb88a0';

const ALLERGY_CHLORHEXIDINE = 'urn:uuid:7d063dee-2182-480a-9a23-f24a381fd1d0';
const ALLERGY_NONE_KNOWN = 'urn:uuid:0044248a-0cbf-46ee-801c-f703cc7ed47a';
const MED_BISOPROLOL = 'urn:uuid:374057c9-e95f-4bed-8079-fdbd7eb77481';
const MED_BACTRIM = 'urn:uuid:10f4699d-369a-40e2-95da-b79de3fc020c';
const CONDITION_UTI = 'urn:uuid:0224ccdd-6bfb-48d5-8065-77b9628e64ab';
const IMMUNISATION_DTPA = 'urn:uuid:c7ce0fb3-c183-4978-990e-8b8b3c19bdbf';
const OBS_BLOOD_PRESSURE = 'urn:uuid:fe7c1993-db5f-4039-bd41-f469f61dc0fa';
const OBS_SMOKING = 'urn:uuid:0d47dd11-a6af-4272-b697-2a3a4cb9a192';
const OBS_CHOLESTEROL = 'urn:uuid:fb44086c-1515-493e-be01-9b75541cd57e';
const OBS_PATIENT_NOTE = 'urn:uuid:ba0f3a8f-9802-4735-a22a-698a6e4179a6';

/**
 * The `Medication` that sits in `MedicationStatement.contained` below.
 *
 * Declared as its own typed constant rather than written inline, because
 * `DomainResource.contained` is typed as the abstract `Resource` and an inline
 * literal of a real resource fails excess-property checking against it. Naming it
 * keeps the fixture type-checked without a cast.
 */
const BISOPROLOL: Medication = {
  resourceType: 'Medication',
  id: 'bisoprolol',
  code: {
    coding: [
      { system: SNOMED, code: '23281011000036106', display: 'Bisoprolol fumarate 2.5 mg tablet' },
    ],
    text: 'Bisoprolol 2.5mg tab',
  },
};

/**
 * The IG's own IPS link, used below as the `attachment.url` of a preserved
 * received link. It is a real, working link on purpose: a nested link the viewer
 * can offer to open is only demonstrable if opening it goes somewhere.
 */
export const NESTED_SHLINK =
  'shlink:/eyJ1cmwiOiJodHRwczovL3Jhdy5naXRodWJ1c2VyY29udGVudC5jb20vc2Vhbm5vL3NoYy1kZW1vLWRhdGEvbWFpbi9pcHMvSVBTX0lHLWJ1bmRsZS0wMS1lbmMudHh0IiwiZmxhZyI6IkxVIiwia2V5IjoicnhUZ1lsT2FLSlBGdGNFZDBxY2NlTjh3RVU0cDk0U3FBd0lXUWU2dVg3USIsImxhYmVsIjoiRGVtbyBTSEwgZm9yIElQU19JRy1idW5kbGUtMDEifQ';

/**
 * An AU Patient Summary document Bundle, as Platypus emits one.
 *
 * Nine sections in the order Platypus writes them, one of them empty with an
 * `emptyReason`, and the two Provenance kinds a share carries: origin (where the
 * records came from) and adjudication (which of two versions was kept, and why).
 */
export const PLATYPUS_AU_PS_BUNDLE: FixtureBundle = {
  resourceType: 'Bundle',
  id: '016c3613-d7bc-422c-8867-9721494b406d',
  meta: { profile: ['http://hl7.org.au/fhir/ps/StructureDefinition/au-ps-bundle'] },
  // Platypus writes rfc:3986 with a urn:uuid value. Other Australian producers
  // write rfc:4122 with a bare uuid; both are in the wild, so neither is a
  // reliable producer fingerprint on its own.
  identifier: {
    system: 'urn:ietf:rfc:3986',
    value: 'urn:uuid:5bfcd072-365c-485c-b9b2-b47fe4a130dc',
  },
  type: 'document',
  timestamp: '2026-08-19T08:20:13.418Z',
  entry: [
    {
      fullUrl: 'urn:uuid:165299fb-199b-4f26-acae-95c991c30655',
      resource: {
        resourceType: 'Composition',
        id: '165299fb-199b-4f26-acae-95c991c30655',
        meta: { profile: ['http://hl7.org.au/fhir/ps/StructureDefinition/au-ps-composition'] },
        text: {
          status: 'generated',
          div: `<div xmlns="${XHTML}"><p>AU Patient Summary, generated 19 Aug 2026.</p><ul><li>Allergies and Intolerances</li><li>Medication Summary</li><li>Problem List</li><li>History of Immunisations</li><li>Vital Signs</li><li>Social History</li><li>Diagnostic Results</li><li>History of Procedures</li><li>Patient Story</li></ul></div>`,
        },
        // Distinct from Bundle.identifier on purpose: the document and the
        // composition are two things with two identities.
        identifier: {
          system: 'urn:ietf:rfc:3986',
          value: 'urn:uuid:4a91063a-b760-4b05-b298-db4a29d82e6e',
        },
        status: 'final',
        type: {
          coding: [{ system: LOINC, code: '60591-5', display: 'Patient summary Document' }],
        },
        subject: { reference: PATIENT },
        date: '2026-08-19T08:20:13.418Z',
        // The Patient is a second author whenever the payload carries anything
        // the patient contributed, which this one does (the Patient Story).
        author: [{ reference: ASSEMBLER }, { reference: PATIENT }],
        title: 'AU Patient Summary',
        custodian: { reference: ASSEMBLER },
        section: [
          {
            title: 'Allergies and Intolerances',
            code: { coding: [{ system: LOINC, code: '48765-2' }] },
            text: {
              status: 'generated',
              div: `<div xmlns="${XHTML}"><ul><li><strong>Chlorhexidine</strong>: reaction: Hives</li><li><strong>No known allergies</strong></li></ul></div>`,
            },
            entry: [{ reference: ALLERGY_CHLORHEXIDINE }, { reference: ALLERGY_NONE_KNOWN }],
          },
          {
            title: 'Medication Summary',
            code: { coding: [{ system: LOINC, code: '10160-0' }] },
            text: {
              status: 'generated',
              div: `<div xmlns="${XHTML}"><ul><li><strong>Bisoprolol 2.5mg tab</strong>: Active</li><li><strong>Bactrim DS - tablet</strong>: Completed</li></ul></div>`,
            },
            entry: [{ reference: MED_BISOPROLOL }, { reference: MED_BACTRIM }],
          },
          {
            title: 'Problem List',
            code: { coding: [{ system: LOINC, code: '11450-4' }] },
            text: {
              status: 'generated',
              div: `<div xmlns="${XHTML}"><ul><li><strong>Urinary tract infection</strong>: Active · onset 10 May 2020</li></ul></div>`,
            },
            entry: [{ reference: CONDITION_UTI }],
          },
          {
            title: 'History of Immunisations',
            code: { coding: [{ system: LOINC, code: '11369-6' }] },
            text: {
              status: 'generated',
              div: `<div xmlns="${XHTML}"><ul><li><strong>dTpa booster</strong>: 8 Jun 2023 · Completed</li></ul></div>`,
            },
            entry: [{ reference: IMMUNISATION_DTPA }],
          },
          {
            title: 'Vital Signs',
            code: { coding: [{ system: LOINC, code: '8716-3' }] },
            text: {
              status: 'generated',
              div: `<div xmlns="${XHTML}"><ul><li><strong>Blood pressure systolic and diastolic</strong>: 3 Feb 2024</li></ul></div>`,
            },
            entry: [{ reference: OBS_BLOOD_PRESSURE }],
          },
          {
            title: 'Social History',
            code: { coding: [{ system: LOINC, code: '29762-2' }] },
            text: {
              status: 'generated',
              div: `<div xmlns="${XHTML}"><ul><li><strong>Smoking status</strong>: Former smoker · 2 May 2026</li></ul></div>`,
            },
            entry: [{ reference: OBS_SMOKING }],
          },
          {
            title: 'Diagnostic Results',
            code: { coding: [{ system: LOINC, code: '30954-2' }] },
            text: {
              status: 'generated',
              div: `<div xmlns="${XHTML}"><ul><li><strong>Cholesterol</strong>: 5.9 mmol/L (High) · ref up to 5.6 mmol/L · 17 Jan 2023</li></ul></div>`,
            },
            entry: [{ reference: OBS_CHOLESTEROL }],
          },
          {
            // An empty section, and the thing it does NOT say: emptyReason
            // "unavailable" means nobody has recorded a procedure and the patient
            // has not stated they have none. A patient who HAS stated that holds
            // an absence assertion, which arrives as an entry, so a section that
            // reaches this shape has no clinical statement in it at all.
            title: 'History of Procedures',
            code: { coding: [{ system: LOINC, code: '47519-4' }] },
            text: {
              status: 'generated',
              div: `<div xmlns="${XHTML}"><p>No information available.</p></div>`,
            },
            emptyReason: {
              coding: [
                {
                  system: 'http://terminology.hl7.org/CodeSystem/list-empty-reason',
                  code: 'unavailable',
                },
              ],
            },
          },
          {
            title: 'Patient Story',
            code: { coding: [{ system: LOINC, code: '81338-6' }] },
            // status 'additional' rather than 'generated': the narrative carries
            // the patient's own words, which are not derived from the entries.
            text: {
              status: 'additional',
              div: `<div xmlns="${XHTML}"><p>Notes recorded by the patient:</p><ul><li>Feeling dizzy and lightheaded most mornings since my bisoprolol dose was increased. It passes after I sit down for a while.</li></ul></div>`,
            },
            entry: [{ reference: OBS_PATIENT_NOTE }],
          },
        ],
      },
    },
    {
      fullUrl: PATIENT,
      resource: {
        resourceType: 'Patient',
        // id is the vault's own key for this patient, and it is NOT the fullUrl.
        id: 'banks-mia-leanne',
        meta: { profile: ['http://hl7.org.au/fhir/ps/StructureDefinition/au-ps-patient'] },
        extension: [
          {
            url: 'http://hl7.org.au/fhir/StructureDefinition/indigenous-status',
            valueCoding: {
              system:
                'https://healthterminologies.gov.au/fhir/CodeSystem/australian-indigenous-status-1',
              code: '9',
              display: 'Not stated/inadequately described',
            },
          },
        ],
        identifier: [
          {
            // The IHI, and the identifier a receiving app keys its
            // "is this even the same person" guard off.
            extension: [
              {
                url: 'http://hl7.org.au/fhir/StructureDefinition/ihi-status',
                valueCoding: {
                  system: 'https://healthterminologies.gov.au/fhir/CodeSystem/ihi-status-1',
                  code: 'active',
                },
              },
              {
                url: 'http://hl7.org.au/fhir/StructureDefinition/ihi-record-status',
                valueCoding: {
                  system: 'https://healthterminologies.gov.au/fhir/CodeSystem/ihi-record-status-1',
                  code: 'verified',
                  display: 'verified',
                },
              },
            ],
            type: {
              coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: 'NI' }],
              text: 'IHI',
            },
            system: 'http://ns.electronichealth.net.au/id/hi/ihi/1.0',
            value: '8003608333647261',
          },
        ],
        name: [{ use: 'official', family: 'BANKS', given: ['Mia', 'LEANNE'] }],
        telecom: [{ system: 'phone', value: '0491574632', use: 'mobile' }],
        gender: 'female',
        birthDate: '1983-08-25',
        address: [
          {
            line: ['50 Sebastien St'],
            city: 'Minjary',
            state: 'NSW',
            postalCode: '2720',
            country: 'AU',
          },
        ],
      },
    },
    {
      fullUrl: ASSEMBLER,
      resource: {
        resourceType: 'Organization',
        id: '9ce3580c-a2e0-4b4d-ad05-c86b72294f2c',
        // Name only. No identifier, no type, no address: the app will not assert
        // anything about itself it has not been told.
        name: 'Platypus Health',
      },
    },
    {
      fullUrl: SAMPLE_DEVICE,
      resource: {
        resourceType: 'Device',
        id: 'f7dbac9d-55c1-4616-a0de-ae7f4bbb88a0',
        // deviceName only, and no `type`. A viewer that names a device from
        // Device.type shows a blank row here.
        deviceName: [{ name: 'Sample Data', type: 'user-friendly-name' }],
      },
    },
    {
      fullUrl: ALLERGY_CHLORHEXIDINE,
      resource: {
        resourceType: 'AllergyIntolerance',
        id: 'chlorhexidine',
        meta: {
          profile: ['http://hl7.org.au/fhir/core/StructureDefinition/au-core-allergyintolerance'],
        },
        clinicalStatus: {
          coding: [
            {
              system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical',
              code: 'active',
            },
          ],
          text: 'Active',
        },
        // The coding carries no display and the text does. That is the source's
        // own wording winning over a code system label, which is the rule
        // Platypus follows everywhere: show `text` when it is there.
        code: { coding: [{ system: SNOMED, code: '373568007' }], text: 'Chlorhexidine' },
        patient: { reference: PATIENT },
        onsetDateTime: '2021-01-12',
        recordedDate: '2023-01-12',
        reaction: [
          {
            substance: { coding: [{ system: SNOMED, code: '373568007' }], text: 'Chlorhexidine' },
            manifestation: [{ coding: [{ system: SNOMED, code: '247472004' }], text: 'Hives' }],
            severity: 'mild',
          },
        ],
      },
    },
    {
      fullUrl: ALLERGY_NONE_KNOWN,
      resource: {
        resourceType: 'AllergyIntolerance',
        id: 'none-known-allergy',
        meta: {
          profile: ['http://hl7.org.au/fhir/core/StructureDefinition/au-core-allergyintolerance'],
        },
        clinicalStatus: {
          coding: [
            {
              system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical',
              code: 'active',
            },
          ],
        },
        verificationStatus: {
          coding: [
            {
              system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-verification',
              code: 'unconfirmed',
            },
          ],
        },
        // SNOMED 716186003 is a situation-with-explicit-context concept: "there
        // is no history of an allergic condition in this subject". It is the
        // patient's positive statement that they have no allergies, and it is a
        // fact of a different kind from every other row in this section.
        code: { coding: [{ system: SNOMED, code: '716186003', display: 'No known allergy' }] },
        // Left exactly as it arrived: this record came in keyed to a logical
        // Patient id, and the bundle carries no target for it. Not an error.
        patient: { reference: 'Patient/banks-mia-leanne' },
        recordedDate: '2023-01-08',
        recorder: { reference: PATIENT },
        asserter: { reference: PATIENT },
      },
    },
    {
      fullUrl: MED_BISOPROLOL,
      resource: {
        resourceType: 'MedicationStatement',
        id: 'active-bisoprolol',
        meta: {
          profile: ['http://hl7.org.au/fhir/core/StructureDefinition/au-core-medicationstatement'],
        },
        contained: [BISOPROLOL],
        status: 'active',
        // The medication[x] choice resolved as a contained reference. Read only
        // medicationCodeableConcept and this medicine has no name.
        medicationReference: { reference: '#bisoprolol' },
        subject: { reference: PATIENT },
        dateAsserted: '2019-02-05',
        dosage: [{ text: 'Half a tablet (1.25 mg) each morning' }],
        // AU PS raises effective[x] to 1..1 where AU Core leaves it 0..1, and the
        // source never sent one. The absence is stated in the primitive sibling,
        // never faked from dateAsserted, which means something else entirely.
        _effectiveDateTime: {
          extension: [
            {
              url: 'http://hl7.org/fhir/StructureDefinition/data-absent-reason',
              valueCode: 'unknown',
            },
          ],
        },
      },
    },
    {
      fullUrl: MED_BACTRIM,
      resource: {
        resourceType: 'MedicationStatement',
        id: 'completed-bactrim',
        meta: {
          profile: ['http://hl7.org.au/fhir/core/StructureDefinition/au-core-medicationstatement'],
        },
        // SYNTHETIC, and the only hostile content in these fixtures. A placed
        // record keeps the narrative its source server wrote, and a source
        // server is not something the patient vetted, so this is a real threat
        // shape rather than a contrived one. Sanitise before rendering: strip the
        // event handler, and refuse the javascript: href.
        text: {
          status: 'generated',
          div: `<div xmlns="${XHTML}"><p><b>medication</b>: Bactrim DS - tablet</p><p onmouseover="alert(1)">Dispensed at <a href="javascript:alert(1)">Minjary Pharmacy</a></p></div>`,
        },
        status: 'completed',
        medicationCodeableConcept: {
          coding: [
            { system: SNOMED, code: '6632011000036102', display: 'Bactrim DS tablet' },
            // A PBS item code beside the SNOMED CT-AU one. It is a real
            // Australian code system that a generic terminology server does not
            // know, so a validator run without it reports a false error.
            { system: 'http://pbs.gov.au/code/item', code: '2951H' },
          ],
          text: 'Bactrim DS - tablet',
        },
        subject: { reference: PATIENT },
        dateAsserted: '2020-05-30T10:00:00+10:00',
        // Rewritten to the urn:uuid of the Condition, because that entry IS in
        // this bundle. Compare the allergy above, whose target is not.
        reasonReference: [{ reference: CONDITION_UTI }],
        _effectiveDateTime: {
          extension: [
            {
              url: 'http://hl7.org/fhir/StructureDefinition/data-absent-reason',
              valueCode: 'unknown',
            },
          ],
        },
      },
    },
    {
      fullUrl: CONDITION_UTI,
      resource: {
        resourceType: 'Condition',
        id: 'uti',
        meta: { profile: ['http://hl7.org.au/fhir/core/StructureDefinition/au-core-condition'] },
        clinicalStatus: {
          coding: [
            {
              system: 'http://terminology.hl7.org/CodeSystem/condition-clinical',
              code: 'active',
              display: 'Active',
            },
          ],
        },
        verificationStatus: {
          coding: [
            {
              system: 'http://terminology.hl7.org/CodeSystem/condition-ver-status',
              code: 'confirmed',
              display: 'Confirmed',
            },
          ],
        },
        category: [
          {
            coding: [
              {
                system: 'http://terminology.hl7.org/CodeSystem/condition-category',
                code: 'problem-list-item',
                display: 'Problem List Item',
              },
            ],
          },
        ],
        code: {
          coding: [{ system: SNOMED, code: '68566005', display: 'Urinary tract infection' }],
        },
        subject: { reference: PATIENT },
        onsetDateTime: '2020-05-10',
        // Two references the patient's device does not hold. Platypus does not
        // pull PractitionerRole, so these stay as the source server wrote them.
        recorder: { reference: 'PractitionerRole/generalpractitioner-guthridge-jarred' },
        asserter: { reference: 'PractitionerRole/generalpractitioner-guthridge-jarred' },
      },
    },
    {
      fullUrl: IMMUNISATION_DTPA,
      resource: {
        resourceType: 'Immunization',
        id: 'demo-dtpa-2023',
        meta: { profile: ['http://hl7.org.au/fhir/core/StructureDefinition/au-core-immunization'] },
        status: 'completed',
        vaccineCode: {
          coding: [
            {
              system: SNOMED,
              code: '837621000168102',
              display: 'Diphtheria + tetanus + pertussis 3 component vaccine',
            },
          ],
          text: 'dTpa booster',
        },
        patient: { reference: PATIENT },
        occurrenceDateTime: '2023-06-08',
        primarySource: true,
        lotNumber: 'BOO23-4471',
      },
    },
    {
      fullUrl: OBS_BLOOD_PRESSURE,
      resource: {
        resourceType: 'Observation',
        id: 'bloodpressure-diastolic-missing',
        meta: {
          profile: ['http://hl7.org.au/fhir/core/StructureDefinition/au-core-bloodpressure'],
        },
        status: 'final',
        category: [{ coding: [{ system: OBS_CATEGORY, code: 'vital-signs' }] }],
        code: {
          coding: [
            { system: LOINC, code: '85354-9' },
            { system: SNOMED, code: '75367002' },
          ],
          text: 'Blood pressure systolic and diastolic',
        },
        subject: { reference: PATIENT },
        effectiveDateTime: '2024-02-03',
        performer: [{ reference: 'PractitionerRole/generalpractitioner-burrows-ginger' }],
        // A blood pressure with no value at the top level: both numbers live in
        // components, and here the diastolic one is absent rather than zero.
        // dataAbsentReason on a component is a third absence mechanism, distinct
        // from the primitive extension above and from the negation code earlier.
        component: [
          {
            code: {
              coding: [
                { system: LOINC, code: '8480-6', display: 'Systolic blood pressure' },
                { system: SNOMED, code: '271649006' },
              ],
              text: 'Systolic blood pressure',
            },
            valueQuantity: { value: 110, unit: 'mmHg', system: UCUM, code: 'mm[Hg]' },
          },
          {
            code: {
              coding: [
                { system: LOINC, code: '8462-4', display: 'Diastolic blood pressure' },
                { system: SNOMED, code: '271650006' },
              ],
              text: 'Diastolic blood pressure',
            },
            dataAbsentReason: {
              coding: [
                {
                  system: 'http://terminology.hl7.org/CodeSystem/data-absent-reason',
                  code: 'unknown',
                },
              ],
              text: 'Unknown',
            },
          },
        ],
      },
    },
    {
      fullUrl: OBS_SMOKING,
      resource: {
        resourceType: 'Observation',
        id: 'demo-smokingstatus-2026',
        meta: {
          profile: ['http://hl7.org.au/fhir/core/StructureDefinition/au-core-smokingstatus'],
        },
        status: 'final',
        category: [
          { coding: [{ system: OBS_CATEGORY, code: 'social-history' }], text: 'Social History' },
        ],
        // 1747861000168109 is SNOMED CT-AU only. Look it up against the
        // International edition and it does not exist, so a viewer that reports
        // "unknown code" here is reporting its own configuration.
        code: {
          coding: [
            { system: SNOMED, code: '1747861000168109', display: 'Smoking status' },
            { system: LOINC, code: '72166-2', display: 'Tobacco smoking status' },
          ],
          text: 'Smoking status',
        },
        subject: { reference: PATIENT },
        effectiveDateTime: '2026-05-02',
        valueCodeableConcept: {
          coding: [{ system: SNOMED, code: '8517006', display: 'Former smoker' }],
          text: 'Former smoker',
        },
      },
    },
    {
      fullUrl: OBS_CHOLESTEROL,
      resource: {
        resourceType: 'Observation',
        id: 'lipid-chol-1',
        meta: {
          profile: [
            'http://hl7.org.au/fhir/core/StructureDefinition/au-core-diagnosticresult-path',
          ],
        },
        status: 'final',
        // Two categories, and only the first is the one a section is chosen by.
        category: [
          { coding: [{ system: OBS_CATEGORY, code: 'laboratory', display: 'Laboratory' }] },
          {
            coding: [
              {
                system: 'http://terminology.hl7.org/CodeSystem/v2-0074',
                code: 'CH',
                display: 'Chemistry',
              },
            ],
            text: 'Chemistry',
          },
        ],
        code: {
          coding: [
            {
              system: LOINC,
              code: '14647-2',
              display: 'Cholesterol [Moles/volume] in Serum or Plasma',
            },
          ],
          text: 'Cholesterol',
        },
        subject: { reference: PATIENT },
        effectiveDateTime: '2023-01-17',
        valueQuantity: { value: 5.9, unit: 'mmol/L', system: UCUM, code: 'mmol/L' },
        interpretation: [
          {
            coding: [
              {
                system: 'http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation',
                code: 'H',
                display: 'High',
              },
            ],
          },
        ],
        // A range with a high and no low. Render "5.6" as a range and it reads as
        // a target rather than a ceiling.
        referenceRange: [{ high: { value: 5.6, unit: 'mmol/L', system: UCUM, code: 'mmol/L' } }],
      },
    },
    {
      fullUrl: OBS_PATIENT_NOTE,
      resource: {
        resourceType: 'Observation',
        id: 'note-sample-bisoprolol-dizziness',
        // No meta.profile: this one is the patient's own words, not a record from
        // a clinical system, so there is no profile to claim.
        status: 'final',
        category: [{ coding: [{ system: OBS_CATEGORY, code: 'survey', display: 'Survey' }] }],
        code: {
          coding: [{ system: SNOMED, code: '404640003', display: 'Dizziness' }],
          text: 'Dizziness',
        },
        subject: { reference: PATIENT },
        performer: [{ reference: PATIENT }],
        issued: '2026-05-05T00:00:00.000Z',
        // A display-only Reference: it names what the note is about without
        // pointing at a resource. Resolve it and you get nothing, correctly.
        derivedFrom: [{ display: 'Medication 23281011000036106' }],
        effectiveDateTime: '2026-05-05',
        component: [{ code: { text: 'Severity' }, valueString: 'Mild' }],
        note: [
          {
            text: 'Feeling dizzy and lightheaded most mornings since my bisoprolol dose was increased. It passes after I sit down for a while.',
            time: '2026-05-05T00:00:00.000Z',
            authorString: 'Patient',
          },
        ],
      },
    },
    {
      fullUrl: 'urn:uuid:c8229777-01b9-4da7-9e61-1e05f78adb69',
      resource: {
        resourceType: 'Provenance',
        // The origin Provenance for records that arrived through a received
        // health link. There is no Organization entry to point at, because the
        // only evidence for the name was the link's own label.
        target: [
          { reference: ALLERGY_CHLORHEXIDINE },
          { reference: MED_BISOPROLOL },
          { reference: MED_BACTRIM },
          { reference: CONDITION_UTI },
          { reference: OBS_CHOLESTEROL },
        ],
        // `recorded` is when this assertion was made, which is when the payload
        // was assembled. It is not the date of any record it targets.
        recorded: '2026-08-19T08:20:13.418Z',
        // The window the records were received in, kept separate so a span is
        // never collapsed into one instant that misdescribes the earlier ones.
        occurredPeriod: { start: '2026-07-02T04:11:00.000Z', end: '2026-08-14T23:40:00.000Z' },
        agent: [
          {
            type: {
              coding: [
                {
                  system: 'http://terminology.hl7.org/CodeSystem/provenance-participant-type',
                  code: 'author',
                  display: 'Author',
                },
              ],
            },
            // Display only, no `reference`, and the wording states where the name
            // came from. The curly quotes are part of the wire contract: present
            // this string verbatim, and never fall back to "Unknown organisation".
            who: { display: 'Shared link labelled “WA Health Summary”' },
          },
        ],
      },
    },
    {
      fullUrl: 'urn:uuid:abd394ca-e4ea-4871-8155-8bbe309fbb14',
      resource: {
        resourceType: 'Provenance',
        // The other origin kind: a party the app can name, so it minted a
        // resource and points at it. Same mechanism, different `who`.
        target: [
          { reference: ALLERGY_NONE_KNOWN },
          { reference: IMMUNISATION_DTPA },
          { reference: OBS_BLOOD_PRESSURE },
          { reference: OBS_SMOKING },
        ],
        recorded: '2026-08-19T08:20:13.418Z',
        agent: [
          {
            type: {
              coding: [
                {
                  system: 'http://terminology.hl7.org/CodeSystem/provenance-participant-type',
                  code: 'author',
                  display: 'Author',
                },
              ],
            },
            who: { reference: SAMPLE_DEVICE },
          },
        ],
      },
    },
    {
      fullUrl: 'urn:uuid:11dd1400-0c60-4b64-9d6a-e90b17c634a9',
      resource: {
        resourceType: 'Provenance',
        // Patient contribution: the same mechanism as origin, differing only in
        // who the agent is. Not a separate concept and not a flag on the record.
        id: 'prov-note-sample-bisoprolol-dizziness',
        target: [{ reference: OBS_PATIENT_NOTE }],
        recorded: '2026-05-05T00:00:00.000Z',
        agent: [
          {
            type: {
              coding: [
                {
                  system: 'http://terminology.hl7.org/CodeSystem/provenance-participant-type',
                  code: 'author',
                  display: 'Author',
                },
              ],
            },
            who: { reference: PATIENT },
          },
        ],
      },
    },
    {
      fullUrl: 'urn:uuid:c2c70666-2ea6-49dd-8e40-675ad3c62c83',
      resource: {
        resourceType: 'Provenance',
        // An adjudication: the patient held two versions of this medication and
        // one was kept. FHIR has no vocabulary for merge adjudication, so the
        // code only says an update happened and the MEANING is in activity.text.
        // A viewer that renders the coding display shows "revise", which tells
        // the reader nothing.
        target: [{ reference: MED_BISOPROLOL }],
        recorded: '2026-08-19T08:20:13.418Z',
        activity: {
          coding: [
            {
              system: 'http://terminology.hl7.org/CodeSystem/v3-DataOperation',
              code: 'UPDATE',
              display: 'revise',
            },
          ],
          text: 'Kept as the version from the more authoritative source',
        },
        agent: [
          {
            type: {
              coding: [
                {
                  system: 'http://terminology.hl7.org/CodeSystem/provenance-participant-type',
                  // 'assembler', not 'author': the device elected this version,
                  // the patient did not choose it.
                  code: 'assembler',
                  display: 'Assembler',
                },
              ],
            },
            who: { reference: ASSEMBLER },
          },
        ],
      },
    },
  ],
};

/**
 * A record collection, as Platypus emits one when the patient picks individual
 * records rather than generating a summary.
 *
 * Structurally it is the opposite of the document above, and the differences are
 * all deliberate. There is no `id`, no `meta.profile` and no `identifier`,
 * because a collection asserts no conformance and no completeness: it is the
 * records the patient chose and nothing more. There is no `Composition`, so
 * nothing here is organised into sections. And there is no `Patient` entry at
 * all, which means a `subject` reference either dangles or is missing outright.
 * None of that is a defect to report.
 */
export const PLATYPUS_COLLECTION_BUNDLE: FixtureBundle = {
  resourceType: 'Bundle',
  type: 'collection',
  timestamp: '2026-08-19T09:02:44.900Z',
  entry: [
    {
      fullUrl: 'urn:uuid:e11424c6-3e99-4f3b-a1fb-3db894bc26d2',
      resource: {
        resourceType: 'Observation',
        status: 'final',
        category: [{ coding: [{ system: OBS_CATEGORY, code: 'vital-signs' }] }],
        code: {
          coding: [{ system: LOINC, code: '29463-7', display: 'Body weight' }],
          text: 'Weight',
        },
        // A dangling logical reference, and the only form Platypus will put on
        // the wire: it writes Patient/<id> only when the id is genuinely an IHI,
        // because its internal key contains a colon and is not a legal FHIR id.
        subject: { reference: 'Patient/8003608333647261' },
        effectiveDateTime: '2026-08-11',
        valueQuantity: { value: 71.4, unit: 'kg', system: UCUM, code: 'kg' },
      },
    },
    {
      fullUrl: 'urn:uuid:48609a2e-53aa-4f5b-b13f-a33c1856875f',
      resource: {
        resourceType: 'Observation',
        status: 'final',
        category: [{ coding: [{ system: OBS_CATEGORY, code: 'survey', display: 'Survey' }] }],
        code: {
          coding: [{ system: SNOMED, code: '25064002', display: 'Headache' }],
          text: 'Headache',
        },
        // No `subject` at all. The patient's key was not an IHI, so rather than
        // minting an id from an internal value, the app says nothing.
        effectiveDateTime: '2026-08-16',
        note: [{ text: 'Two days of headache after the long drive.', authorString: 'Patient' }],
      },
    },
    {
      fullUrl: 'urn:uuid:aaf939e8-2af5-4e2f-8a67-179c2d00453b',
      resource: {
        resourceType: 'DocumentReference',
        status: 'current',
        // A health link the patient received, preserved so it can be shared on.
        // The attachment URL is itself a shlink, which makes this the one entry
        // shape a viewer can offer to open: a link inside a payload.
        type: { text: 'Received health link' },
        date: '2026-08-14T23:40:00.000Z',
        description: 'WA Health Summary',
        content: [
          {
            attachment: {
              contentType: 'application/smart-health-link',
              url: NESTED_SHLINK,
              title: 'WA Health Summary',
            },
          },
        ],
      },
    },
    {
      fullUrl: 'urn:uuid:e2789df9-1bfd-4328-8622-6a2c5715d795',
      resource: {
        resourceType: 'Provenance',
        // Patient contribution on a collection is asserted per record, because
        // there is no Composition to carry it once for the whole payload.
        target: [{ reference: 'urn:uuid:48609a2e-53aa-4f5b-b13f-a33c1856875f' }],
        recorded: '2026-08-16T21:15:00.000Z',
        agent: [
          {
            type: {
              coding: [
                {
                  system: 'http://terminology.hl7.org/CodeSystem/provenance-participant-type',
                  code: 'author',
                  display: 'Author',
                },
              ],
            },
            // Display only, and for the same reason as the document's claimed
            // agent: with no Patient entry there is nothing to reference.
            who: { display: 'Patient' },
          },
        ],
      },
    },
    {
      fullUrl: 'urn:uuid:bef45485-40e5-4a86-9bf8-f58c966a73d5',
      resource: {
        resourceType: 'Provenance',
        target: [{ reference: 'urn:uuid:e11424c6-3e99-4f3b-a1fb-3db894bc26d2' }],
        recorded: '2026-08-19T09:02:44.900Z',
        agent: [
          {
            type: {
              coding: [
                {
                  system: 'http://terminology.hl7.org/CodeSystem/provenance-participant-type',
                  code: 'author',
                  display: 'Author',
                },
              ],
            },
            // The second of the three claim wordings: the name was found inside
            // the received content rather than on the link's label.
            who: { display: 'Shared link whose contents name “WA Health”' },
          },
        ],
      },
    },
  ],
};
