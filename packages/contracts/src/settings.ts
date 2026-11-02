import { z } from 'zod';
import { WorkflowTemplate, type WorkflowTemplateStep } from './workflow.js';

// Every tunable value in wow is one entry here. The server validates writes against `schema`, and
// the settings UI renders fields from it, so adding a setting needs no other code.

export const SettingScope = z.enum(['global', 'project', 'provider']);
export type SettingScope = z.infer<typeof SettingScope>;

export const SettingGroup = z.enum([
  'providers',
  'chat',
  'calendar',
  'outlook',
  'scheduler',
  'workflows',
  'skills',
  'trackers',
  'appearance',
  'keybindings',
  'desktop',
  'updates',
  'advanced',
]);
export type SettingGroup = z.infer<typeof SettingGroup>;

// Where a stored value applies: 'global', 'project:<id>' or 'provider:<id>'. Reads resolve
// provider over project over global over the registry default.
export const SettingScopeRef = z
  .string()
  .regex(/^(global|project:.+|provider:.+)$/, 'Use global, project:<id> or provider:<id>');
export type SettingScopeRef = z.infer<typeof SettingScopeRef>;

// Settings marked `secret` store this reference; the value lives in the secret store.
export const SecretRef = z.object({ secretRef: z.string().min(1) }).strict();
export type SecretRef = z.infer<typeof SecretRef>;

export const LogLevel = z.enum(['error', 'warn', 'info', 'debug']);
export type LogLevel = z.infer<typeof LogLevel>;

export interface SettingDefinition<S extends z.ZodType = z.ZodType> {
  readonly schema: S;
  readonly group: SettingGroup;
  readonly label: string;
  readonly description: string;
  readonly default: z.output<S>;
  readonly scope: SettingScope;
  readonly restartRequired?: boolean;
  readonly secret?: boolean;
}

const defineSetting = <S extends z.ZodType>(definition: SettingDefinition<S>) => definition;

export const Weekday = z.enum([
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
]);
export type Weekday = z.infer<typeof Weekday>;

const isTimeZone = (zone: string): boolean => {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone !== '';
  } catch {
    return false;
  }
};

export const TimeZoneSetting = z.string().refine((zone) => zone === 'system' || isTimeZone(zone), {
  message: 'Use "system" or an IANA time zone such as Europe/Stockholm',
});

export const ClockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM, 24-hour');

export const WorkHours = z
  .object({
    start: ClockTime,
    end: ClockTime,
    days: z.array(Weekday).min(1),
  })
  .refine((hours) => hours.start < hours.end, {
    message: 'Work hours must end after they start',
    path: ['end'],
  });
export type WorkHours = z.infer<typeof WorkHours>;

// A shortcut such as "Mod+K" or "Mod+Shift+P". "Mod" is Ctrl on Windows and Linux and Cmd on
// macOS. An empty string leaves the command unbound. The `widget` meta tells the settings page to
// render a key recorder instead of a text box.
const KEY_PATTERN =
  /^(?:(?:Mod|Ctrl|Alt|Shift|Meta)\+)*(?:[A-Z0-9]|F(?:[1-9]|1[0-2])|Escape|Enter|Space|Tab|Backspace|Delete|Home|End|PageUp|PageDown|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|[,./;'[\]\\`=-])$/;

export const Keybinding = z
  .string()
  .refine((value) => value === '' || KEY_PATTERN.test(value), {
    message: 'Use modifiers and one key, such as Mod+K or Mod+Shift+P, or leave empty',
  })
  .meta({ widget: 'keybinding' });
export type Keybinding = z.infer<typeof Keybinding>;

// Key-value pairs where each value can be marked secret (provider environment variables). Secret
// values are stored by the server as references; the field only marks them.
export const KeyValueEntry = z.object({
  key: z.string().min(1),
  value: z.string(),
  secret: z.boolean(),
});
export type KeyValueEntry = z.infer<typeof KeyValueEntry>;

export const KeyValueList = z
  .array(KeyValueEntry)
  .refine((entries) => new Set(entries.map((entry) => entry.key)).size === entries.length, {
    message: 'Keys must be unique',
  })
  .meta({ widget: 'keyValue' });
export type KeyValueList = z.infer<typeof KeyValueList>;

export const Theme = z.enum(['dark', 'light']);
export type Theme = z.infer<typeof Theme>;

export const Density = z.enum(['comfortable', 'compact']);
export type Density = z.infer<typeof Density>;

// One installed font family name; it goes into a CSS font stack, so no quotes or separators.
export const FontFamily = z
  .string()
  .trim()
  .min(1)
  .regex(/^[^"';,{}<>\\]+$/, 'Use one font family name without quotes or commas');

const keybinding = (label: string, description: string, binding: string) =>
  defineSetting({
    schema: Keybinding,
    group: 'keybindings',
    label,
    description,
    default: binding,
    scope: 'global',
  });

// A tracker's base URL: http or https, or empty while the tracker is not set up.
export const TrackerUrl = z
  .string()
  .trim()
  .refine((value) => value === '' || /^https?:\/\/[^\s/]+/.test(value), {
    message: 'Use an http or https URL, such as https://acme.atlassian.net, or leave empty',
  });

export const JiraAuthMode = z.enum(['cloud-basic', 'pat']);
export type JiraAuthMode = z.infer<typeof JiraAuthMode>;

// A stored token: the reference to it in the secret store, or null while none is set. The
// settings page renders a password field that stores the value with `secrets.set`.
export const SecretSetting = SecretRef.nullable().meta({ widget: 'secret' });

export const MissedTriggerPolicy = z.enum(['run', 'mark', 'skip']);
export type MissedTriggerPolicy = z.infer<typeof MissedTriggerPolicy>;

const templateStep = (
  skillName: string,
  gateAfter: boolean,
  expectedArtifacts: string[] = [],
): WorkflowTemplateStep => ({ skillName, gateBefore: false, gateAfter, expectedArtifacts });

// Behavior 25. The agent-os skill names appear only here, as editable defaults.
export const defaultWorkflowTemplates: WorkflowTemplate[] = [
  {
    kind: 'bug',
    name: 'Bug',
    steps: [templateStep('deliver-work', false), templateStep('check-work', false)],
  },
  {
    kind: 'feature',
    name: 'Feature',
    steps: [
      templateStep('capture-intent', true, ['intents/*/intent.md', 'intents/*/spec.md']),
      templateStep('plan-work', true, ['intents/*/plan.md']),
      templateStep('deliver-work', false),
      templateStep('check-work', false),
    ],
  },
  {
    kind: 'initiative',
    name: 'Initiative',
    steps: [
      templateStep('capture-intent', true, ['intents/*/intent.md', 'intents/*/spec.md']),
      templateStep('plan-work', true, ['intents/*/plan.md']),
      templateStep('shape-work', true),
      templateStep('deliver-work', false),
      templateStep('check-work', false),
    ],
  },
];

// Behavior 11: by default the previous step's final message and the expected artifact paths.
export const defaultHandoverTemplate = [
  '{{#previousMessage}}The previous step ({{previousStep}}) ended with:',
  '',
  '{{previousMessage}}',
  '{{/previousMessage}}',
  '{{#backlogBody}}Backlog item:',
  '',
  '{{backlogBody}}',
  '{{/backlogBody}}',
  '{{#previousArtifacts}}Artifacts from earlier steps:',
  '{{previousArtifacts}}',
  '{{/previousArtifacts}}',
  '{{#expectedArtifacts}}This step is expected to produce:',
  '{{expectedArtifacts}}',
  '{{/expectedArtifacts}}',
].join('\n');

export const defaultSkillDirectories = [
  '~/.claude/skills',
  '~/.codex/skills',
  '<project>/.claude/skills',
  '<project>/.agents/skills',
] as const;

export const settingsRegistry = {
  'providers.testTimeoutMs': defineSetting({
    schema: z.number().int().min(5000).max(600_000),
    group: 'providers',
    label: 'Test timeout (ms)',
    description:
      'How long the "Test" action of a provider instance may take, including its trivial turn, before it is reported as failed.',
    default: 120_000,
    scope: 'provider',
  }),
  'chat.contextMeter': defineSetting({
    schema: z.boolean(),
    group: 'chat',
    label: 'Context meter',
    description:
      "Show how much of the model's context window the thread uses, from the provider's latest report, with a compact action where the provider supports it.",
    default: true,
    scope: 'provider',
  }),
  'chat.resumePrompt': defineSetting({
    schema: z.string().min(1),
    group: 'chat',
    label: 'Resume message',
    description:
      'What "Resume" sends to continue a thread whose last turn was stopped or failed. The provider session is resumed, so the agent keeps its context.',
    default: 'Continue where you left off.',
    scope: 'provider',
  }),
  'calendar.zone': defineSetting({
    schema: TimeZoneSetting,
    group: 'calendar',
    label: 'Time zone',
    description:
      'Zone the calendar is shown in and new cards are entered in. "system" follows the operating system.',
    default: 'system',
    scope: 'global',
  }),
  'calendar.firstDayOfWeek': defineSetting({
    schema: Weekday,
    group: 'calendar',
    label: 'First day of the week',
    description: 'Day the week view starts on.',
    default: 'monday',
    scope: 'global',
  }),
  'calendar.workHours': defineSetting({
    schema: WorkHours,
    group: 'calendar',
    label: 'Work hours',
    description: 'Hours and days highlighted in the day and week views.',
    default: {
      start: '08:00',
      end: '17:00',
      days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
    },
    scope: 'global',
  }),
  'calendar.lookaheadDays': defineSetting({
    schema: z.number().int().min(1).max(90),
    group: 'calendar',
    label: 'Lookahead (days)',
    description: 'How many days ahead Outlook items are read and cached.',
    default: 14,
    scope: 'global',
  }),
  'calendar.snapMinutes': defineSetting({
    schema: z.number().int().min(1).max(60),
    group: 'calendar',
    label: 'Snap (minutes)',
    description: 'Cards snap to this many minutes when created, moved or resized with the mouse.',
    default: 15,
    scope: 'global',
  }),
  'calendar.cardMinutes': defineSetting({
    schema: z.number().int().min(5).max(480),
    group: 'calendar',
    label: 'New card length (minutes)',
    description: 'Length of a card created with a single click or the "New card" command.',
    default: 30,
    scope: 'global',
  }),
  'calendar.hourHeight': defineSetting({
    schema: z.number().int().min(24).max(160),
    group: 'calendar',
    label: 'Hour height (pixels)',
    description: 'Height of one hour in the day and week views. Larger values zoom in.',
    default: 48,
    scope: 'global',
  }),
  'outlook.pollSeconds': defineSetting({
    schema: z.number().int().min(15).max(3600),
    group: 'outlook',
    label: 'Poll interval (seconds)',
    description: 'How often calendar items and unread mail are read from Outlook.',
    default: 60,
    scope: 'global',
  }),
  'outlook.folders': defineSetting({
    schema: z.array(z.string().min(1)).min(1),
    group: 'outlook',
    label: 'Mail folders',
    description:
      'Folders whose unread mail is shown in the mail rail. "Inbox" is the default inbox; other names are looked up under it, then at the top of the mailbox.',
    default: ['Inbox'],
    scope: 'global',
  }),
  'outlook.requestTimeoutMs': defineSetting({
    schema: z.number().int().min(1000).max(300000),
    group: 'outlook',
    label: 'Request timeout (ms)',
    description:
      'How long one request to Outlook may take. A request that takes longer (for example while Outlook shows a dialog) marks Outlook unavailable and restarts the bridge on the next poll.',
    default: 20000,
    scope: 'global',
  }),
  'outlook.mailRail': defineSetting({
    schema: z.boolean(),
    group: 'outlook',
    label: 'Mail rail',
    description: 'Read unread mail from Outlook and show it next to the calendar.',
    default: true,
    scope: 'global',
  }),
  'outlook.mailLimit': defineSetting({
    schema: z.number().int().min(1).max(500),
    group: 'outlook',
    label: 'Mail rail size',
    description: 'Most unread messages read per poll, newest first. The count covers all of them.',
    default: 50,
    scope: 'global',
  }),
  'scheduler.tickSeconds': defineSetting({
    schema: z.number().int().min(1).max(3600),
    group: 'scheduler',
    label: 'Tick interval (seconds)',
    description: 'How often the scheduler looks for due triggers.',
    default: 30,
    scope: 'global',
  }),
  'scheduler.missedPolicy': defineSetting({
    schema: MissedTriggerPolicy,
    group: 'scheduler',
    label: 'Missed triggers',
    description:
      'What happens at startup to triggers whose time passed while the server was down: run them now, mark them missed with a "Run now" action, or mark them missed and skip them.',
    default: 'mark',
    scope: 'global',
  }),
  'scheduler.notifications': defineSetting({
    schema: z.boolean(),
    group: 'scheduler',
    label: 'Desktop notifications',
    description:
      'Notify when a trigger starts a workflow run, when a run waits for you, and when a run or trigger fails.',
    default: true,
    scope: 'global',
  }),
  'scheduler.toastSeconds': defineSetting({
    schema: z.number().int().min(1).max(600),
    group: 'scheduler',
    label: 'Toast duration (seconds)',
    description: 'How long a notification stays in the corner of the web app.',
    default: 8,
    scope: 'global',
  }),
  'scheduler.paused': defineSetting({
    schema: z.boolean(),
    group: 'scheduler',
    label: 'Paused',
    description:
      'Stop firing triggers until resumed. Triggers that come due while paused are handled like missed ones when the scheduler resumes. The tray menu toggles this.',
    default: false,
    scope: 'global',
  }),
  'desktop.autostart': defineSetting({
    schema: z.boolean(),
    group: 'desktop',
    label: 'Start at sign-in',
    description:
      'Start wow in the tray when you sign in to Windows, so triggers run without opening it.',
    default: false,
    scope: 'global',
  }),
  'desktop.closeToTray': defineSetting({
    schema: z.boolean(),
    group: 'desktop',
    label: 'Close to tray',
    description:
      'Closing the window keeps wow running in the tray, so triggers still fire. Quit from the tray menu. Off: closing the window quits.',
    default: true,
    scope: 'global',
  }),
  'desktop.startMinimized': defineSetting({
    schema: z.boolean(),
    group: 'desktop',
    label: 'Start in the tray',
    description: 'Start without showing the window. Click the tray icon to open it.',
    default: false,
    scope: 'global',
  }),
  'updates.enabled': defineSetting({
    schema: z.boolean(),
    group: 'updates',
    label: 'Automatic updates',
    description:
      'Check GitHub Releases for a newer stable wow at startup and every check interval, download it in the background, and offer "Restart to update". Off: wow never checks.',
    default: true,
    scope: 'global',
  }),
  'updates.checkIntervalMinutes': defineSetting({
    schema: z.number().int().min(15).max(10_080),
    group: 'updates',
    label: 'Check interval (minutes)',
    description: 'How often the desktop app looks for a new release while it runs.',
    default: 240,
    scope: 'global',
  }),
  'workflows.templates': defineSetting({
    schema: z
      .array(WorkflowTemplate)
      .refine((templates) => new Set(templates.map((t) => t.kind)).size === templates.length, {
        message: 'Template kinds must be unique',
      }),
    group: 'workflows',
    label: 'Templates',
    description:
      'Starting points offered by the workflow builder: an ordered list of skills with gates. A workflow built from one keeps no link to it.',
    default: defaultWorkflowTemplates,
    scope: 'global',
  }),
  'workflows.handoverTemplate': defineSetting({
    schema: z.string(),
    group: 'workflows',
    label: 'Handover text',
    description:
      'Text added to every step prompt after the skill invocation. {{previousStep}}, {{previousMessage}}, {{backlogBody}}, {{previousArtifacts}} and {{expectedArtifacts}} are replaced; {{#name}}…{{/name}} is left out when that value is empty.',
    default: defaultHandoverTemplate,
    scope: 'project',
  }),
  'skills.directories': defineSetting({
    schema: z.array(z.string().min(1)),
    group: 'skills',
    label: 'Skill directories',
    description:
      'Folders whose */SKILL.md files are offered as skills. "~" is your home folder and "<project>" is repeated for every project folder.',
    default: [...defaultSkillDirectories],
    scope: 'global',
  }),
  'skills.includeClaudePlugins': defineSetting({
    schema: z.boolean(),
    group: 'skills',
    label: 'Claude plugin skills',
    description: 'Also offer skills from installed Claude Code plugins, invoked as /plugin:skill.',
    default: true,
    scope: 'global',
  }),
  'trackers.jira.baseUrl': defineSetting({
    schema: TrackerUrl,
    group: 'trackers',
    label: 'Jira URL',
    description:
      'Address of your Jira site, such as https://acme.atlassian.net for Jira Cloud or https://jira.example.com for Jira Server or Data Center.',
    default: '',
    scope: 'global',
  }),
  'trackers.jira.authMode': defineSetting({
    schema: JiraAuthMode,
    group: 'trackers',
    label: 'Jira sign-in',
    description:
      'cloud-basic signs in to Jira Cloud with your email and an API token; pat uses a personal access token (Jira Server or Data Center).',
    default: 'cloud-basic',
    scope: 'global',
  }),
  'trackers.jira.email': defineSetting({
    schema: z.string().trim(),
    group: 'trackers',
    label: 'Jira email',
    description: 'Your Atlassian account email. Only used with cloud-basic sign-in.',
    default: '',
    scope: 'global',
  }),
  'trackers.jira.token': defineSetting({
    schema: SecretSetting,
    group: 'trackers',
    label: 'Jira token',
    description:
      'API token (cloud-basic) or personal access token (pat). Stored in the wow secret store and never shown again.',
    default: null,
    scope: 'global',
    secret: true,
  }),
  'trackers.jira.projectKey': defineSetting({
    schema: z.string().trim(),
    group: 'trackers',
    label: 'Jira project key',
    description: 'Project new issues are created in, such as PROJ.',
    default: '',
    scope: 'global',
  }),
  'trackers.jira.issueType': defineSetting({
    schema: z.string().trim().min(1),
    group: 'trackers',
    label: 'Jira issue type',
    description: 'Issue type name new issues get, such as Task or Story.',
    default: 'Task',
    scope: 'global',
  }),
  'trackers.github.baseUrl': defineSetting({
    schema: TrackerUrl,
    group: 'trackers',
    label: 'GitHub API URL',
    description:
      'https://api.github.com for github.com, or https://<host>/api/v3 for GitHub Enterprise Server.',
    default: 'https://api.github.com',
    scope: 'global',
  }),
  'trackers.github.token': defineSetting({
    schema: SecretSetting,
    group: 'trackers',
    label: 'GitHub token',
    description:
      'Token allowed to create issues in the repository. Stored in the wow secret store and never shown again.',
    default: null,
    scope: 'global',
    secret: true,
  }),
  'trackers.github.owner': defineSetting({
    schema: z.string().trim(),
    group: 'trackers',
    label: 'GitHub owner',
    description: 'User or organization that owns the repository issues are created in.',
    default: '',
    scope: 'global',
  }),
  'trackers.github.repo': defineSetting({
    schema: z.string().trim(),
    group: 'trackers',
    label: 'GitHub repository',
    description: 'Repository name issues are created in, without the owner.',
    default: '',
    scope: 'global',
  }),
  'trackers.github.labels': defineSetting({
    schema: z.array(z.string().trim().min(1)),
    group: 'trackers',
    label: 'GitHub labels',
    description: 'Labels every issue published to GitHub gets. Leave empty for none.',
    default: [],
    scope: 'global',
  }),
  'trackers.requestTimeoutMs': defineSetting({
    schema: z.number().int().min(1000).max(300_000),
    group: 'trackers',
    label: 'Request timeout (ms)',
    description:
      'How long creating an issue in Jira or GitHub may take before it is reported as failed.',
    default: 30_000,
    scope: 'global',
  }),
  'appearance.theme': defineSetting({
    schema: Theme,
    group: 'appearance',
    label: 'Theme',
    description: 'Dark or light colors.',
    default: 'dark',
    scope: 'global',
  }),
  'appearance.uiFont': defineSetting({
    schema: FontFamily,
    group: 'appearance',
    label: 'Interface font',
    description:
      'Font family for the interface. Falls back to the system font when it is not installed.',
    default: 'Inter Variable',
    scope: 'global',
  }),
  'appearance.codeFont': defineSetting({
    schema: FontFamily,
    group: 'appearance',
    label: 'Code font',
    description:
      'Font family for code, tool output and keys. Falls back to the system monospace font.',
    default: 'JetBrains Mono Variable',
    scope: 'global',
  }),
  'appearance.density': defineSetting({
    schema: Density,
    group: 'appearance',
    label: 'Density',
    description: 'Compact makes text and spacing smaller so more fits on screen.',
    default: 'comfortable',
    scope: 'global',
  }),
  'keybindings.palette': keybinding('Command palette', 'Open the command palette.', 'Mod+K'),
  'keybindings.toggleSidebar': keybinding(
    'Toggle sidebar',
    'Show or hide the left sidebar.',
    'Mod+B',
  ),
  'keybindings.toggleRightPanel': keybinding(
    'Toggle right panel',
    'Show or hide the right panel.',
    'Mod+J',
  ),
  'keybindings.toggleTheme': keybinding(
    'Toggle theme',
    'Switch between the dark and light theme.',
    'Mod+Shift+L',
  ),
  'keybindings.goCalendar': keybinding('Go to Calendar', 'Open the calendar.', 'Mod+1'),
  'keybindings.goChat': keybinding('Go to Chat', 'Open the chat.', 'Mod+2'),
  'keybindings.goWorkflows': keybinding('Go to Workflows', 'Open the workflows.', 'Mod+3'),
  'keybindings.goBacklog': keybinding('Go to Backlog', 'Open the backlog.', 'Mod+4'),
  'keybindings.goSettings': keybinding('Go to Settings', 'Open the settings.', 'Mod+,'),
  'keybindings.calendarToday': keybinding('Calendar: today', 'Show today in the calendar.', 'T'),
  'keybindings.calendarNext': keybinding(
    'Calendar: next',
    'Move the calendar forward by one day in day view or one week in week view.',
    'N',
  ),
  'keybindings.calendarPrevious': keybinding(
    'Calendar: previous',
    'Move the calendar back by one day in day view or one week in week view.',
    'P',
  ),
  'keybindings.calendarDayView': keybinding('Calendar: day view', 'Show one day.', 'D'),
  'keybindings.calendarWeekView': keybinding('Calendar: week view', 'Show one week.', 'W'),
  'keybindings.newCard': keybinding(
    'New card',
    'Open the form for a new card on the day the calendar shows (while the calendar is open).',
    'C',
  ),
  'keybindings.newThread': keybinding('New thread', 'Start a new chat thread.', 'Mod+Alt+N'),
  'keybindings.stopTurn': keybinding(
    'Stop turn',
    'Interrupt the running turn of the open thread. What it produced so far stays.',
    'Mod+.',
  ),
  'advanced.port': defineSetting({
    schema: z.number().int().min(0).max(65535),
    group: 'advanced',
    label: 'Server port',
    description:
      'Local port the server listens on (127.0.0.1 only). 0 picks a free port at every start.',
    default: 0,
    scope: 'global',
    restartRequired: true,
  }),
  'advanced.logLevel': defineSetting({
    schema: LogLevel,
    group: 'advanced',
    label: 'Log level',
    description: 'How much the server writes to its log.',
    default: 'info',
    scope: 'global',
  }),
  'advanced.secretsTimeoutMs': defineSetting({
    schema: z.number().int().min(1000).max(600_000),
    group: 'advanced',
    label: 'Secret store timeout (ms)',
    description:
      'How long one DPAPI protect or unprotect call may take on Windows before it is stopped and reported as failed.',
    default: 30_000,
    scope: 'global',
  }),
} as const satisfies Record<string, SettingDefinition>;

export type SettingsRegistry = typeof settingsRegistry;
export type SettingKey = keyof SettingsRegistry;
export type SettingValue<K extends SettingKey> = z.output<SettingsRegistry[K]['schema']>;
