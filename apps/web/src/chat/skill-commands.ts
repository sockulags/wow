import type { AppCommand } from '@/app/commands';
import type { ActiveSkillComposer } from './composer-store';

// Palette commands for the composer on screen that takes skills (wow skills spec 16, 17): open
// its skill list, as typing the trigger character does, and remove each picked chip.
export function skillComposerCommands(composer: ActiveSkillComposer | undefined): AppCommand[] {
  if (!composer) return [];
  return [
    {
      id: 'composer.pickSkill',
      title: 'Pick a skill for the message',
      group: 'Chat',
      keywords: ['skill', 'slash', 'chip', 'composer', 'message'],
      detail: 'Composer',
      run: () => composer.openSkills(),
    },
    ...composer.chips.map((name, index): AppCommand => ({
      id: `composer.removeSkill.${index}`,
      title: `Remove skill ${name} from the message`,
      group: 'Chat',
      keywords: ['skill', 'chip', 'composer', 'remove', name],
      detail: 'Composer',
      run: () => composer.removeSkill(index),
    })),
  ];
}
