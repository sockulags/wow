import {
  ProjectTrackers,
  SecretRef,
  settingsRegistry,
  type Project,
  trackerConnectionLabels as titles,
  type GitLabProject,
  type ResolvedTrackerSetting,
  type TrackerConnection,
  type TrackerSuggestion,
  type TrackerValueSource,
} from '@wow/contracts';
import { dispatch } from '@wow/client-runtime';
import { Link } from '@tanstack/react-router';
import { KeyRoundIcon, SparklesIcon, Undo2Icon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useRuntime } from '@/app/runtime';
import { errorMessage, useTopic } from '@/chat/data';
import { FormField } from '@/components/form-field';
import { LoadingState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { notify } from '@/lib/feedback';
import { SecretField } from '@/settings/secret-field';
import { TestConnection } from '@/settings/trackers-section';

type RegistryKey = keyof typeof settingsRegistry;
const isRegistryKey = (key: string): key is RegistryKey => Object.hasOwn(settingsRegistry, key);

// The marker next to a field: where its value came from (design rules, "Fields").
export function sourceLabel(source: TrackerValueSource, value: unknown): string {
  switch (source) {
    case 'project':
      return 'Set for this project';
    case 'gitRemote':
      return 'From git remote';
    case 'outlook':
      return 'From Outlook';
    case 'global':
      return 'Default';
    case 'default':
      return value === '' || value === null ? 'Not set' : 'Default';
  }
}

// The fields a project usually sets for itself. Sign-in (email, tokens) is shared and shown as one
// line with an override.
interface FieldSpec {
  readonly key: RegistryKey;
  readonly label: string;
  readonly placeholder: string;
}

const fields: Readonly<Record<TrackerConnection, readonly FieldSpec[]>> = {
  github: [
    { key: 'trackers.github.owner', label: 'Owner', placeholder: 'acme' },
    { key: 'trackers.github.repo', label: 'Repository', placeholder: 'widgets' },
    { key: 'trackers.github.baseUrl', label: 'API URL', placeholder: 'https://api.github.com' },
  ],
  jira: [
    { key: 'trackers.jira.baseUrl', label: 'Site URL', placeholder: 'https://acme.atlassian.net' },
    { key: 'trackers.jira.projectKey', label: 'Project key', placeholder: 'PROJ' },
    { key: 'trackers.jira.issueType', label: 'Issue type', placeholder: 'Task' },
  ],
  gitlab: [
    {
      key: 'trackers.gitlab.baseUrl',
      label: 'Site URL',
      placeholder: 'https://gitlab.example.com',
    },
  ],
  confluence: [
    {
      key: 'trackers.confluence.baseUrl',
      label: 'Site URL',
      placeholder: 'https://confluence.example.com',
    },
  ],
};

const tokenKeys: Readonly<Record<TrackerConnection, RegistryKey>> = {
  github: 'trackers.github.token',
  jira: 'trackers.jira.token',
  gitlab: 'trackers.gitlab.token',
  confluence: 'trackers.confluence.token',
};

// Which GitLab project the project reads merge requests from: the one its git remote names on
// the stored site. Without one the project's host is GitHub.
function GitLabRemote({
  projectId,
  gitlab,
  site,
}: {
  projectId: string;
  gitlab: GitLabProject | null;
  site: unknown;
}) {
  return (
    <p
      data-testid={`project-${projectId}-gitlab-project`}
      className="text-xs text-muted-foreground"
    >
      {gitlab ? (
        <>
          Reads merge requests of <span className="font-mono text-foreground">{gitlab.path}</span>{' '}
          on {gitlab.host}, from the git remote.
        </>
      ) : typeof site === 'string' && site !== '' ? (
        'The git remote is not on this GitLab site, so pull requests are read from GitHub.'
      ) : (
        'Set the GitLab site to read merge requests for a project whose git remote is on it.'
      )}
    </p>
  );
}

function useProjectSetting(projectId: string) {
  const { connection } = useRuntime();
  const scope = `project:${projectId}` as const;
  return {
    set: async (key: string, value: unknown) => {
      if (!connection) throw new Error('Not connected to the wow server');
      await dispatch(connection, { type: 'setting.set', key, scope, value });
    },
    reset: async (key: string) => {
      if (!connection) throw new Error('Not connected to the wow server');
      await dispatch(connection, { type: 'setting.reset', key, scope });
    },
  };
}

function TrackerField({
  projectId,
  settingKey,
  label,
  placeholder,
  resolved,
  suggestion,
  hasRemote,
}: {
  projectId: string;
  settingKey: RegistryKey;
  label: string;
  placeholder: string;
  resolved: ResolvedTrackerSetting | undefined;
  suggestion: TrackerSuggestion | undefined;
  hasRemote: boolean;
}) {
  const { connection } = useRuntime();
  const shown = typeof resolved?.value === 'string' ? resolved.value : '';
  const [draft, setDraft] = useState<string>();
  const [error, setError] = useState<string>();
  const { set, reset } = useProjectSetting(projectId);
  const id = `project-${projectId}-${settingKey}`;
  const definition = settingsRegistry[settingKey];
  const source = resolved?.source ?? 'default';

  const save = async (next: string) => {
    setError(undefined);
    if (next.trim() === shown.trim()) {
      setDraft(undefined);
      return;
    }
    // Emptying a project value goes back to the remote or the default rather than storing "".
    if (next.trim() === '' && source === 'project') {
      await reset(settingKey).catch((caught: unknown) => setError(errorMessage(caught)));
      setDraft(undefined);
      return;
    }
    const parsed = definition.schema.safeParse(next);
    if (!parsed.success) {
      setError(parsed.error.issues.map((issue) => issue.message).join('; '));
      return;
    }
    try {
      await set(settingKey, parsed.data);
      setDraft(undefined);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };

  const help = suggestion ? (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <SparklesIcon aria-hidden className="size-3.5 shrink-0 text-info" />
      <span data-testid={`${id}-suggestion`}>
        Suggested: <span className="font-medium text-foreground">{suggestion.value}</span>.{' '}
        {suggestion.detail}.
      </span>
      <Button
        type="button"
        size="xs"
        variant="outline"
        disabled={!connection}
        onClick={() => {
          void set(settingKey, suggestion.value).then(
            () => notify.success(`${label} set to ${suggestion.value}`),
            (caught: unknown) => setError(errorMessage(caught)),
          );
        }}
      >
        Use {suggestion.value}
      </Button>
    </span>
  ) : undefined;

  return (
    <FormField
      id={id}
      label={label}
      source={sourceLabel(source, resolved?.value)}
      help={help}
      error={error}
      labelAction={
        source === 'project' ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="text-muted-foreground"
            onClick={() => {
              setDraft(undefined);
              void reset(settingKey).catch((caught: unknown) => setError(errorMessage(caught)));
            }}
          >
            <Undo2Icon />
            {hasRemote && settingKey.startsWith('trackers.github.')
              ? 'Use git remote'
              : 'Use default'}
          </Button>
        ) : undefined
      }
    >
      <Input
        value={draft ?? shown}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        disabled={!connection}
        className="h-8 max-w-md"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={(event) => void save(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') void save(event.currentTarget.value);
          if (event.key === 'Escape') setDraft(undefined);
        }}
      />
    </FormField>
  );
}

function SignIn({
  projectId,
  service,
  resolved,
}: {
  projectId: string;
  service: TrackerConnection;
  resolved: ReadonlyMap<string, ResolvedTrackerSetting>;
}) {
  const key = tokenKeys[service];
  const token = resolved.get(key);
  const own = token?.source === 'project';
  const shared = token?.source === 'global' && SecretRef.safeParse(token.value).success;
  const [overriding, setOverriding] = useState(own);
  const email = resolved.get(
    service === 'confluence' ? 'trackers.confluence.email' : 'trackers.jira.email',
  );
  const cloud =
    resolved.get(
      service === 'confluence' ? 'trackers.confluence.authMode' : 'trackers.jira.authMode',
    )?.value === 'cloud-basic';
  const id = `project-${projectId}-${key}`;
  return (
    <div className="flex flex-col gap-1.5">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <KeyRoundIcon aria-hidden className="size-3.5 shrink-0" />
        <span data-testid={`project-${projectId}-${service}-signin`}>
          {own
            ? `Signs in with a ${titles[service]} token of its own.`
            : shared
              ? `Signs in with the shared ${titles[service]} token.`
              : `No ${titles[service]} token yet. Save the shared one in Settings → Trackers, or one for this project.`}
          {(service === 'jira' || service === 'confluence') && cloud && email && email.value !== ''
            ? ` Email: ${String(email.value)}${email.source === 'outlook' ? ' (from Outlook)' : ''}.`
            : ''}
        </span>
        {!overriding && (
          <Button type="button" size="xs" variant="ghost" onClick={() => setOverriding(true)}>
            Use a different token
          </Button>
        )}
        <Link
          to="/settings/$group"
          params={{ group: 'trackers' }}
          className="rounded-sm underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Settings → Trackers
        </Link>
      </p>
      {overriding && (
        <FormField id={id} label={`${titles[service]} token for this project`}>
          <SecretField
            id={id}
            label={`${titles[service]} token for this project`}
            settingKey={key}
            projectId={projectId}
            value={own ? token.value : null}
          />
        </FormField>
      )}
    </div>
  );
}

// Settings → Projects → a project's Trackers (owner decision F-4): the GitHub repository read from
// the project's git remote, the Jira site and project key, the GitLab site and the project the
// remote names on it, the Confluence site, each with where it came from, and the
// suggestions wow does not use until confirmed. Asked again whenever a setting changes.
export function ProjectTrackersPanel({ project }: { project: Project }) {
  const { connection } = useRuntime();
  const settingRows = useTopic('settings');
  const [answer, setAnswer] = useState<ProjectTrackers>();
  const [failure, setFailure] = useState<string>();

  useEffect(() => {
    if (!connection) return undefined;
    let current = true;
    connection
      .request('trackers.project', { projectId: project.id })
      .then((result) => ProjectTrackers.parse(result))
      .then(
        (parsed) => {
          if (!current) return;
          setAnswer(parsed);
          setFailure(undefined);
        },
        (caught: unknown) => current && setFailure(errorMessage(caught)),
      );
    return () => {
      current = false;
    };
  }, [connection, project.id, project.cwd, settingRows]);

  if (failure) {
    return (
      <p role="alert" className="text-xs text-destructive">
        {failure}
      </p>
    );
  }
  if (!answer) return <LoadingState rows={3} label="Reading the project's trackers" />;

  const resolved = new Map(answer.settings.map((entry) => [entry.key, entry]));
  const suggestions = new Map(answer.suggestions.map((entry) => [entry.key, entry]));
  const hasRemote = answer.git.remotes.some(
    (remote) => remote.name === answer.git.primary && remote.github !== null,
  );

  return (
    <div className="flex flex-col gap-6" data-testid={`project-trackers-${project.id}`}>
      {(['github', 'jira', 'gitlab', 'confluence'] as const).map((service) => (
        <section
          key={service}
          aria-labelledby={`project-${project.id}-tracker-${service}`}
          className="flex flex-col gap-4"
        >
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-2">
            <h4 id={`project-${project.id}-tracker-${service}`} className="text-sm font-semibold">
              {titles[service]}
            </h4>
            <TestConnection service={service} projectId={project.id} />
          </div>
          {fields[service].map(({ key, label, placeholder }) =>
            isRegistryKey(key) ? (
              <TrackerField
                key={key}
                projectId={project.id}
                settingKey={key}
                label={label}
                placeholder={placeholder}
                resolved={resolved.get(key)}
                suggestion={suggestions.get(key)}
                hasRemote={hasRemote}
              />
            ) : null,
          )}
          {service === 'gitlab' && (
            <GitLabRemote
              projectId={project.id}
              gitlab={answer.gitlab}
              site={resolved.get('trackers.gitlab.baseUrl')?.value}
            />
          )}
          <SignIn projectId={project.id} service={service} resolved={resolved} />
        </section>
      ))}
    </div>
  );
}
