import {
  alwaysStops,
  changeRequestName,
  type GateCondition,
  type GatePart,
  type GatePartResult,
  type HostKind,
  type WorkflowStep,
} from '@wow/contracts';

// The condition of a gate after a step (review loop spec 54 to 57). Pure: each part is judged
// from what the server reports, never by a model. The verdict is the last line of the step's
// final message, as `check-work` writes it.

// What the host last showed about the checks of the run's pull request, read after the step
// ended. The server builds it from the stored host read; the engine words it and decides.
// `host` words it as GitLab's merge request or GitHub's pull request; GitHub when absent.
interface Numbered {
  readonly number: number;
  readonly host?: HostKind;
}
export type ChecksReading =
  | (Numbered & { readonly state: 'success'; readonly checks: readonly string[] })
  | (Numbered & { readonly state: 'failure'; readonly failing: readonly string[] })
  | (Numbered & { readonly state: 'pending'; readonly running: readonly string[] })
  // The pull request has no check at all (yet).
  | (Numbered & { readonly state: 'none' })
  // No pull request was found for the branch the run is on; null while it is on none.
  | { readonly state: 'noPullRequest'; readonly branch: string | null; readonly host?: HostKind }
  // The host is not set up for the project, so no later read can help.
  | { readonly state: 'notSetUp'; readonly message: string }
  // The host could not be asked this time.
  | { readonly state: 'unavailable'; readonly message: string };

export interface GateSettings {
  // The `workflows.verdictApprovedLine` setting for the run's project.
  readonly verdictApprovedLine: string;
  // The `workflows.alwaysStopSkills` setting for the run's project; the four defaults always
  // count as well.
  readonly alwaysStopSkills: readonly string[];
  // The `workflows.gateChecksTimeoutMinutes` setting for the run's project.
  readonly gateChecksTimeoutMinutes: number;
}

// The condition that applies to the gate after the step: none without a gate, without parts or
// for a skill that always stops.
export function gateCondition(
  step: WorkflowStep,
  settings: Pick<GateSettings, 'alwaysStopSkills'>,
): GateCondition | undefined {
  if (!step.gateAfter || !step.gateAfterCondition || step.gateAfterCondition.length === 0) {
    return undefined;
  }
  if (alwaysStops(step.skillName, settings.alwaysStopSkills)) return undefined;
  return step.gateAfterCondition;
}

// An agent may write the verdict as `APPROVED` or **APPROVED**. Those two wrappings are taken
// off, in any order, and nothing else is.
function unwrapped(line: string): string {
  let text = line.trim();
  for (;;) {
    const inner =
      text.length > 4 && text.startsWith('**') && text.endsWith('**')
        ? text.slice(2, -2)
        : text.length > 2 && text.startsWith('`') && text.endsWith('`')
          ? text.slice(1, -1)
          : undefined;
    if (inner === undefined) return text;
    text = inner.trim();
  }
}

// The last line of the message that is not empty, without backticks or bold around it.
export function verdictLine(message: string): string {
  const lines = message
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  return unwrapped(lines.at(-1) ?? '');
}

const quoted = (text: string): string => `"${text.length > 80 ? `${text.slice(0, 77)}...` : text}"`;

const result = (
  part: GatePart,
  state: GatePartResult['state'],
  detail: string,
): GatePartResult => ({
  part,
  state,
  detail,
});

export function verdictPart(message: string, approvedLine: string): GatePartResult {
  const expected = approvedLine.trim();
  const line = verdictLine(message);
  if (expected === '') {
    return result('verdict', 'failed', 'No approved verdict line is set in the settings');
  }
  if (line === '') return result('verdict', 'failed', 'The step left no final message');
  return line === expected
    ? result('verdict', 'held', `The final message ends with ${expected}`)
    : result('verdict', 'failed', `The final message ends with ${quoted(line)}, not ${expected}`);
}

export function artifactsPart(
  expected: readonly string[],
  missing: readonly string[],
): GatePartResult {
  if (expected.length === 0) {
    return result('artifacts', 'failed', 'The step names no expected artifacts to look for');
  }
  const absent = expected.filter((glob) => missing.includes(glob));
  return absent.length === 0
    ? result('artifacts', 'held', `Found a file for ${expected.join(', ')}`)
    : result('artifacts', 'failed', `Nothing found for ${absent.join(', ')}`);
}

const names = (list: readonly string[]): string => list.join(', ');

const titled = ({ number, host }: Numbered): string =>
  changeRequestName({ host: host ?? 'github', number });
const inSentence = (reading: Numbered): string => {
  const name = titled(reading);
  return name.charAt(0).toLowerCase() + name.slice(1);
};

// The checks part from a reading. `pending` means a later read may still settle it.
export function checksPart(reading: ChecksReading): GatePartResult {
  switch (reading.state) {
    case 'success':
      return result(
        'checks',
        'held',
        `Every check of ${inSentence(reading)} is successful (${names(reading.checks)})`,
      );
    case 'failure':
      return result(
        'checks',
        'failed',
        `${titled(reading)} has failing checks: ${names(reading.failing)}`,
      );
    case 'pending':
      return result(
        'checks',
        'pending',
        reading.running.length > 0
          ? `Checks of ${inSentence(reading)} are still running: ${names(reading.running)}`
          : `Checks of ${inSentence(reading)} are still running`,
      );
    case 'none':
      return result('checks', 'pending', `${titled(reading)} shows no checks yet`);
    case 'noPullRequest': {
      const noun = reading.host === 'gitlab' ? 'merge request' : 'pull request';
      return result(
        'checks',
        'pending',
        reading.branch === null
          ? `The run is on no branch yet, so it has no ${noun}`
          : `No ${noun} found yet for branch ${reading.branch}`,
      );
    }
    case 'notSetUp':
      return result('checks', 'failed', reading.message);
    case 'unavailable':
      return result('checks', 'pending', reading.message);
  }
}

export const checksNotReadYet = (): GatePartResult =>
  result('checks', 'pending', "Waiting for the host to show the pull request's checks");

export const checksNotLookedAt = (): GatePartResult =>
  result('checks', 'pending', 'Not looked at, because another part did not hold');

// A checks part that stayed pending for the whole wait fails with what was last seen.
export function checksTimedOut(last: GatePartResult, minutes: number): GatePartResult {
  const waited = `Checks were not successful within ${minutes} minute${minutes === 1 ? '' : 's'}`;
  return result('checks', 'failed', last.detail === '' ? waited : `${waited}. ${last.detail}`);
}

export const waitIsOver = (since: string, now: string, minutes: number): boolean =>
  Date.parse(now) - Date.parse(since) >= minutes * 60_000;
