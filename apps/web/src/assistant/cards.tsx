import {
  SecretRef,
  TrackerConnection,
  settingGroupTitles,
  type ProjectWorkOffer,
  type SecretFieldRequest,
  type TokenGuide,
} from '@wow/contracts';
import { useNavigate } from '@tanstack/react-router';
import { ExternalLinkIcon, KeyRoundIcon, MessagesSquareIcon } from 'lucide-react';
import { useId } from 'react';
import { useRuntime } from '@/app/runtime';
import { useTopic } from '@/chat/data';
import { HostLink } from '@/plans/host-read';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { SecretField } from '@/settings/secret-field';
import { TestConnection } from '@/settings/trackers-section';
import { registry } from './model';
import { PlaceLink } from './rows';

// The cards a tool call of the assistant asks for (app assistant spec 3, 14, 16).

// The tracker a secret setting signs in to, for its Test connection.
const serviceOf = (key: string): TrackerConnection | undefined => {
  const parsed = TrackerConnection.safeParse(/^trackers\.([a-z]+)\.token$/.exec(key)?.[1]);
  return parsed.success ? parsed.data : undefined;
};

// The stored reference of a secret setting at exactly the scope the field writes.
function useStoredRef(key: string, projectId: string | undefined): unknown {
  const rows = useTopic('settings');
  const scope = projectId === undefined ? 'global' : `project:${projectId}`;
  return rows?.find((row) => row.key === key && row.scope === scope)?.value ?? null;
}

// The steps of the token guide wow ships (spec 15): where to make the token, with links to the
// user's own host, which rights it needs, what to copy, and the versions it was written for.
export function TokenGuideSteps({ guide }: { guide: TokenGuide }) {
  return (
    <div
      role="group"
      aria-label={`Token guide for ${guide.host}`}
      data-testid="assistant-token-guide"
      className="flex flex-col gap-1.5 text-xs"
    >
      <p className="text-muted-foreground">
        {guide.host} · written for {guide.writtenFor}
      </p>
      <ol className="flex list-decimal flex-col gap-1 pl-4">
        {guide.steps.map((step) => (
          <li key={step.text}>
            {step.text}
            {step.link && (
              <>
                {' '}
                <HostLink href={step.link}>
                  {step.link}
                  <ExternalLinkIcon aria-hidden className="size-3" />
                </HostLink>
              </>
            )}
          </li>
        ))}
      </ol>
      {guide.addressNeeded && (
        <p>
          Fill in {guide.addressNeeded.label}: <PlaceLink place={guide.addressNeeded.place} />
        </p>
      )}
      <div>
        <p className="font-medium">Rights it needs</p>
        <ul className="flex list-disc flex-col gap-0.5 pl-4">
          {guide.rights.map((right) => (
            <li key={right}>{right}</li>
          ))}
        </ul>
      </div>
      <p>
        <span className="font-medium">What to copy: </span>
        {guide.copy}
      </p>
    </div>
  );
}

// The setting's name, where the value goes, the token guide's steps, a password field with
// Save, and Test connection. The value goes to the secret store through the settings page's own
// field; the card says "Set" once a reference is stored and shows what the test answered, never
// the value.
export function SecretFieldCard({
  request,
  guide = null,
}: {
  request: SecretFieldRequest;
  guide?: TokenGuide | null;
}) {
  const id = useId();
  const definition = registry[request.key];
  const projects = useTopic('projects');
  const stored = useStoredRef(request.key, request.projectId);
  if (!definition?.secret) return null;
  const project = projects?.find((entry) => entry.id === request.projectId);
  const target =
    request.projectId === undefined
      ? `Settings → ${settingGroupTitles[definition.group]}, for every project`
      : `Settings → Projects → ${project?.name ?? request.projectId}`;
  const service = serviceOf(request.key);
  const set = SecretRef.safeParse(stored).success;
  return (
    <section
      aria-label={`Secret field: ${definition.label}`}
      data-testid="assistant-secret-field"
      className="flex flex-col gap-2 rounded-md border border-border p-3 text-sm"
    >
      <div className="flex items-start gap-2">
        <KeyRoundIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <h3 id={`${id}-title`} className="font-medium">
            {definition.label}
          </h3>
          <p data-testid="assistant-secret-target" className="text-xs text-muted-foreground">
            Goes to the wow secret store for {target}. The assistant never sees it.
          </p>
        </div>
        <Badge variant="outline" data-testid="assistant-secret-state">
          {set ? 'Set' : 'Not set'}
        </Badge>
      </div>
      <div className="flex flex-col gap-2 pl-6">
        {guide && <TokenGuideSteps guide={guide} />}
        <SecretField
          id={`${id}-value`}
          label={definition.label}
          settingKey={request.key}
          projectId={request.projectId}
          value={stored}
          storedLabel="Set"
        />
        {service && <TestConnection service={service} projectId={request.projectId} />}
      </div>
    </section>
  );
}

// A request that is not about operating wow: one button opens a new chat thread with its text.
export function ProjectWorkCard({ offer }: { offer: ProjectWorkOffer }) {
  const { draft } = useRuntime();
  const navigate = useNavigate();
  return (
    <section
      aria-label="Project work"
      data-testid="assistant-project-work"
      className="flex flex-col gap-2 rounded-md border border-border p-3 text-sm"
    >
      <p className="text-xs text-muted-foreground">This is work for the chat view:</p>
      <blockquote className="border-l-2 border-border pl-3 whitespace-pre-wrap">
        {offer.text}
      </blockquote>
      <Button
        size="sm"
        variant="outline"
        className="w-fit"
        onClick={() => {
          draft.setState({ text: offer.text });
          void navigate({ to: '/chat/new' });
        }}
      >
        <MessagesSquareIcon />
        Open in Chat
      </Button>
    </section>
  );
}
