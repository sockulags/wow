import type { Skill } from '@wow/contracts';
import { BookOpenIcon, PencilIcon, PlusIcon, SparklesIcon, Trash2Icon } from 'lucide-react';
import { useId } from 'react';
import { useStore } from 'zustand';
import { useRuntime } from '@/app/runtime';
import { useTopicState } from '@/app/topic-state';
import { errorMessage } from '@/chat/data';
import { FormField } from '@/components/form-field';
import { EmptyState, TopicPlaceholder } from '@/components/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { notify } from '@/lib/feedback';
import {
  builtInSkills,
  changeSkillDraft,
  closeSkillEditor,
  deleteSkill,
  openEditSkill,
  openNewSkill,
  ownSkills,
  saveSkill,
  skillsStore,
} from './skills';

// Settings → Skills above the folder settings (wow skills spec 3, 5): "Your skills" with New,
// Edit and Delete, and wow's built-in skills, read-only, with their text.

function SkillText({ skill }: { skill: Skill }) {
  return (
    <details className="mt-0.5">
      <summary className="cursor-pointer text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
        Show the text
      </summary>
      <pre
        data-testid="skill-text"
        className="mt-1 max-h-64 overflow-auto rounded-sm bg-muted p-2 font-mono text-[11px] whitespace-pre-wrap"
      >
        {skill.text ?? ''}
      </pre>
    </details>
  );
}

function OwnSkillRow({ skill, offline }: { skill: Skill; offline: boolean }) {
  const { connection } = useRuntime();
  return (
    <li
      aria-label={skill.name}
      data-testid="own-skill"
      className="flex min-w-0 flex-col gap-1 border-b border-border py-2 last:border-b-0"
    >
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="font-mono text-sm font-medium">{skill.name}</span>
          <span className="text-xs text-muted-foreground">
            {skill.description || 'No description'}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            disabled={offline}
            aria-label={`Edit ${skill.name}`}
            onClick={() => openEditSkill(skill)}
          >
            <PencilIcon />
            Edit
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={offline}
            aria-label={`Delete ${skill.name}`}
            className="text-destructive hover:text-destructive"
            onClick={() => {
              if (!connection) return;
              deleteSkill(connection, skill).catch((failure: unknown) =>
                notify.error(`Could not delete ${skill.name}`, {
                  description: errorMessage(failure),
                }),
              );
            }}
          >
            <Trash2Icon />
            Delete
          </Button>
        </div>
      </div>
      <SkillText skill={skill} />
    </li>
  );
}

function SkillEditorDialog({ skills }: { skills: readonly Skill[] }) {
  const { connection } = useRuntime();
  const editor = useStore(skillsStore, (state) => state.editor);
  const id = useId();
  const editing = editor?.editing;
  return (
    <Dialog open={editor !== undefined} onOpenChange={(open) => !open && closeSkillEditor()}>
      <DialogContent className="sm:max-w-xl">
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (connection) void saveSkill(connection, skills);
          }}
        >
          <DialogHeader>
            <DialogTitle>{editing ? `Edit ${editing}` : 'New skill'}</DialogTitle>
            <DialogDescription>
              wow sends the text to the agent wherever the skill is picked or a step follows it.
            </DialogDescription>
          </DialogHeader>
          <FormField
            id={`${id}-name`}
            label="Name"
            error={editor?.error?.on === 'name' ? editor.error.reason : undefined}
            help={
              editing
                ? 'A skill keeps its name; write a new one for another name.'
                : 'Lower case letters, digits and hyphens. Not starting with wow-.'
            }
          >
            <Input
              value={editor?.draft.name ?? ''}
              disabled={editing !== undefined}
              autoComplete="off"
              className="font-mono"
              onChange={(event) => changeSkillDraft({ name: event.target.value })}
            />
          </FormField>
          <FormField id={`${id}-description`} label="When to use it">
            <Input
              value={editor?.draft.description ?? ''}
              onChange={(event) => changeSkillDraft({ description: event.target.value })}
            />
          </FormField>
          <FormField
            id={`${id}-text`}
            label="Text"
            error={editor?.error?.on === 'text' ? editor.error.reason : undefined}
          >
            <Textarea
              rows={10}
              className="font-mono text-xs"
              value={editor?.draft.text ?? ''}
              onChange={(event) => changeSkillDraft({ text: event.target.value })}
            />
          </FormField>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={closeSkillEditor}>
              Cancel
            </Button>
            <Button type="submit" disabled={!connection || editor?.busy}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function SkillsSection() {
  const { connection } = useRuntime();
  const { rows, status } = useTopicState('skills');
  const offline = !connection || status === 'disconnected';
  const skills = rows ?? [];
  const own = ownSkills(skills);
  const builtIn = builtInSkills(skills);
  return (
    <div className="flex min-w-0 flex-col gap-6 py-4">
      <section aria-label="Your skills" className="flex min-w-0 flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-medium">Your skills</h3>
          <p className="text-xs text-muted-foreground">
            Listed first wherever skills are picked. wow sends their text to the agent.
          </p>
          <Button
            variant="outline"
            size="sm"
            className="ml-auto"
            disabled={offline}
            onClick={openNewSkill}
          >
            <PlusIcon />
            New skill
          </Button>
        </div>
        {rows === undefined ? (
          <TopicPlaceholder status={status} compact rows={2} />
        ) : own.length === 0 ? (
          <EmptyState
            compact
            icon={SparklesIcon}
            title="No skills of your own yet"
            description="Write one to tell agents how you want a kind of work done."
          />
        ) : (
          <ul className="flex flex-col">
            {own.map((skill) => (
              <OwnSkillRow key={skill.id} skill={skill} offline={offline} />
            ))}
          </ul>
        )}
      </section>
      {builtIn.length > 0 && (
        <section aria-label="Built-in skills" className="flex min-w-0 flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-medium">Built in</h3>
            <p className="text-xs text-muted-foreground">
              They come with wow and cannot be changed. Parts in braces are filled in when sent.
            </p>
          </div>
          <ul className="flex flex-col">
            {builtIn.map((skill) => (
              <li
                key={skill.id}
                aria-label={skill.name}
                data-testid="built-in-skill"
                className="flex min-w-0 flex-col gap-0.5 border-b border-border py-2 last:border-b-0"
              >
                <span className="flex items-center gap-2">
                  <span className="font-mono text-sm font-medium">{skill.name}</span>
                  <Badge variant="secondary">
                    <BookOpenIcon />
                    Read-only
                  </Badge>
                </span>
                <span className="text-xs text-muted-foreground">{skill.description}</span>
                <SkillText skill={skill} />
              </li>
            ))}
          </ul>
        </section>
      )}
      <SkillEditorDialog skills={skills} />
    </div>
  );
}
