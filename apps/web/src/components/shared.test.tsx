import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { topicStatus } from '@/app/topic-state';
import { formatDuration, formatRelative, formatWhen } from '@/lib/format';
import { renderWithRuntime } from '@/test/render';
import { FormField } from './form-field';
import { splitPath } from './path-text';
import { EmptyState, TopicPlaceholder } from './states';
import { InboxIcon } from 'lucide-react';

const zone = 'Europe/Stockholm';
const now = new Date('2026-11-02T13:30:00Z'); // 14:30 in Stockholm, Monday

describe('formatWhen', () => {
  it('says the time today, yesterday and tomorrow, and the day otherwise', () => {
    expect(formatWhen('2026-11-02T13:25:56Z', zone, now)).toBe('14:25');
    expect(formatWhen('2026-11-01T13:25:00Z', zone, now)).toBe('Yesterday 14:25');
    expect(formatWhen('2026-11-03T08:00:00Z', zone, now)).toBe('Tomorrow 09:00');
    expect(formatWhen('2026-10-28T08:00:00Z', zone, now)).toBe('Wed 28 Oct 09:00');
    expect(formatWhen('2025-10-28T08:00:00Z', zone, now)).toBe('Tue 28 Oct 2025 09:00');
  });
});

describe('formatRelative', () => {
  it('counts back in minutes, hours and days', () => {
    expect(formatRelative('2026-11-02T13:29:40Z', zone, now)).toBe('just now');
    expect(formatRelative('2026-11-02T13:25:00Z', zone, now)).toBe('5 min ago');
    expect(formatRelative('2026-11-02T10:00:00Z', zone, now)).toBe('3 h ago');
    expect(formatRelative('2026-11-01T10:00:00Z', zone, now)).toBe('yesterday');
    expect(formatRelative('2026-10-31T10:00:00Z', zone, now)).toBe('2 days ago');
    expect(formatRelative('2026-10-01T10:00:00Z', zone, now)).toBe('Thu 1 Oct');
  });
});

describe('formatDuration', () => {
  it('reads like speech', () => {
    expect(formatDuration(45_000)).toBe('45 s');
    expect(formatDuration(72_000)).toBe('1 min 12 s');
    expect(formatDuration(120_000)).toBe('2 min');
    expect(formatDuration(7_500_000)).toBe('2 h 5 min');
  });
});

describe('splitPath', () => {
  it('keeps the last segment whole on Windows and POSIX paths', () => {
    expect(splitPath('C:\\Users\\ada\\src\\wow')).toEqual({
      head: 'C:\\Users\\ada\\src\\',
      tail: 'wow',
    });
    expect(splitPath('/home/ada/.claude')).toEqual({ head: '/home/ada/', tail: '.claude' });
    expect(splitPath('claude')).toEqual({ head: '', tail: 'claude' });
  });
});

describe('topicStatus', () => {
  it('never reports an empty list before the first snapshot', () => {
    expect(topicStatus(false, { status: 'open', configured: true })).toBe('loading');
    expect(topicStatus(true, { status: 'open', configured: true })).toBe('ready');
    expect(topicStatus(true, { status: 'reconnecting', configured: true })).toBe('disconnected');
    expect(topicStatus(false, { status: 'closed', configured: false })).toBe('offline');
  });
});

describe('FormField', () => {
  it('links the control to its label, help and error', () => {
    render(
      <FormField id="name" label="Name" help="Shown in the list." error="Give it a name.">
        <input />
      </FormField>,
    );
    const input = screen.getByRole('textbox', { name: 'Name' });
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toBe('name-help name-error');
    expect(screen.getByRole('alert').textContent).toBe('Give it a name.');
  });
});

describe('states', () => {
  it('renders the empty state with its action', () => {
    render(
      <EmptyState
        icon={InboxIcon}
        title="No projects yet"
        description="Add a folder to start."
        action={<button type="button">Add project</button>}
      />,
    );
    expect(screen.getByRole('heading', { name: 'No projects yet' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add project' })).toBeTruthy();
  });

  it('shows loading or not connected instead of empty', () => {
    const { unmount } = renderWithRuntime(<TopicPlaceholder status="loading" />);
    expect(screen.getByRole('status', { name: 'Loading' })).toBeTruthy();
    unmount();
    renderWithRuntime(<TopicPlaceholder status="disconnected" />);
    expect(screen.getByText('Not connected to the wow server')).toBeTruthy();
  });
});
