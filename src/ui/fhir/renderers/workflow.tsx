/**
 * Plans, teams, requests, encounters, lists and `Provenance`.
 *
 * **`Provenance` is the reason this module gets real attention.** It has had no
 * renderer in the incumbent viewer since 2023 (two open issues), and it is how
 * Platypus states where every entry in a shared payload came from: the origin
 * claim relates to its records by `target` rather than sitting in a
 * `Composition.section`, so a viewer that only renders section entries never
 * shows it at all. Two invisibilities compound into "the payload does not say
 * where this came from", which is the opposite of the truth.
 *
 * Four things the `Provenance` card has to get right:
 *
 *  1. **A display-only agent is presented verbatim.** Platypus emits an agent
 *     whose `who` carries a `display` and no `reference`, with wording that states
 *     the basis of the name ("Shared link labelled “WA Health Summary”", curly
 *     quotes included) precisely because nothing verified it. Present that string
 *     as it arrived. Do not tidy it, do not substitute "Unknown organisation", and
 *     do not mint a party for it.
 *  2. **One Provenance can target dozens of entries.** A row per target is a
 *     wall, so targets are summarised and listed on demand.
 *  3. **`recorded` is when the assertion was made**, which is not the date of
 *     anything it targets. Conflating them backdates the claim.
 *  4. **`activity.text` can carry the meaning the code cannot.** An adjudication
 *     ("this version was kept, and why") has no FHIR vocabulary, so the coding
 *     says `UPDATE` and the sentence is in `text`. Render the coding display and
 *     the reader learns "revise", which tells them nothing.
 */
import type { ReactNode } from 'react';
import { Chip, Disclosure } from '../../primitives';
import { DetailTable, ResourceCard, type RendererProps } from '../ResourceCard';
import {
  Absent,
  ConceptList,
  ConceptValue,
  DateValue,
  ReferenceValue,
  type RenderContext,
} from '../UnknownResource';
import { ChoiceValue, NoteList } from './clinical';
import {
  arrField,
  asRecord,
  codeableConcept,
  codeableConceptText,
  codeToWords,
  strField,
  summariseResource,
} from '../display';

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

export type AgentBasis = 'referenced' | 'stated' | 'unnamed';

export interface ProvenanceAgent {
  /** The wording to show, exactly as the payload wrote it. */
  name?: string;
  basis: AgentBasis;
  role?: string;
  who: unknown;
}

/**
 * Read one `Provenance.agent`.
 *
 * The `basis` is the whole point: a party the payload points at is a party
 * something in the bundle can be checked against, and a party it merely names is
 * a claim. Both are legitimate, and a viewer that renders them identically has
 * destroyed the distinction the sender took care to make.
 */
export function readAgent(agent: unknown): ProvenanceAgent {
  const who = asRecord(agent)?.['who'];
  const role = codeableConceptText(asRecord(agent)?.['type']);
  const reference = strField(who, 'reference');
  const display = strField(who, 'display');
  if (reference !== undefined) {
    return {
      basis: 'referenced',
      who,
      ...(display === undefined ? {} : { name: display }),
      ...(role === undefined ? {} : { role }),
    };
  }
  if (display !== undefined) {
    return { basis: 'stated', who, name: display, ...(role === undefined ? {} : { role }) };
  }
  return { basis: 'unnamed', who, ...(role === undefined ? {} : { role }) };
}

export function ProvenanceCard({ resource, context, entry }: RendererProps): ReactNode {
  const agents = arrField(resource, 'agent').map((agent) => readAgent(agent));
  const targets = arrField(resource, 'target');
  const activity = resource['activity'];
  const activityText = strField(activity, 'text');
  const activityCode = codeableConcept(activity);
  const stated = agents.filter((agent) => agent.basis === 'stated');

  return (
    <ResourceCard
      resource={resource}
      context={context}
      entry={entry}
      title={provenanceHeading(agents, targets.length)}
      chips={
        <>
          <Chip tone="info">
            {targets.length} {targets.length === 1 ? 'target' : 'targets'}
          </Chip>
          {stated.length > 0 && (
            <Chip
              tone="warn"
              title="An agent named in text with nothing in the bundle behind it. The name is the sender's claim."
            >
              {stated.length === agents.length ? 'Named, not referenced' : 'One agent named only'}
            </Chip>
          )}
        </>
      }
    >
      <DetailTable
        rows={[
          {
            key: 'recorded',
            value: <DateValue value={resource['recorded']} />,
            note: 'When this assertion was made, which is when the payload was assembled. It is not the date of any record it targets.',
          },
          ...(resource['occurredPeriod'] === undefined && resource['occurredDateTime'] === undefined
            ? []
            : [
                {
                  key: 'occurred',
                  value: <ChoiceValue node={resource} base="occurred" context={context} />,
                  note: 'When the thing being described actually happened, kept separate so a span is never collapsed into one instant that misdescribes the earlier records.',
                },
              ]),
          ...(activity === undefined
            ? []
            : [
                {
                  key: 'activity',
                  value: (
                    <span>
                      {activityText ?? <ConceptValue value={activity} />}
                      {activityText !== undefined && activityCode?.codes[0] !== undefined && (
                        <span className="value-note mono">coded {activityCode.codes[0].label}</span>
                      )}
                    </span>
                  ),
                  note:
                    activityText !== undefined
                      ? 'Shown from activity.text, because the coding often cannot carry the meaning. A merge adjudication has no FHIR vocabulary, so the code says an update happened and the sentence says which version was kept and why.'
                      : undefined,
                },
              ]),
          ...(resource['reason'] === undefined
            ? []
            : [{ key: 'reason', value: <ConceptList value={resource['reason']} /> }]),
        ]}
      />

      <div className="provenance-agents">
        <h4>
          {agents.length} {agents.length === 1 ? 'agent' : 'agents'}
        </h4>
        {agents.length === 0 && (
          <p className="value-note">
            <span className="mono">Provenance.agent</span> is 1..*, so a Provenance with none states
            nothing about who is responsible, which is the one thing it exists to say.
          </p>
        )}
        {agents.map((agent, position) => (
          <AgentRow key={position} agent={agent} context={context} />
        ))}
      </div>

      <Disclosure
        summary={`What this Provenance is about: ${targets.length} ${targets.length === 1 ? 'entry' : 'entries'}`}
        defaultOpen={targets.length <= 3}
      >
        <DetailTable
          dense
          rows={targets.map((target, position) => {
            const resolution = context.index.resolve(target, context.from);
            const resource_ =
              resolution.kind === 'resolved'
                ? resolution.entry.resource
                : resolution.kind === 'contained'
                  ? resolution.resource
                  : undefined;
            return {
              key:
                resolution.kind === 'resolved'
                  ? resolution.entry.resourceType
                  : `target ${position + 1}`,
              value:
                resource_ === undefined ? (
                  <ReferenceValue value={target} context={context} />
                ) : (
                  <span className="provenance-target">
                    <span>{summariseResource(resource_)}</span>
                    <ReferenceValue value={target} context={context} label="Open the target" />
                  </span>
                ),
            };
          })}
        />
      </Disclosure>
    </ResourceCard>
  );
}

function provenanceHeading(agents: readonly ProvenanceAgent[], targets: number): string {
  const first = agents[0];
  const subject = `${targets} ${targets === 1 ? 'entry' : 'entries'}`;
  if (first === undefined) return `Origin of ${subject}, with no agent named`;
  if (first.name !== undefined) return `${first.name}, for ${subject}`;
  return `Origin of ${subject}`;
}

/**
 * One agent, with the basis of its name stated.
 *
 * The stated case gets the longest explanation on purpose: it is the shape a
 * receiving app most often mishandles, by presenting a claim as though the
 * payload had proved it.
 */
function AgentRow({
  agent,
  context,
}: {
  agent: ProvenanceAgent;
  context: RenderContext;
}): ReactNode {
  return (
    <div className="provenance-agent">
      <DetailTable
        dense
        rows={[
          {
            key: 'who',
            value:
              agent.basis === 'referenced' ? (
                <ReferenceValue value={agent.who} context={context} />
              ) : agent.basis === 'stated' ? (
                // Verbatim. The wording states the basis of the name and the
                // punctuation is part of it.
                <span className="stated-agent">{agent.name}</span>
              ) : (
                <Absent>This agent names nobody at all</Absent>
              ),
            tone: agent.basis === 'stated' ? 'warn' : undefined,
            note:
              agent.basis === 'stated'
                ? "Named in text with no reference, so nothing in this payload can be checked against it. The wording is the sender's own claim about where the name came from, and it is shown exactly as it arrived: a viewer that tidies it into an organisation name has invented a party the sender deliberately did not assert."
                : agent.basis === 'unnamed'
                  ? 'Provenance.agent.who is 1..1, so an agent with neither a reference nor a display is a defect: the assertion has no author.'
                  : undefined,
          },
          ...(agent.role === undefined
            ? []
            : [
                {
                  key: 'type',
                  value: agent.role,
                  note: 'The role this party played. author is the party responsible for the content; assembler is the one that put the payload together, which is a different claim.',
                },
              ]),
        ]}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// CarePlan, CareTeam, Goal
// ---------------------------------------------------------------------------

export function CarePlanCard({ resource, context, entry }: RendererProps): ReactNode {
  const activities = arrField(resource, 'activity');
  const addresses = arrField(resource, 'addresses');
  return (
    <ResourceCard
      resource={resource}
      context={context}
      entry={entry}
      title={strField(resource, 'title') ?? 'Care plan with no title'}
      subtitle={strField(resource, 'description')}
      chips={
        <>
          {strField(resource, 'status') !== undefined && (
            <Chip>{codeToWords(strField(resource, 'status') as string)}</Chip>
          )}
          {strField(resource, 'intent') !== undefined && (
            <Chip>{codeToWords(strField(resource, 'intent') as string)}</Chip>
          )}
        </>
      }
    >
      <DetailTable
        rows={[
          ...(resource['category'] === undefined
            ? []
            : [{ key: 'category', value: <ConceptList value={resource['category']} /> }]),
          ...(resource['period'] === undefined
            ? []
            : [{ key: 'period', value: <DateValue value={resource['period']} /> }]),
          ...(resource['subject'] === undefined
            ? []
            : [
                {
                  key: 'subject',
                  value: <ReferenceValue value={resource['subject']} context={context} />,
                },
              ]),
          ...(addresses.length === 0
            ? []
            : [
                {
                  key: 'addresses',
                  value: (
                    <span className="reference-list">
                      {addresses.map((value, position) => (
                        <ReferenceValue key={position} value={value} context={context} />
                      ))}
                    </span>
                  ),
                  note: 'The conditions this plan is about. A reference to one the payload does not carry renders without a tap-through rather than as a broken link.',
                },
              ]),
          ...(resource['careTeam'] === undefined
            ? []
            : [
                {
                  key: 'careTeam',
                  value: (
                    <span className="reference-list">
                      {arrField(resource, 'careTeam').map((value, position) => (
                        <ReferenceValue key={position} value={value} context={context} />
                      ))}
                    </span>
                  ),
                },
              ]),
          ...(resource['goal'] === undefined
            ? []
            : [
                {
                  key: 'goal',
                  value: (
                    <span className="reference-list">
                      {arrField(resource, 'goal').map((value, position) => (
                        <ReferenceValue key={position} value={value} context={context} />
                      ))}
                    </span>
                  ),
                },
              ]),
        ]}
      />
      {activities.length > 0 && (
        <div className="careplan-activities">
          <h4>
            {activities.length} {activities.length === 1 ? 'activity' : 'activities'}
          </h4>
          <DetailTable
            dense
            rows={activities.map((activity, position) => {
              const record = asRecord(activity) ?? {};
              const detail = asRecord(record['detail']);
              const reference = record['reference'];
              return {
                key:
                  codeableConceptText(detail?.['code']) ??
                  strField(detail, 'description') ??
                  `activity ${position + 1}`,
                value:
                  reference !== undefined ? (
                    <ReferenceValue value={reference} context={context} />
                  ) : detail !== undefined ? (
                    <span>
                      {strField(detail, 'description') ?? <ConceptValue value={detail['code']} />}
                      {strField(detail, 'status') !== undefined && (
                        <Chip>{codeToWords(strField(detail, 'status') as string)}</Chip>
                      )}
                    </span>
                  ) : (
                    <Absent>This activity states nothing</Absent>
                  ),
              };
            })}
          />
        </div>
      )}
      <NoteList resource={resource} />
    </ResourceCard>
  );
}

export function CareTeamCard({ resource, context, entry }: RendererProps): ReactNode {
  const participants = arrField(resource, 'participant');
  return (
    <ResourceCard
      resource={resource}
      context={context}
      entry={entry}
      title={strField(resource, 'name') ?? 'Care team with no name'}
      chips={
        strField(resource, 'status') === undefined ? undefined : (
          <Chip>{codeToWords(strField(resource, 'status') as string)}</Chip>
        )
      }
    >
      <DetailTable
        rows={[
          ...(resource['subject'] === undefined
            ? []
            : [
                {
                  key: 'subject',
                  value: <ReferenceValue value={resource['subject']} context={context} />,
                },
              ]),
          ...participants.map((participant, position) => {
            const record = asRecord(participant) ?? {};
            return {
              key: codeableConceptText(arrField(record, 'role')[0]) ?? `member ${position + 1}`,
              value: <ReferenceValue value={record['member']} context={context} />,
            };
          }),
          ...(participants.length === 0
            ? [{ key: 'participant', value: <Absent>Nobody is on this team</Absent> }]
            : []),
        ]}
      />
    </ResourceCard>
  );
}

export function GoalCard({ resource, context, entry }: RendererProps): ReactNode {
  const targets = arrField(resource, 'target');
  return (
    <ResourceCard
      resource={resource}
      context={context}
      entry={entry}
      title={codeableConceptText(resource['description']) ?? 'Goal with no description'}
      chips={
        <>
          {strField(resource, 'lifecycleStatus') !== undefined && (
            <Chip>{codeToWords(strField(resource, 'lifecycleStatus') as string)}</Chip>
          )}
          {resource['achievementStatus'] !== undefined && (
            <Chip tone="info">{codeableConceptText(resource['achievementStatus']) as string}</Chip>
          )}
        </>
      }
    >
      <DetailTable
        rows={[
          { key: 'description', value: <ConceptValue value={resource['description']} /> },
          ...(resource['startDate'] === undefined
            ? []
            : [{ key: 'startDate', value: <DateValue value={resource['startDate']} /> }]),
          ...targets.map((target, position) => {
            const record = asRecord(target) ?? {};
            return {
              key:
                codeableConceptText(record['measure']) ??
                (targets.length === 1 ? 'target' : `target ${position + 1}`),
              value: <ChoiceValue node={record} base="detail" context={context} />,
            };
          }),
          ...(resource['subject'] === undefined
            ? []
            : [
                {
                  key: 'subject',
                  value: <ReferenceValue value={resource['subject']} context={context} />,
                },
              ]),
        ]}
      />
      <NoteList resource={resource} />
    </ResourceCard>
  );
}

// ---------------------------------------------------------------------------
// Encounter, ServiceRequest, List, QuestionnaireResponse
// ---------------------------------------------------------------------------

export function EncounterCard({ resource, context, entry }: RendererProps): ReactNode {
  return (
    <ResourceCard
      resource={resource}
      context={context}
      entry={entry}
      title={
        codeableConceptText(arrField(resource, 'type')[0]) ??
        codeableConceptText(resource['class']) ??
        'Encounter'
      }
      chips={
        strField(resource, 'status') === undefined ? undefined : (
          <Chip>{codeToWords(strField(resource, 'status') as string)}</Chip>
        )
      }
    >
      <DetailTable
        rows={[
          ...(resource['class'] === undefined
            ? []
            : [
                {
                  key: 'class',
                  value: <ConceptValue value={{ coding: [resource['class']] }} />,
                  note: 'Inpatient, outpatient, emergency and so on: the setting rather than the reason.',
                },
              ]),
          ...(resource['period'] === undefined
            ? []
            : [{ key: 'period', value: <DateValue value={resource['period']} /> }]),
          ...(resource['type'] === undefined
            ? []
            : [{ key: 'type', value: <ConceptList value={resource['type']} /> }]),
          ...(resource['reasonCode'] === undefined
            ? []
            : [{ key: 'reasonCode', value: <ConceptList value={resource['reasonCode']} /> }]),
          ...(resource['subject'] === undefined
            ? []
            : [
                {
                  key: 'subject',
                  value: <ReferenceValue value={resource['subject']} context={context} />,
                },
              ]),
          ...(resource['serviceProvider'] === undefined
            ? []
            : [
                {
                  key: 'serviceProvider',
                  value: <ReferenceValue value={resource['serviceProvider']} context={context} />,
                },
              ]),
        ]}
      />
    </ResourceCard>
  );
}

export function ServiceRequestCard({ resource, context, entry }: RendererProps): ReactNode {
  return (
    <ResourceCard
      resource={resource}
      context={context}
      entry={entry}
      title={codeableConceptText(resource['code']) ?? 'Request with no code'}
      chips={
        <>
          {strField(resource, 'status') !== undefined && (
            <Chip>{codeToWords(strField(resource, 'status') as string)}</Chip>
          )}
          {strField(resource, 'intent') !== undefined && (
            <Chip>{codeToWords(strField(resource, 'intent') as string)}</Chip>
          )}
          {strField(resource, 'priority') !== undefined && (
            <Chip tone="warn">{codeToWords(strField(resource, 'priority') as string)}</Chip>
          )}
        </>
      }
    >
      <DetailTable
        rows={[
          { key: 'code', value: <ConceptValue value={resource['code']} /> },
          ...(resource['category'] === undefined
            ? []
            : [{ key: 'category', value: <ConceptList value={resource['category']} /> }]),
          ...(strField(resource, 'authoredOn') === undefined
            ? []
            : [{ key: 'authoredOn', value: <DateValue value={resource['authoredOn']} /> }]),
          ...(resource['occurrenceDateTime'] === undefined &&
          resource['occurrencePeriod'] === undefined &&
          resource['occurrenceTiming'] === undefined
            ? []
            : [
                {
                  key: 'occurrence',
                  value: <ChoiceValue node={resource} base="occurrence" context={context} />,
                },
              ]),
          ...(resource['subject'] === undefined
            ? []
            : [
                {
                  key: 'subject',
                  value: <ReferenceValue value={resource['subject']} context={context} />,
                },
              ]),
          ...(resource['requester'] === undefined
            ? []
            : [
                {
                  key: 'requester',
                  value: <ReferenceValue value={resource['requester']} context={context} />,
                },
              ]),
          ...(resource['reasonCode'] === undefined
            ? []
            : [{ key: 'reasonCode', value: <ConceptList value={resource['reasonCode']} /> }]),
        ]}
      />
      <NoteList resource={resource} />
    </ResourceCard>
  );
}

/**
 * `List` is how several producers group records, and its `emptyReason` carries
 * the same statement a `Composition.section` does: a list that is empty because
 * the patient has none is not the same as a list nobody filled in.
 */
export function ListCard({ resource, context, entry }: RendererProps): ReactNode {
  const items = arrField(resource, 'entry');
  const emptyReason = resource['emptyReason'];
  return (
    <ResourceCard
      resource={resource}
      context={context}
      entry={entry}
      title={strField(resource, 'title') ?? codeableConceptText(resource['code']) ?? 'List'}
      chips={
        <>
          {strField(resource, 'status') !== undefined && (
            <Chip>{codeToWords(strField(resource, 'status') as string)}</Chip>
          )}
          <Chip tone="info">
            {items.length} {items.length === 1 ? 'item' : 'items'}
          </Chip>
        </>
      }
    >
      {items.length === 0 && emptyReason !== undefined && (
        <div className="absence-row">
          <ConceptValue value={emptyReason} />
          <p className="value-note">
            The list is empty and the source said why, which is a statement rather than a gap.
          </p>
        </div>
      )}
      <DetailTable
        rows={[
          ...(resource['code'] === undefined
            ? []
            : [{ key: 'code', value: <ConceptValue value={resource['code']} /> }]),
          ...(strField(resource, 'date') === undefined
            ? []
            : [{ key: 'date', value: <DateValue value={resource['date']} /> }]),
          ...items.map((item, position) => {
            const record = asRecord(item) ?? {};
            const deleted = record['deleted'] === true;
            return {
              key: `item ${position + 1}`,
              value: (
                <span>
                  <ReferenceValue value={record['item']} context={context} />
                  {deleted && <Chip tone="warn">Removed from the list</Chip>}
                </span>
              ),
            };
          }),
        ]}
      />
    </ResourceCard>
  );
}

/**
 * `QuestionnaireResponse` as its answers, grouped by item.
 *
 * Deliberately not a form renderer. Laying the answers back out as the original
 * questionnaire requires the `Questionnaire` itself, which a payload almost never
 * carries, and a viewer that invents the question text has put words in the
 * clinician's mouth. The `linkId` and the question text the response itself
 * carries are what there is, so that is what is shown.
 */
export function QuestionnaireResponseCard({ resource, context, entry }: RendererProps): ReactNode {
  return (
    <ResourceCard
      resource={resource}
      context={context}
      entry={entry}
      title={strField(resource, 'questionnaire') ?? 'Questionnaire response'}
      chips={
        strField(resource, 'status') === undefined ? undefined : (
          <Chip>{codeToWords(strField(resource, 'status') as string)}</Chip>
        )
      }
    >
      <DetailTable
        rows={[
          ...(strField(resource, 'authored') === undefined
            ? []
            : [{ key: 'authored', value: <DateValue value={resource['authored']} /> }]),
          ...(resource['subject'] === undefined
            ? []
            : [
                {
                  key: 'subject',
                  value: <ReferenceValue value={resource['subject']} context={context} />,
                },
              ]),
          ...(resource['author'] === undefined
            ? []
            : [
                {
                  key: 'author',
                  value: <ReferenceValue value={resource['author']} context={context} />,
                },
              ]),
          ...(strField(resource, 'questionnaire') === undefined
            ? []
            : [
                {
                  key: 'questionnaire',
                  value: strField(resource, 'questionnaire') as string,
                  mono: true,
                  note: 'The canonical of the form that was filled in. SHLoupe does not fetch it, so the question wording below is only what the response itself carried.',
                },
              ]),
        ]}
      />
      <div className="questionnaire-items">
        <QuestionnaireItems items={arrField(resource, 'item')} context={context} depth={0} />
      </div>
    </ResourceCard>
  );
}

function QuestionnaireItems({
  items,
  context,
  depth,
}: {
  items: readonly unknown[];
  context: RenderContext;
  depth: number;
}): ReactNode {
  if (items.length === 0) {
    return <p className="value-note">This response carries no items, so nothing was answered.</p>;
  }
  if (depth > 6) {
    return <p className="value-note">Nesting deeper than six levels; open the JSON view.</p>;
  }
  return (
    <ol className="qr-items">
      {items.map((item, position) => {
        const record = asRecord(item) ?? {};
        const answers = arrField(record, 'answer');
        const nested = [
          ...arrField(record, 'item'),
          ...answers.flatMap((answer) => arrField(answer, 'item')),
        ];
        return (
          <li key={position}>
            <span className="qr-question">
              {strField(record, 'text') ?? strField(record, 'linkId') ?? `item ${position + 1}`}
            </span>
            {strField(record, 'text') !== undefined && strField(record, 'linkId') !== undefined && (
              <span className="value-note mono">{strField(record, 'linkId') as string}</span>
            )}
            {answers.length === 0 && nested.length === 0 && (
              <span className="qr-answer">
                <Absent>Not answered</Absent>
              </span>
            )}
            {answers.map((answer, answerPosition) => (
              <span key={answerPosition} className="qr-answer">
                <ChoiceValue node={asRecord(answer) ?? {}} base="value" context={context} />
              </span>
            ))}
            {nested.length > 0 && (
              <QuestionnaireItems items={nested} context={context} depth={depth + 1} />
            )}
          </li>
        );
      })}
    </ol>
  );
}
