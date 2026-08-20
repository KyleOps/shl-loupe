/**
 * Checks: every check SHLoupe runs, and the differential for the one thing it
 * cannot check.
 *
 * The list is GENERATED from `STATIC_RULES`, not typed out beside it. That is the
 * whole design of this screen: a rule added to the engine appears here without
 * anybody remembering to document it, and a rule described but not implemented
 * fails `spec-guide.test.ts` rather than quietly misleading a reader. The
 * screen's own contribution is arrangement: grouped by subject, worst severity
 * first inside a group, each rule with the id a report will quote.
 *
 * The screen leads with a limit rather than a feature, because the limit is the
 * thing people most often mistake for a defect in this tool. A browser will not
 * say why a cross-origin request failed, and that is a deliberate privacy
 * property of the platform rather than an oversight: a page that could tell a
 * refused connection from an unknown host is a port scanner. So the honest
 * offering is a ranked differential with a discriminating test per branch, which
 * is what the second half of this page is.
 */
import { useMemo, type ReactNode } from 'react';
import { Network, ScanSearch, Terminal } from 'lucide-react';
import type { Audience, Severity } from '../../core/trace';
import { STATIC_RULES, type Rule } from '../../core/diagnose/rules';
import type { CauseId } from '../../core/diagnose/differential';
import {
  DIFFERENTIAL_NOTES,
  RULE_GROUPS,
  RULE_GUIDE,
  type DifferentialNote,
  type RuleGuideEntry,
} from '../../content/spec-guide';
import {
  Callout,
  Chip,
  CopyButton,
  StatusIcon,
  toneForSeverity,
  type Tone,
} from '../../ui/primitives';
import { PageNav, type PageNavItem } from '../PageNav';

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/*
 * The rail. Two sections, which is few enough that the rail is really doing the
 * other half of its job on this page: giving a long column of prose something to
 * sit beside, so the page reads as a page rather than as text pushed against the
 * left edge of a very wide window.
 */
const NAV_ITEMS: readonly PageNavItem[] = [
  { anchor: 'rules-static', label: 'Checks before a request' },
  { anchor: 'rules-differential', label: 'The differential' },
];

/** Who has to act, in words a reader can use in a sentence to somebody else. */
const AUDIENCE_WORDS: Record<Audience, string> = {
  you: 'You, here, in this viewer',
  sender: 'Whoever minted the link',
  server: 'Whoever operates the sharing server',
  nobody: 'Nobody: this one is informational',
};

const OWNER_WORDS: Record<DifferentialNote['owner'], string> = {
  sender: 'Whoever minted the link',
  server: 'Whoever operates the server',
  you: 'You, in this browser',
  network: 'The network you are on',
};

const SEVERITY_ORDER: Record<Severity, number> = {
  fatal: 0,
  error: 1,
  warning: 2,
  info: 3,
  good: 4,
};

/** The severity word is the label, so the colour is never the only carrier. */
function SeverityTag({ severity }: { severity: Severity }): ReactNode {
  const tone: Tone = toneForSeverity(severity);
  return (
    <span className={`rules-severity tone tone-${tone}`}>
      <StatusIcon tone={tone} />
      <span>{severity}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Joining the engine to its documentation
// ---------------------------------------------------------------------------

interface DescribedRule {
  rule: Rule;
  entry: RuleGuideEntry | undefined;
}

interface RuleGroupView {
  id: string;
  title: string;
  blurb: string;
  rules: readonly DescribedRule[];
}

/**
 * Group the engine's rules by the subject the guide assigns them.
 *
 * A rule the guide does not describe still appears, in a trailing group of its
 * own. A test forbids that state, so the group should always be empty; rendering
 * it anyway means the failure mode is a visible gap on the page rather than a
 * check that silently stopped being listed.
 */
function groupRules(): readonly RuleGroupView[] {
  const entries = new Map(RULE_GUIDE.map((entry) => [entry.ruleId, entry]));
  const described = STATIC_RULES.map((rule) => ({ rule, entry: entries.get(rule.id) }));

  const byRank = (a: DescribedRule, b: DescribedRule): number =>
    SEVERITY_ORDER[a.entry?.severity ?? 'info'] - SEVERITY_ORDER[b.entry?.severity ?? 'info'];

  const groups: RuleGroupView[] = RULE_GROUPS.map((group) => ({
    id: group.id,
    title: group.title,
    blurb: group.blurb,
    rules: described.filter((item) => item.entry?.group === group.id).sort(byRank),
  }));

  const orphans = described.filter((item) => item.entry === undefined).sort(byRank);
  if (orphans.length > 0) {
    groups.push({
      id: 'undescribed',
      title: 'Not yet described',
      blurb:
        'These checks run, and this page has nothing to say about them yet. That is a gap in the guide, not in the engine.',
      rules: orphans,
    });
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export function RulesScreen(): ReactNode {
  const groups = useMemo(() => groupRules(), []);
  const causes = useMemo(
    () => Object.entries(DIFFERENTIAL_NOTES) as ReadonlyArray<[CauseId, DifferentialNote]>,
    [],
  );

  return (
    <div className="rules">
      <div className="page-body">
        <PageNav items={NAV_ITEMS} label="Sections of this page" />

        <div className="page-column">
          {/* The intro and the caveat share the top row: otherwise the page opens
              with a 560px column of prose and 650px of empty reading area beside
              it, which sets the reader's expectation for everything below. */}
          <div className="rules-intro">
            <header className="rules-head">
              <h1>Every check, and the one nobody can make</h1>
              <p className="rules-lede">
                {STATIC_RULES.length} checks run against a link before any request goes out, so a
                link that cannot work is diagnosed without spending a request to prove it. Each one
                carries an id, because an id is what a report quotes and what a conversation can
                refer to without re-litigating the wording.
              </p>
              <p className="rules-lede">
                These are checks against the base specification. A downstream profile adds
                requirements of its own, and failing one of those is a different statement from
                being invalid: those are reported per link, beside the payload, against the profile
                that adds them.
              </p>
            </header>

            <Callout tone="info" title="What a browser will not tell this page, and why">
              When a cross-origin request fails, the browser hands JavaScript a bare TypeError. It
              knows whether the name failed to resolve, the connection was refused, the certificate
              was rejected, or the response arrived without the header that would let this page read
              it, and it withholds all four on purpose: a page that could tell those apart would be
              a port scanner, usable from any site you visited to map the machine and the network
              you are sitting on. So no client-side tool can name the cause, this one included. What
              it can do is list the candidates, rank them by everything else it knows, and give each
              one a test that settles it from a shell, where CORS does not exist.
            </Callout>
          </div>

          <section className="rules-section" aria-labelledby="rules-static" tabIndex={-1}>
            <h2 id="rules-static">
              <ScanSearch size={16} aria-hidden />
              <span>Checks made before any request</span>
            </h2>
            {groups.map((group) => (
              <section
                className="rules-group"
                key={group.id}
                aria-labelledby={`rules-group-${group.id}`}
              >
                <h3 id={`rules-group-${group.id}`}>{group.title}</h3>
                <p className="rules-group-blurb">{group.blurb}</p>
                {group.rules.length === 0 ? (
                  <p className="rules-empty">No checks in this group.</p>
                ) : (
                  <ul className="rules-list">
                    {group.rules.map(({ rule, entry }) => (
                      <li className="rules-rule" key={rule.id}>
                        <div className="rules-rule-head">
                          <code className="rules-id">{rule.id}</code>
                          <CopyButton value={rule.id} label="Copy id" />
                          {entry !== undefined && <SeverityTag severity={entry.severity} />}
                        </div>
                        <p className="rules-about">{rule.about}</p>
                        {entry !== undefined && (
                          <>
                            <dl className="rules-facts">
                              <dt>Who has to act</dt>
                              <dd>{AUDIENCE_WORDS[entry.audience]}</dd>
                              <dt>What makes it fire</dt>
                              <dd>{entry.fires}</dd>
                            </dl>
                            {entry.severityVaries !== undefined && (
                              <p className="rules-varies">
                                <Chip tone="warn">Severity varies</Chip>
                                <span>{entry.severityVaries}</span>
                              </p>
                            )}
                            {entry.tryPreset !== undefined && (
                              <p className="rules-preset">
                                <a
                                  className="btn btn-ghost btn-sm"
                                  href={`#/sandbox?preset=${entry.tryPreset}`}
                                >
                                  <Terminal size={13} aria-hidden />
                                  <span>Mint a link that trips this</span>
                                </a>
                              </p>
                            )}
                          </>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            ))}
          </section>

          <section className="rules-section" aria-labelledby="rules-differential" tabIndex={-1}>
            <h2 id="rules-differential">
              <Network size={16} aria-hidden />
              <span>The differential for a failed request</span>
            </h2>
            <p className="rules-group-blurb">
              {causes.length} candidate causes. On a real run they are ranked by what else is known:
              the URL itself, how long the request took before it gave up, and whatever the opt-in
              probes were allowed to establish. The descriptions below are the standing ones,
              independent of any particular link, and each carries the cheapest test that confirms
              or eliminates it.
            </p>
            <ul className="rules-list">
              {causes.map(([id, note]) => (
                <li className="rules-cause" key={id}>
                  <div className="rules-rule-head">
                    <code className="rules-id">{id}</code>
                    <CopyButton value={id} label="Copy id" />
                  </div>
                  <h3>{note.title}</h3>
                  <p>{note.what}</p>
                  <dl className="rules-facts">
                    <dt>How to settle it</dt>
                    <dd>{note.discriminator}</dd>
                    <dt>Who has to act</dt>
                    <dd>{OWNER_WORDS[note.owner]}</dd>
                  </dl>
                </li>
              ))}
            </ul>
            <Callout tone="warn" title="A green curl proves nothing about a browser">
              CORS is enforced by browsers and by nothing else, so a server with no CORS headers
              answers curl perfectly. That is why a sender who tested with curl is genuinely,
              reasonably confident their link is fine. Run the preflight from the Learn screen and
              read the response headers rather than the status: a 200 carrying no
              Access-Control-Allow-Origin is the failure.
            </Callout>
          </section>
        </div>
      </div>
    </div>
  );
}
