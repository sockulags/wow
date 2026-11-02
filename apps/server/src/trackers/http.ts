// What both tracker clients share: the minimal issue they create, what they answer with, and how
// a failed request becomes a message the user can act on.

export interface NewIssue {
  readonly title: string;
  // Markdown, as written in the backlog item. Each client turns it into what its tracker renders.
  readonly body: string;
  // Labels the user picked from the item's tags in the preview.
  readonly labels?: readonly string[];
}

export interface CreatedIssue {
  readonly key: string;
  readonly url: string;
}

export interface RequestOptions {
  readonly timeoutMs: number;
  readonly fetch?: typeof fetch;
}

// The tracker refused the issue or could not be reached. The message is shown to the user as is.
export class TrackerError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'TrackerError';
  }
}

export const trimBase = (url: string) => url.trim().replace(/\/+$/, '');

export async function postJson(
  service: string,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  options: RequestOptions,
): Promise<unknown> {
  const send = options.fetch ?? globalThis.fetch;
  let response: Response;
  try {
    response = await send(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  } catch (error) {
    const reason =
      error instanceof Error && error.name === 'TimeoutError'
        ? `no answer within ${options.timeoutMs} ms`
        : error instanceof Error
          ? error.message
          : String(error);
    throw new TrackerError(`${service} could not be reached: ${reason}`);
  }
  const text = await response.text();
  const parsed = parseJson(text);
  if (!response.ok) {
    const detail = errorDetail(parsed) ?? (text.trim().slice(0, 300) || response.statusText);
    throw new TrackerError(
      `${service} answered ${response.status}${detail ? `: ${detail}` : ''}`,
      response.status,
    );
  }
  return parsed;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// Jira answers {errorMessages: [], errors: {field: message}}; GitHub {message, errors: [...]}.
function errorDetail(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined;
  const parts: string[] = [];
  if (typeof body['message'] === 'string') parts.push(body['message']);
  if (Array.isArray(body['errorMessages'])) {
    parts.push(...body['errorMessages'].filter((entry) => typeof entry === 'string'));
  }
  const errors = body['errors'];
  if (isRecord(errors)) {
    for (const [name, message] of Object.entries(errors)) parts.push(`${name}: ${String(message)}`);
  } else if (Array.isArray(errors)) {
    for (const entry of errors) {
      if (isRecord(entry) && typeof entry['message'] === 'string') parts.push(entry['message']);
      else if (isRecord(entry) && typeof entry['code'] === 'string') {
        parts.push(`${String(entry['field'] ?? entry['resource'] ?? 'issue')} ${entry['code']}`);
      }
    }
  }
  return parts.length > 0 ? parts.join('; ') : undefined;
}

export function field(body: unknown, name: string): unknown {
  return isRecord(body) ? body[name] : undefined;
}
