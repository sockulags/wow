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
  // 'manual': a redirect is not followed but turned down. For a token in a header of its own,
  // which fetch would carry to whatever origin the redirect names (it only drops Authorization).
  readonly redirect?: 'manual';
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

// The headers of the answer a TrackerError came from, for a caller that reads the host's request
// limit from them. Kept beside the error, so the error stays a message and a status.
const answerHeaders = new WeakMap<TrackerError, Headers>();
export const headersOf = (error: TrackerError): Headers | undefined => answerHeaders.get(error);

export const trimBase = (url: string) => url.trim().replace(/\/+$/, '');

export async function postJson(
  service: string,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  options: RequestOptions,
): Promise<unknown> {
  return (await requestJson(service, 'POST', url, headers, body, options)).body;
}

export async function getJson(
  service: string,
  url: string,
  headers: Record<string, string>,
  options: RequestOptions,
): Promise<unknown> {
  return (await requestJson(service, 'GET', url, headers, undefined, options)).body;
}

// A GET that also hands back the answer's headers (request limits, for the host poller).
export function getJsonAnswer(
  service: string,
  url: string,
  headers: Record<string, string>,
  options: RequestOptions,
): Promise<{ body: unknown; headers: Headers }> {
  return requestJson(service, 'GET', url, headers, undefined, options);
}

async function requestJson(
  service: string,
  method: 'GET' | 'POST',
  url: string,
  headers: Record<string, string>,
  body: unknown,
  options: RequestOptions,
): Promise<{ body: unknown; headers: Headers }> {
  const send = options.fetch ?? globalThis.fetch;
  let response: Response;
  try {
    response = await send(url, {
      method,
      headers: {
        ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
        accept: 'application/json',
        ...headers,
      },
      ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(options.timeoutMs),
      ...(options.redirect ? { redirect: options.redirect } : {}),
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
  if (
    options.redirect === 'manual' &&
    (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400))
  ) {
    throw new TrackerError(
      `${service} redirected to another address (${response.status}); wow does not send the token there. Check the URL in Settings → Trackers.`,
      response.status,
    );
  }
  const text = await response.text();
  const parsed = parseJson(text);
  if (!response.ok) {
    const detail = errorDetail(parsed) ?? (text.trim().slice(0, 300) || response.statusText);
    const refused = new TrackerError(
      `${service} answered ${response.status}${detail ? `: ${detail}` : ''}`,
      response.status,
    );
    answerHeaders.set(refused, response.headers);
    throw refused;
  }
  return { body: parsed, headers: response.headers };
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

// Jira answers {errorMessages: [], errors: {field: message}}; GitHub {message, errors: [...]};
// GitLab {message} or, for a token it turns down, {error, error_description}.
function errorDetail(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined;
  const parts: string[] = [];
  if (typeof body['message'] === 'string') parts.push(body['message']);
  if (typeof body['error_description'] === 'string') parts.push(body['error_description']);
  else if (typeof body['error'] === 'string') parts.push(body['error']);
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
