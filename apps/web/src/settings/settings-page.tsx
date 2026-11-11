import type { SettingDefinition, SettingGroup } from '@wow/contracts';
import { Link, useParams } from '@tanstack/react-router';
import { SearchIcon, SearchXIcon } from 'lucide-react';
import { Fragment, useId, useMemo, useState, type ReactNode } from 'react';
import { EmptyState } from '@/components/states';
import { Input } from '@/components/ui/input';
import { useRuntime } from '@/app/runtime';
import { ProjectsSection } from '@/projects/projects-section';
import { ProvidersSection } from '@/providers/providers-section';
import { isSettingGroup, settingGroupTitles, settingsByGroup } from '@/app/sections';
import { UpdateStatusPanel } from '@/app/update-banner';
import { KeybindingsTable } from './keybindings-table';
import { SettingsForm } from './setting-row';
import { SetupSection } from './setup-section';
import { SkillsSection } from './skills-section';
import { TrackersSection } from './trackers-section';

export { SettingRow, SettingsForm } from './setting-row';

// Groups that only mean something in the installed desktop app (audit E-14).
export function useHiddenGroups(): ReadonlySet<SettingGroup> {
  const { updates, pickFolder } = useRuntime();
  return useMemo(() => {
    const hidden = new Set<SettingGroup>();
    if (updates === undefined) hidden.add('updates');
    if (pickFolder === undefined) hidden.add('desktop');
    return hidden;
  }, [updates, pickFolder]);
}

const navLinkClass =
  'flex h-7 items-center rounded-md px-2 text-sm text-muted-foreground outline-none hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring';
const activeNavLink = {
  className: 'bg-accent text-accent-foreground font-medium',
  'aria-current': 'page',
} as const;

const matches = (query: string, key: string, definition: SettingDefinition) => {
  const text =
    `${key} ${definition.label} ${definition.description} ${settingGroupTitles[definition.group]}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => text.includes(word));
};

function SearchResults({ query, hidden }: { query: string; hidden: ReadonlySet<SettingGroup> }) {
  const { settings } = useRuntime();
  const groups = useMemo(() => settingsByGroup(settings.definitions), [settings.definitions]);
  const found = [...groups.entries()]
    .filter(([group]) => !hidden.has(group))
    .map(([group, entries]) => [group, entries.filter(([k, d]) => matches(query, k, d))] as const)
    .filter(([, entries]) => entries.length > 0);
  if (found.length === 0) {
    return (
      <EmptyState
        icon={SearchXIcon}
        title="No settings match"
        description={`Nothing matches "${query}". Try another word.`}
      />
    );
  }
  return (
    <div className="flex flex-col gap-6">
      {found.map(([group, entries]) => (
        <section key={group} aria-label={settingGroupTitles[group]}>
          <h3 className="text-xs font-medium text-muted-foreground">{settingGroupTitles[group]}</h3>
          <SettingsForm entries={entries} />
        </section>
      ))}
    </div>
  );
}

// The settings pages: one per registry group, plus Projects (server rows, not settings) after
// Providers. The shell header says "Settings"; the page heading names the group, so nothing is
// said three times (audit E-17).
function SettingsLayout({ title, children }: { title: string; children: ReactNode }) {
  const { settings } = useRuntime();
  const hidden = useHiddenGroups();
  const groups = useMemo(() => settingsByGroup(settings.definitions), [settings.definitions]);
  const [query, setQuery] = useState('');
  const searchId = useId();
  const searching = query.trim() !== '';
  return (
    <div className="flex h-full">
      <nav
        aria-label="Settings groups"
        className="flex w-48 shrink-0 flex-col gap-2 border-r border-border p-2 max-lg:w-40"
      >
        <div className="relative">
          <label htmlFor={searchId} className="sr-only">
            Search settings
          </label>
          <SearchIcon
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            id={searchId}
            type="search"
            placeholder="Search settings"
            className="h-8 pl-7 text-xs"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => event.key === 'Escape' && setQuery('')}
          />
        </div>
        <ul className="flex flex-col gap-0.5">
          {[...groups.keys()]
            .filter((name) => !hidden.has(name))
            .map((name) => (
              <Fragment key={name}>
                <li>
                  <Link
                    to="/settings/$group"
                    params={{ group: name }}
                    className={navLinkClass}
                    activeProps={activeNavLink}
                    onClick={() => setQuery('')}
                  >
                    {settingGroupTitles[name]}
                  </Link>
                </li>
                {name === 'providers' && (
                  <li>
                    <Link
                      to="/settings/projects"
                      className={navLinkClass}
                      activeProps={activeNavLink}
                      onClick={() => setQuery('')}
                    >
                      Projects
                    </Link>
                  </li>
                )}
              </Fragment>
            ))}
        </ul>
      </nav>
      <section
        aria-labelledby="settings-title"
        className="min-w-0 flex-1 overflow-auto px-6 py-4 max-lg:px-4"
      >
        <div className="mx-auto max-w-3xl">
          <h2 id="settings-title" className="text-base font-semibold">
            {searching ? 'Search results' : title}
          </h2>
          {searching ? <SearchResults query={query.trim()} hidden={hidden} /> : children}
        </div>
      </section>
    </div>
  );
}

export function SettingsPage() {
  const { group } = useParams({ from: '/settings/$group' });
  const { settings } = useRuntime();
  const hidden = useHiddenGroups();
  const groups = useMemo(() => settingsByGroup(settings.definitions), [settings.definitions]);
  const current: SettingGroup | undefined = isSettingGroup(group) ? group : undefined;
  const entries = current ? (groups.get(current) ?? []) : [];

  return (
    <SettingsLayout title={current ? settingGroupTitles[current] : 'Settings'}>
      {current !== undefined && hidden.has(current) && (
        <p data-testid="desktop-only" className="mt-2 text-xs text-muted-foreground">
          These settings apply to the installed desktop app; this window cannot use them.
        </p>
      )}
      {current === 'providers' && <ProvidersSection />}
      {current === 'updates' && <UpdateStatusPanel />}
      {current === 'advanced' && <SetupSection />}
      {current === 'skills' && <SkillsSection />}
      {/* Remount per group so drafts never leak between pages. */}
      {current === 'trackers' ? (
        <TrackersSection key={group} entries={entries} />
      ) : current === 'keybindings' ? (
        <KeybindingsTable key={group} entries={entries} />
      ) : (
        <SettingsForm key={group} entries={entries} />
      )}
    </SettingsLayout>
  );
}

export function ProjectsSettingsPage() {
  return (
    <SettingsLayout title="Projects">
      <ProjectsSection />
    </SettingsLayout>
  );
}
