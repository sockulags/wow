import { skillGroupLabels, type SentSkill, type SkillGroup } from '@wow/contracts';
import {
  FolderCogIcon,
  FolderIcon,
  HouseIcon,
  PuzzleIcon,
  SparklesIcon,
  UserRoundIcon,
  XIcon,
  type LucideIcon,
} from 'lucide-react';
import type { KeyboardEvent, Ref } from 'react';
import { Badge } from '@/components/ui/badge';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { sentSkillGroup, sentSkillName } from './view-model';

// A picked skill shows as a chip: its name with a mark for its group (wow skills spec 17, 18).

const groupMarks: Readonly<Record<SkillGroup, LucideIcon>> = {
  yours: UserRoundIcon,
  wow: SparklesIcon,
  project: FolderIcon,
  user: HouseIcon,
  plugins: PuzzleIcon,
  other: FolderCogIcon,
};

export function SkillMark({ group }: { group: SkillGroup }) {
  const Mark = groupMarks[group];
  return <Mark aria-hidden data-group={group} />;
}

const chipName = (name: string, group: SkillGroup) => `${name}, ${skillGroupLabels[group]} skill`;

// A chip in the composer. It takes the focus when the arrow keys step onto it; Backspace or
// Delete then removes it, as does its button.
export function ComposerSkillChip({
  ref,
  name,
  group,
  onRemove,
  onKeyDown,
}: {
  ref?: Ref<HTMLSpanElement>;
  name: string;
  group: SkillGroup;
  onRemove(): void;
  onKeyDown(event: KeyboardEvent<HTMLSpanElement>): void;
}) {
  return (
    <Badge
      ref={ref}
      role="listitem"
      tabIndex={-1}
      variant="secondary"
      aria-label={chipName(name, group)}
      data-testid="skill-chip"
      onKeyDown={onKeyDown}
      className="gap-1 pr-0.5 outline-none focus:ring-2 focus:ring-ring"
    >
      <SkillMark group={group} />
      <span className="font-mono">{name}</span>
      <button
        type="button"
        tabIndex={-1}
        aria-label={`Remove ${name}`}
        // Keep the focus where it is; the composer puts it back in the text box.
        onMouseDown={(event) => event.preventDefault()}
        onClick={onRemove}
        className="rounded-sm p-0.5 text-muted-foreground hover:bg-background/60 hover:text-foreground"
      >
        <XIcon className="size-3" />
      </button>
    </Badge>
  );
}

// A chip on a sent message or step prompt. Its text (or invocation) opens from it, so the
// conversation names the skill without showing all of it (wow skills spec 14).
export function SentSkillChip({ skill }: { skill: SentSkill }) {
  const group = sentSkillGroup(skill);
  const name = sentSkillName(skill);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Badge asChild variant="secondary">
          <button
            type="button"
            aria-label={chipName(name, group)}
            data-testid="skill-chip"
            className="cursor-pointer hover:bg-secondary/80"
          >
            <SkillMark group={group} />
            <span className="font-mono">{name}</span>
          </button>
        </Badge>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        aria-label={`Skill ${name}`}
        className="flex max-h-96 w-96 flex-col gap-2 overflow-y-auto text-xs"
      >
        <div className="flex items-center gap-1.5 font-medium">
          <SkillMark group={group} />
          <span className="font-mono">{name}</span>
          <span className="ml-auto font-normal text-muted-foreground">
            {skillGroupLabels[group]}
          </span>
        </div>
        {skill.reason !== undefined && (
          <p className="text-muted-foreground">Attached by wow: {skill.reason}.</p>
        )}
        {skill.text !== undefined ? (
          <pre data-testid="skill-text" className="font-sans whitespace-pre-wrap">
            {skill.text}
          </pre>
        ) : (
          <p>
            Invoked as <code className="font-mono">{skill.invocation ?? skill.name}</code>; the
            agent reads the skill from its folder.
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}
