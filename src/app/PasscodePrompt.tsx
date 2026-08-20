/**
 * The one place in this tool that can destroy the thing it was asked to inspect.
 *
 * A sharing server counts wrong passcodes against a lifetime limit and disables
 * the link permanently when that limit is reached. There is no cooling-off
 * period and no reset: the patient's share is gone and the sender has to mint a
 * new one. So the rules here are absolute, and they are all about restraint.
 *
 *  - The consequence is stated BEFORE the field, not after, and not in a
 *    tooltip.
 *  - The remaining count is shown when the server gave one, and its absence is
 *    reported as absence rather than as a comfortable-looking blank.
 *  - One attempt per press. No auto-submit on mount, no retry on failure, no
 *    "test the connection" probe carrying a guess, and a guard that survives
 *    React's development double-invoke, because two renders spending two of
 *    somebody's attempts on one guess is the exact defect this file exists to
 *    prevent.
 */
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { KeyRound } from 'lucide-react';
import type { TraceRun } from '../core/trace';
import { Button, Callout, Chip } from '../ui/primitives';
import { useSettings } from './store';

export interface PasscodeState {
  /** A passcode is what stands between this run and its content. */
  needed: boolean;
  /** The server has rejected at least one attempt during this run. */
  rejected: boolean;
  /** What the server said. Undefined means it did not say, not that it is fine. */
  remainingAttempts?: number;
  /** The server said zero remain, so there is nothing left to try. */
  exhausted: boolean;
}

const IDLE: PasscodeState = { needed: false, rejected: false, exhausted: false };

/**
 * Read the passcode situation out of a recorded run.
 *
 * The count comes from the 401 response body rather than from the finding text,
 * because the finding is prose written for a human and the number has to be
 * exact. `remainingAttempts` is the only spelling the specification defines;
 * `attemptsRemaining` and `remaining_attempts` are read by nothing, so a server
 * that sends one of those is treated as having sent no count at all, which is
 * what the warning about an absent count is for.
 */
export function passcodeState(run: TraceRun | undefined): PasscodeState {
  if (!run) return IDLE;
  const required = run.findings.some((finding) => finding.ruleId === 'SHL-PASSCODE-REQUIRED');
  const rejected = run.findings.some((finding) => finding.ruleId === 'SHL-PASSCODE-WRONG');
  if (!required && !rejected) return IDLE;

  let remaining: number | undefined;
  for (const step of run.steps) {
    for (const evidence of step.evidence) {
      if (evidence.type !== 'response') continue;
      if (evidence.response.status !== 401) continue;
      const body = evidence.response.bodyPreview;
      if (body === undefined) continue;
      const parsed = parseRemaining(body);
      // Last one wins: a run may carry several attempts, and only the newest
      // count is still true.
      if (parsed !== undefined) remaining = parsed;
    }
  }

  return {
    needed: true,
    rejected,
    ...(remaining === undefined ? {} : { remainingAttempts: remaining }),
    exhausted: remaining === 0,
  };
}

function parseRemaining(body: string): number | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const value = (parsed as { remainingAttempts?: unknown }).remainingAttempts;
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function PasscodePrompt({
  run,
  running,
  onSubmit,
}: {
  run: TraceRun | undefined;
  running: boolean;
  onSubmit: (passcode: string) => void;
}): ReactNode {
  const state = passcodeState(run);
  const reveal = useSettings((settings) => settings.revealSecrets);
  const [passcode, setPasscode] = useState('');
  const [sent, setSent] = useState(false);

  // A new run is a new attempt, so the one-press guard lifts only when the run
  // it was guarding has actually been replaced.
  useEffect(() => setSent(false), [run?.id]);

  if (!state.needed) return null;

  if (state.exhausted) {
    return (
      <Callout tone="fail" title="That was the last attempt this link allowed.">
        The server counts wrong passcodes against a lifetime limit so nobody can search for the
        passcode by trying every value. The limit is now reached, which disables this link
        permanently: further requests will answer 404 whatever passcode is sent. Ask the sender for a
        new link.
      </Callout>
    );
  }

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (sent || running || passcode.length === 0) return;
    setSent(true);
    onSubmit(passcode);
  };

  return (
    <form className="passcode" onSubmit={submit}>
      <div className="passcode-head">
        <h2 className="passcode-title">
          <KeyRound size={16} aria-hidden />
          {state.rejected ? 'That passcode was rejected' : 'This link needs a passcode'}
        </h2>
        {state.remainingAttempts === undefined ? (
          <Chip tone={state.rejected ? 'warn' : 'info'}>Attempts left unknown</Chip>
        ) : (
          <Chip tone={state.remainingAttempts <= 1 ? 'fail' : 'warn'}>
            {state.remainingAttempts} attempt{state.remainingAttempts === 1 ? '' : 's'} left
          </Chip>
        )}
      </div>

      <p className="passcode-warning">
        Every wrong passcode is counted against a limit the sharing server enforces for the life of
        this link. When that limit is reached the link is disabled permanently: there is no waiting
        period and no reset, and the sender has to issue a new one.{' '}
        {state.remainingAttempts === undefined
          ? state.rejected
            ? 'This server did not say how many attempts are left, so treat the next press as if it were the last.'
            : 'This server has not said how many attempts it allows, so treat the next press as if it were the last.'
          : state.remainingAttempts === 1
            ? 'One attempt is left. Get the passcode from the sender before pressing this.'
            : `${state.remainingAttempts} attempts are left after this one is counted.`}
      </p>

      <div className="passcode-row">
        <label className="visually-hidden" htmlFor="passcode-field">
          Passcode
        </label>
        <input
          id="passcode-field"
          className="text-field"
          type={reveal ? 'text' : 'password'}
          autoComplete="off"
          spellCheck={false}
          value={passcode}
          onChange={(event) => setPasscode(event.target.value)}
          disabled={running || sent}
        />
        <Button
          type="submit"
          variant="primary"
          disabled={running || sent || passcode.length === 0}
        >
          {sent || running ? 'Sending one attempt…' : 'Send this passcode once'}
        </Button>
      </div>

      <p className="passcode-note">
        Loupe sends exactly one attempt per press. It never retries, never guesses, and never sends a
        passcode as part of a probe.
      </p>
    </form>
  );
}
