/**
 * One table mapping a resource type to the component that renders it, and one
 * component that renders anything.
 *
 * The table is flat and complete on purpose. The incumbent viewer keeps the same
 * idea in a single object literal, and the thing that makes it dangerous is not
 * the table: it is what happens on a miss. It logs
 * `console.warn("fhirTables can't render: " + rtype)` and returns, so the
 * resource is simply absent from a page that looks complete, which is
 * indistinguishable from the server never having sent it.
 *
 * So the miss path here is a first-class rendering, and `hasRenderer` is exported
 * so a caller can COUNT what it is about to render generically and say so.
 * Nothing is ever dropped, and nothing is ever silently absent.
 */
import type { ReactNode } from 'react';
import { ErrorBoundary } from './ErrorBoundary';
import { ResourceCard, type RendererProps, type ResourceRenderer } from './ResourceCard';
import { UnknownResource, type RenderContext } from './UnknownResource';
import { resourceTypeOf, type FhirNode } from './display';
import type { IndexedEntry } from './BundleIndex';
import {
  CoverageCard,
  DeviceCard,
  OrganizationCard,
  PatientCard,
  PractitionerCard,
  PractitionerRoleCard,
  RelatedPersonCard,
} from './renderers/people';
import {
  AllergyCard,
  ConditionCard,
  DiagnosticReportCard,
  FlagCard,
  ImmunisationCard,
  ObservationCard,
  ProcedureCard,
  SpecimenCard,
} from './renderers/clinical';
import {
  MedicationAdministrationCard,
  MedicationCard,
  MedicationDispenseCard,
  MedicationRequestCard,
  MedicationStatementCard,
} from './renderers/medications';
import { BinaryCard, CompositionCard, DocumentReferenceCard } from './renderers/documents';
import {
  CarePlanCard,
  CareTeamCard,
  EncounterCard,
  GoalCard,
  ListCard,
  ProvenanceCard,
  QuestionnaireResponseCard,
  ServiceRequestCard,
} from './renderers/workflow';

/**
 * Thirty-one types, which is the whole IPS and AU PS entry inventory plus the
 * types a Platypus payload adds.
 *
 * `MedicationAdministration` reuses nothing: the incumbent points it at the
 * `MedicationStatement` renderer, which drops `effective[x]` versus `occurred[x]`
 * and the performer. Sharing a body is fine; sharing a renderer is how a type
 * ends up rendered as a different type.
 */
export const RESOURCE_RENDERERS: Readonly<Record<string, ResourceRenderer>> = {
  // Who
  Patient: PatientCard,
  Practitioner: PractitionerCard,
  PractitionerRole: PractitionerRoleCard,
  RelatedPerson: RelatedPersonCard,
  Organization: OrganizationCard,
  Device: DeviceCard,
  Coverage: CoverageCard,
  // Clinical statements
  Condition: ConditionCard,
  AllergyIntolerance: AllergyCard,
  Observation: ObservationCard,
  Procedure: ProcedureCard,
  DiagnosticReport: DiagnosticReportCard,
  Immunization: ImmunisationCard,
  Specimen: SpecimenCard,
  Flag: FlagCard,
  // Medicines
  MedicationStatement: MedicationStatementCard,
  MedicationRequest: MedicationRequestCard,
  MedicationDispense: MedicationDispenseCard,
  MedicationAdministration: MedicationAdministrationCard,
  Medication: MedicationCard,
  // Documents
  DocumentReference: DocumentReferenceCard,
  Binary: BinaryCard,
  Composition: CompositionCard,
  // Plans, requests, origin
  CarePlan: CarePlanCard,
  CareTeam: CareTeamCard,
  Goal: GoalCard,
  Encounter: EncounterCard,
  ServiceRequest: ServiceRequestCard,
  Provenance: ProvenanceCard,
  QuestionnaireResponse: QuestionnaireResponseCard,
  List: ListCard,
};

export function rendererFor(resourceType: string | undefined): ResourceRenderer | undefined {
  return resourceType === undefined ? undefined : RESOURCE_RENDERERS[resourceType];
}

export function hasRenderer(resourceType: string | undefined): boolean {
  return rendererFor(resourceType) !== undefined;
}

/** Every type with a purpose-built view, for the "what is covered" note. */
export const RENDERED_TYPES: readonly string[] = Object.keys(RESOURCE_RENDERERS).sort();

/**
 * Render one resource: its own view when there is one, the generic tree when
 * there is not, and never nothing.
 *
 * The error boundary sits here rather than inside each renderer so a type nobody
 * anticipated cannot take the page with it, and it is a ROW-level boundary: one
 * bad resource costs one card.
 */
export function RenderedResource({
  resource,
  context,
  entry,
}: {
  resource: FhirNode;
  context: RenderContext;
  entry?: IndexedEntry | undefined;
}): ReactNode {
  const type = resourceTypeOf(resource);
  const renderer = rendererFor(type);
  // The context is re-pointed at THIS entry, because a relative reference is
  // resolved against the base implied by its own entry's fullUrl. Passing the
  // section's context down would resolve a reference against the wrong base.
  const scoped: RenderContext = {
    index: context.index,
    ...(entry === undefined ? {} : { from: entry }),
  };
  const props: RendererProps = {
    resource,
    context: scoped,
    ...(entry === undefined ? {} : { entry }),
  };
  return (
    <ErrorBoundary label={`this ${type ?? 'resource'}`} unit="row" subject={resource}>
      {renderer === undefined ? (
        <GenericResourceCard resource={resource} context={context} entry={entry} />
      ) : (
        renderer(props)
      )}
    </ErrorBoundary>
  );
}

/**
 * The card for a type with no renderer, used where the caller wants the generic
 * view to be explicit rather than implied by an empty `Rendered` tab.
 */
export function GenericResourceCard({
  resource,
  context,
  entry,
}: {
  resource: FhirNode;
  context: RenderContext;
  entry?: IndexedEntry | undefined;
}): ReactNode {
  const scoped: RenderContext = {
    index: context.index,
    ...(entry === undefined ? {} : { from: entry }),
  };
  return (
    <ResourceCard resource={resource} context={scoped} entry={entry}>
      <UnknownResource resource={resource} context={scoped} />
    </ResourceCard>
  );
}
