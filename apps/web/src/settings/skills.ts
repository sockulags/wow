import {
  ownSkillNameProblem,
  skillGroupOf,
  type Command,
  type OwnSkill,
  type Skill,
} from '@wow/contracts';
import { dispatch, type Connection } from '@wow/client-runtime';
import { createStore } from 'zustand';
import type { AppCommand } from '@/app/commands';
import { errorMessage } from '@/chat/data';
import { notify, offerUndo } from '@/lib/feedback';

// Settings → Skills, "Your skills" (wow skills spec 3, 5): write, change and remove own skills,
// each with Undo, and read the built-in ones. The list is the server's skills topic; this store
// only holds the editor that is open.

export const skillsPath = '/settings/skills';

export interface SkillEditor {
  // The skill being changed, or undefined for a new one.
  readonly editing: string | undefined;
  readonly draft: OwnSkill;
  readonly busy: boolean;
  // The server's refusal, or the name rule's reason once Save was pressed.
  readonly error: string | undefined;
}

export interface SkillsState {
  readonly editor: SkillEditor | undefined;
}

export const skillsStore = createStore<SkillsState>(() => ({ editor: undefined }));

export const ownSkills = (skills: readonly Skill[]): Skill[] =>
  skills.filter((skill) => skillGroupOf(skill) === 'yours');

export const builtInSkills = (skills: readonly Skill[]): Skill[] =>
  skills.filter((skill) => skillGroupOf(skill) === 'wow');

const asOwn = (skill: Skill): OwnSkill => ({
  name: skill.name,
  description: skill.description,
  text: skill.text ?? '',
});

export const openNewSkill = (): void =>
  skillsStore.setState({
    editor: {
      editing: undefined,
      draft: { name: '', description: '', text: '' },
      busy: false,
      error: undefined,
    },
  });

export const openEditSkill = (skill: Skill): void =>
  skillsStore.setState({
    editor: { editing: skill.name, draft: asOwn(skill), busy: false, error: undefined },
  });

export const closeSkillEditor = (): void => skillsStore.setState({ editor: undefined });

export function changeSkillDraft(changes: Partial<OwnSkill>): void {
  const { editor } = skillsStore.getState();
  if (!editor) return;
  skillsStore.setState({ editor: { ...editor, draft: { ...editor.draft, ...changes } } });
}

// Why the draft cannot be saved yet, as the server would say it: the name rule against the
// other wow skills, and a skill needs a text.
export function draftProblem(editor: SkillEditor, skills: readonly Skill[]): string | undefined {
  if (editor.editing === undefined) {
    const taken = skills
      .filter((skill) => skill.source === 'wow' || skill.source === 'yours')
      .map((skill) => skill.name);
    const problem = ownSkillNameProblem(editor.draft.name, taken);
    if (problem) return problem;
  }
  if (editor.draft.text.trim() === '') return 'A skill needs a text';
  return undefined;
}

const send = (connection: Connection, command: Command) => dispatch(connection, command);

// Saves the open editor's skill and offers Undo: a new skill is deleted again, a changed one
// gets its old text back.
export async function saveSkill(connection: Connection, skills: readonly Skill[]): Promise<void> {
  const { editor } = skillsStore.getState();
  if (!editor || editor.busy) return;
  const problem = draftProblem(editor, skills);
  if (problem) {
    skillsStore.setState({ editor: { ...editor, error: problem } });
    return;
  }
  const skill: OwnSkill = {
    name: editor.draft.name.trim(),
    description: editor.draft.description.trim(),
    text: editor.draft.text.trim(),
  };
  const previous = skills.find(
    (entry) => entry.source === 'yours' && entry.name === editor.editing,
  );
  skillsStore.setState({ editor: { ...editor, busy: true, error: undefined } });
  try {
    await send(connection, { type: previous ? 'skill.update' : 'skill.create', skill });
    skillsStore.setState({ editor: undefined });
    offerUndo(
      previous
        ? {
            message: `Skill ${skill.name} saved`,
            undoneMessage: `Skill ${skill.name} is as it was`,
            undo: () => send(connection, { type: 'skill.update', skill: asOwn(previous) }),
          }
        : {
            message: `Skill ${skill.name} written`,
            undoneMessage: `Skill ${skill.name} removed`,
            undo: () => send(connection, { type: 'skill.delete', name: skill.name }),
          },
    );
  } catch (failure) {
    const current = skillsStore.getState().editor;
    if (current) {
      skillsStore.setState({ editor: { ...current, busy: false, error: errorMessage(failure) } });
    }
  }
}

// Deleted at once; Undo writes it again with the same text.
export async function deleteSkill(connection: Connection, skill: Skill): Promise<void> {
  await send(connection, { type: 'skill.delete', name: skill.name });
  offerUndo({
    message: `Skill ${skill.name} deleted`,
    undoneMessage: `Skill ${skill.name} restored`,
    undo: () => send(connection, { type: 'skill.create', skill: asOwn(skill) }),
  });
}

// Palette commands: a new skill, and Edit and Delete for each own skill (spec 5). They open
// Settings → Skills, where the editor and the list are.
export function skillCommands(skills: readonly Skill[]): AppCommand[] {
  const keywords = ['skill', 'your skills', 'own skill', 'settings'];
  const commands: AppCommand[] = [
    {
      id: 'skills.new',
      title: 'New skill',
      group: 'Settings',
      keywords: [...keywords, 'write', 'create', 'add'],
      run: ({ navigate }) => {
        void navigate({ to: '/settings/$group', params: { group: 'skills' } });
        openNewSkill();
      },
    },
  ];
  for (const skill of ownSkills(skills)) {
    commands.push(
      {
        id: `skills.edit.${skill.name}`,
        title: `Edit skill: ${skill.name}`,
        group: 'Settings',
        keywords: [...keywords, 'change', skill.name],
        searchOnly: true,
        run: ({ navigate }) => {
          void navigate({ to: '/settings/$group', params: { group: 'skills' } });
          openEditSkill(skill);
        },
      },
      {
        id: `skills.delete.${skill.name}`,
        title: `Delete skill: ${skill.name}`,
        group: 'Settings',
        keywords: [...keywords, 'remove', skill.name],
        searchOnly: true,
        run: ({ connection }) => {
          if (!connection) return;
          deleteSkill(connection, skill).catch((failure: unknown) =>
            notify.error(`Could not delete ${skill.name}`, { description: errorMessage(failure) }),
          );
        },
      },
    );
  }
  return commands;
}
