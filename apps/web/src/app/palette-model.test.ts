import { describe, expect, it } from 'vitest';
import type { AppCommand } from './commands';
import { displayTitle, paletteScore, startList } from './palette-model';

const command = (id: string, title: string, extra: Partial<AppCommand> = {}): AppCommand => ({
  id,
  title,
  group: 'Actions',
  run: () => undefined,
  ...extra,
});

describe('palette', () => {
  it('drops the group prefix from a title (C-13)', () => {
    expect(displayTitle({ title: 'Calendar: today', group: 'Calendar' })).toBe('Today');
    expect(displayTitle({ title: 'Settings: Calendar', group: 'Settings' })).toBe('Calendar');
    expect(displayTitle({ title: 'Edit card: Lunch', group: 'Cards' })).toBe('Edit card: Lunch');
  });

  it('ranks title matches above keyword matches and never matches scattered letters', () => {
    const zoom = command('zoom', 'Reset calendar zoom', { keywords: ['zoom', 'default'] });
    const feature = command('wf', 'Feature: search panel', { group: 'Workflows' });
    const template = command('tpl', 'New workflow from template: Feature', {
      group: 'Workflows',
    });
    expect(paletteScore(zoom, 'feature')).toBe(0);
    expect(paletteScore(feature, 'feature')).toBeGreaterThan(paletteScore(template, 'feature'));
    expect(paletteScore(template, 'feature')).toBeGreaterThan(0);
    // Words can come from the group and keywords as well.
    expect(paletteScore(zoom, 'zoom calendar')).toBeGreaterThan(0);
    expect(
      paletteScore(command('x', 'Go to Backlog', { group: 'Navigation' }), 'go to backlog'),
    ).toBe(1);
  });

  it('lists what needs you, recent things and the view actions before typing', () => {
    const commands: AppCommand[] = [
      command('t1', 'Approve deploy', { group: 'Threads', needsYou: true, recentAt: '2026-11-02' }),
      command('t2', 'Older thread', { group: 'Threads', recentAt: '2026-10-01' }),
      command('t3', 'Newer thread', { group: 'Threads', recentAt: '2026-11-01' }),
      command('card', 'Edit card: Lunch', { group: 'Cards' }),
      command('new', 'New thread', { group: 'Chat' }),
      command('switch', 'Switch provider to Codex', { group: 'Chat', searchOnly: true }),
      command('today', 'Calendar: today', { group: 'Calendar' }),
      command('go', 'Go to Backlog', { group: 'Navigation' }),
    ];
    const list = startList(commands, 'Chat', 1);
    expect(list.map(([heading, members]) => [heading, members.map((entry) => entry.id)])).toEqual([
      ['Needs you', ['t1']],
      ['Recent', ['t3']],
      ['In Chat', ['new']],
      ['Go to', ['go']],
    ]);
  });
});
