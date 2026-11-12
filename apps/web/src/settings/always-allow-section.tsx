import { AlwaysAllowRule, sameRule, settingsRegistry, type Project } from '@wow/contracts';
import { dispatch } from '@wow/client-runtime';
import { ShieldCheckIcon, Trash2Icon } from 'lucide-react';
import { useState } from 'react';
import { useRuntime, useSetting } from '@/app/runtime';
import { RuleText } from '@/chat/approval-card';
import { errorMessage, useTopic } from '@/chat/data';
import { EmptyState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { useDateFormat } from '@/lib/format';
import { formatRawDefault } from './setting-row';

// Settings → Approvals (agent workbench spec 40): each project's "always allow" rules with when
// they were added, and Remove. A removed rule asks again from the next request on, since the
// server reads the list at every request.

const rulesOf = (value: unknown): AlwaysAllowRule[] => {
  const parsed = AlwaysAllowRule.array().safeParse(value);
  return parsed.success ? parsed.data : [];
};

function ProjectRules({
  project,
  rules,
}: {
  readonly project: Project;
  readonly rules: readonly AlwaysAllowRule[];
}) {
  const { connection } = useRuntime();
  const { when } = useDateFormat();
  const [error, setError] = useState<string>();
  const scope = `project:${project.id}` as const;
  const remove = async (rule: AlwaysAllowRule) => {
    if (!connection) return;
    setError(undefined);
    const rest = rules.filter((stored) => !sameRule(stored, rule));
    try {
      await dispatch(
        connection,
        rest.length === 0
          ? { type: 'setting.reset', key: 'approvals.alwaysAllow', scope }
          : { type: 'setting.set', key: 'approvals.alwaysAllow', scope, value: rest },
      );
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };
  return (
    <section aria-label={`Rules of ${project.name}`} className="flex flex-col gap-1.5">
      <h3 className="text-sm font-medium">{project.name}</h3>
      <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
        {rules.map((rule) => (
          <li
            key={`${rule.kind}:${rule.kind === 'command' ? rule.prefix : `${rule.server}/${rule.tool}`}`}
            data-testid="always-allow-rule"
            className="flex items-center gap-3 px-3 py-2 text-xs"
          >
            <span className="min-w-0 flex-1">
              <RuleText rule={rule} />
            </span>
            <span className="shrink-0 text-muted-foreground">Added {when(rule.addedAt)}</span>
            <Button
              size="xs"
              variant="outline"
              aria-label={`Remove the rule in ${project.name}`}
              onClick={() => void remove(rule)}
            >
              <Trash2Icon aria-hidden />
              Remove
            </Button>
          </li>
        ))}
      </ul>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}

const definition = settingsRegistry['approvals.alwaysAllow'];

export function AlwaysAllowSection() {
  const showKeys = useSetting('advanced.showSettingKeys');
  const projects = useTopic('projects') ?? [];
  const stored = useTopic('settings') ?? [];
  const listed = projects
    .map((project) => ({
      project,
      rules: rulesOf(
        stored.find(
          (row) => row.key === 'approvals.alwaysAllow' && row.scope === `project:${project.id}`,
        )?.value,
      ),
    }))
    .filter((entry) => entry.rules.length > 0);
  return (
    <div className="mt-3 flex flex-col gap-4" data-testid="setting-approvals.alwaysAllow">
      <div className="flex flex-col gap-1.5">
        <h3 className="text-sm font-medium">{definition.label}</h3>
        <p className="text-xs text-muted-foreground">{definition.description}</p>
        {showKeys && (
          <p className="font-mono text-2xs text-muted-foreground">
            approvals.alwaysAllow · default {formatRawDefault(definition.default)}
          </p>
        )}
      </div>
      {listed.length === 0 ? (
        <EmptyState compact icon={ShieldCheckIcon} title="No rules">
          &ldquo;Always allow in this project&rdquo; on an approval adds one here.
        </EmptyState>
      ) : (
        listed.map(({ project, rules }) => (
          <ProjectRules key={project.id} project={project} rules={rules} />
        ))
      )}
    </div>
  );
}
