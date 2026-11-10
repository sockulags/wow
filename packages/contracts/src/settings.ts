import { z } from 'zod';
import {
  alwaysStopSkillDefaults,
  WorkflowTemplate,
  type WorkflowTemplateStep,
} from './workflow.js';

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
  'plans',
  'trackers',
  'hosts',
  'triggers',
  'viewer',
  'diff',
  'workspaces',
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

// The unit a number setting is stored in. The settings page shows it as a suffix and shows
// milliseconds as seconds and bytes as kilobytes, so labels carry no unit.
export const SettingUnit = z.enum([
  'ms',
  'seconds',
  'minutes',
  'days',
  'pixels',
  'percent',
  'bytes',
]);
export type SettingUnit = z.infer<typeof SettingUnit>;

// How the settings page names one value of an enum setting; the stored value stays the id.
export interface SettingOption {
  readonly label: string;
  readonly description?: string;
}

export interface SettingDefinition<S extends z.ZodType = z.ZodType> {
  readonly schema: S;
  readonly group: SettingGroup;
  readonly label: string;
  readonly description: string;
  readonly default: z.output<S>;
  readonly scope: SettingScope;
  readonly restartRequired?: boolean;
  readonly secret?: boolean;
  readonly unit?: SettingUnit;
  // Labels for enum values (and enum list items). Without them the page shows the raw value.
  readonly options?: Readonly<Record<string, SettingOption>>;
  // Show the choices as a radio group with descriptions instead of a select.
  readonly radio?: boolean;
}

const defineSetting = <S extends z.ZodType>(definition: SettingDefinition<S>) => definition;

// The context panel's width range; the web app's resize handle stops at the same bounds.
export const contextPanelWidthBounds = { min: 280, max: 720 } as const;

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

export const weekdayOptions: Readonly<Record<Weekday, SettingOption>> = {
  monday: { label: 'Monday' },
  tuesday: { label: 'Tuesday' },
  wednesday: { label: 'Wednesday' },
  thursday: { label: 'Thursday' },
  friday: { label: 'Friday' },
  saturday: { label: 'Saturday' },
  sunday: { label: 'Sunday' },
};

const isTimeZone = (zone: string): boolean => {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone !== '';
  } catch {
    return false;
  }
};

// "outlook" follows the zone Outlook's calendar uses, "system" the operating system's. The
// `widget` meta tells the settings page to render a searchable zone picker.
export const TimeZoneSetting = z
  .string()
  .refine((zone) => zone === 'outlook' || zone === 'system' || isTimeZone(zone), {
    message: 'Use "outlook", "system" or an IANA time zone such as Europe/Stockholm',
  })
  .meta({ widget: 'timeZone' });

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
  })
  .meta({ widget: 'workHours' });
export type WorkHours = z.infer<typeof WorkHours>;

// A calendar preference Outlook also stores (F-8): "outlook" follows what Outlook says, anything
// else overrides it. The `widget` meta tells the settings page to show Outlook's value with an
// Override switch.
export const FROM_OUTLOOK = 'outlook';
const fromOutlook = <S extends z.ZodType>(schema: S) =>
  z.union([z.literal(FROM_OUTLOOK), schema]).meta({ widget: 'fromOutlook' });

export const WeekdaySetting = fromOutlook(Weekday);
export const WorkHoursSetting = fromOutlook(WorkHours);

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

// A folder inside a project, written relative to it. It may not leave the project folder, so a
// setting cannot point the plans reader at other files on the machine.
export const IntentsDirectory = z
  .string()
  .trim()
  .min(1)
  .refine(
    (value) =>
      !/^([A-Za-z]:|[\\/]|~)/.test(value) &&
      !value.split(/[\\/]/).some((segment) => segment === '..') &&
      value.split(/[\\/]/).some((segment) => segment !== '' && segment !== '.'),
    { message: 'Use a folder inside the project, such as intents or docs/intents' },
  );

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

// The review loops back to delivery until it approves (workflow branches spec 20).
const checkWorkStep: WorkflowTemplateStep = {
  ...templateStep('check-work', false),
  rules: [
    {
      when: { fact: 'verdict', is: 'changesRequested' },
      goTo: { type: 'skill', skillName: 'deliver-work' },
    },
  ],
};

// Behavior 25. The agent-os skill names appear only here, as editable defaults.
export const defaultWorkflowTemplates: WorkflowTemplate[] = [
  {
    kind: 'bug',
    name: 'Bug',
    steps: [templateStep('deliver-work', false), checkWorkStep],
  },
  {
    kind: 'feature',
    name: 'Feature',
    steps: [
      templateStep('capture-intent', true, ['intents/*/intent.md', 'intents/*/spec.md']),
      templateStep('plan-work', true, ['intents/*/plan.md']),
      templateStep('deliver-work', false),
      checkWorkStep,
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
      checkWorkStep,
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
  '{{#previousError}}The previous step ({{previousStep}}) failed with:',
  '',
  '{{previousError}}',
  '{{/previousError}}',
  '{{#expectedArtifacts}}This step is expected to produce:',
  '{{expectedArtifacts}}',
  '{{/expectedArtifacts}}',
  '{{#event}}This run was started by an event: {{event}}.',
  'Pull request #{{pullRequestNumber}}: {{pullRequestUrl}}',
  'Branch: {{pullRequestBranch}}',
  '{{/event}}',
  '{{#commentUrl}}The review comment, by {{commentAuthor}}: {{commentUrl}}',
  'Its text is left out here on purpose; read it at that link.',
  '{{/commentUrl}}',
].join('\n');

export const defaultSendBackTemplate = [
  'The reviewer looked at the result of this step and sent it back.',
  '',
  "Reviewer's note:",
  '',
  '{{note}}',
  '',
  'Do the step ({{skill}}) again in this conversation with the note taken into account, and end with your result as before.',
].join('\n');

// What a step is told in its own thread when a rule of a later step sends the run back to it
// (workflow branches spec 7).
export const defaultGoBackTemplate = [
  'The step {{fromStep}} sent the work back to this step: {{reason}}.',
  '',
  '{{#message}}What {{fromStep}} ended with:',
  '',
  '{{message}}',
  '',
  '{{/message}}Do the step ({{skill}}) again in this conversation with that taken into account, and end with your result as before.',
].join('\n');

// What a plan run tells every step of a unit's run (review loop spec 40). The last line is how
// wow finds the unit's pull request afterwards.
export const defaultUnitPromptTemplate = [
  'This run delivers one unit of a plan.',
  '',
  'Intent: {{intentId}}',
  'Unit: {{unitKey}} {{unitTitle}}',
  '',
  'When you open a pull request for it, put this line in its body: Intent-Unit: {{intentId}}/{{unitKey}}',
].join('\n');

export const PlanRunOnFailure = z.enum(['stop', 'skip']);
export type PlanRunOnFailure = z.infer<typeof PlanRunOnFailure>;

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
    label: 'Test timeout',
    description:
      'How long the "Test" action of a provider instance may take, including its trivial turn, before it is reported as failed. It also bounds the protocol check of a Codex version other than the tested one.',
    default: 120_000,
    scope: 'provider',
    unit: 'ms',
  }),
  'providers.requestTimeoutMs': defineSetting({
    schema: z.number().int().min(1000).max(600_000),
    group: 'providers',
    label: 'Request timeout',
    description:
      'How long a provider app-server (Codex) may take to answer one request, such as starting a thread or a turn, before the request fails and the app-server is restarted. Streamed turn output is not limited by it.',
    default: 60_000,
    scope: 'provider',
    unit: 'ms',
  }),
  'providers.updateTimeoutMs': defineSetting({
    schema: z.number().int().min(30_000).max(3_600_000),
    group: 'providers',
    label: 'Update timeout',
    description:
      'How long "Update Codex" may run npm to install the tested Codex version before it is stopped and reported as failed.',
    default: 600_000,
    scope: 'provider',
    unit: 'ms',
  }),
  'providers.offerSetup': defineSetting({
    schema: z.boolean(),
    group: 'providers',
    label: 'Offer setup at start',
    description:
      'Open the setup guide for providers and projects when wow starts without a provider instance. "Not now" in the guide turns this off.',
    default: true,
    scope: 'global',
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
  'chat.starterCount': defineSetting({
    schema: z.number().int().min(0).max(12),
    group: 'chat',
    label: 'Starters on a new thread',
    description:
      "How many skills, and how many open backlog items, the new-thread view offers as one-click starters below the composer (the project's skills first). 0 hides them.",
    default: 4,
    scope: 'global',
  }),
  'calendar.zone': defineSetting({
    schema: TimeZoneSetting,
    group: 'calendar',
    label: 'Time zone',
    description:
      "Zone the calendar is shown in and new cards are entered in. By default it is the zone Outlook's calendar uses, or the system's while Outlook has not been read.",
    default: 'outlook',
    scope: 'global',
  }),
  'calendar.firstDayOfWeek': defineSetting({
    schema: WeekdaySetting,
    group: 'calendar',
    label: 'First day of the week',
    description:
      "Day the week view starts on. By default it follows Outlook, or the system's region while Outlook has not been read.",
    default: 'outlook',
    scope: 'global',
    options: weekdayOptions,
  }),
  'calendar.workHours': defineSetting({
    schema: WorkHoursSetting,
    group: 'calendar',
    label: 'Work hours',
    description:
      'Hours and days highlighted in the day and week views. By default they are the work hours set in Outlook, or 08:00–17:00 Monday to Friday while Outlook has not been read.',
    default: 'outlook',
    scope: 'global',
  }),
  'calendar.showWeekends': defineSetting({
    schema: z.boolean(),
    group: 'calendar',
    label: 'Weekends in week view',
    description: 'Show Saturday and Sunday in the week view. Off shows the five work days.',
    default: true,
    scope: 'global',
  }),
  'calendar.weekMaxColumns': defineSetting({
    schema: z.number().int().min(2).max(6),
    group: 'calendar',
    label: 'Side-by-side items in week view',
    description:
      'Most items shown next to each other in one week-view day. More overlapping items go behind a "+N" button that lists them. Day view always shows them all.',
    default: 2,
    scope: 'global',
  }),
  'calendar.lookaheadDays': defineSetting({
    schema: z.number().int().min(1).max(90),
    group: 'calendar',
    label: 'Lookahead',
    description: 'How many days ahead Outlook items are read and cached.',
    default: 14,
    scope: 'global',
    unit: 'days',
  }),
  'calendar.snapMinutes': defineSetting({
    schema: z.number().int().min(1).max(60),
    group: 'calendar',
    label: 'Snap to',
    description: 'Cards snap to this many minutes when created, moved or resized with the mouse.',
    default: 15,
    scope: 'global',
    unit: 'minutes',
  }),
  'calendar.cardMinutes': defineSetting({
    schema: z.number().int().min(5).max(480),
    group: 'calendar',
    label: 'New card length',
    description: 'Length of a card created with a single click or the "New card" command.',
    default: 30,
    scope: 'global',
    unit: 'minutes',
  }),
  'calendar.hourHeight': defineSetting({
    schema: z.number().int().min(24).max(144),
    group: 'calendar',
    label: 'Hour height',
    description:
      'Height of one hour in the day and week views, which is the calendar zoom. Ctrl+mouse wheel, pinch and the zoom commands change it.',
    default: 48,
    scope: 'global',
    unit: 'pixels',
  }),
  'calendar.zoomStep': defineSetting({
    schema: z.number().int().min(5).max(100),
    group: 'calendar',
    label: 'Zoom step',
    description:
      'How much one zoom command, key press or mouse-wheel notch changes the hour height.',
    default: 20,
    scope: 'global',
    unit: 'percent',
  }),
  'outlook.pollSeconds': defineSetting({
    schema: z.number().int().min(15).max(3600),
    group: 'outlook',
    label: 'Poll interval',
    description: 'How often calendar items and unread mail are read from Outlook.',
    default: 60,
    scope: 'global',
    unit: 'seconds',
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
    label: 'Request timeout',
    description:
      'How long one request to Outlook may take. A request that takes longer (for example while Outlook shows a dialog) marks Outlook unavailable and restarts the bridge on the next poll.',
    default: 20000,
    scope: 'global',
    unit: 'ms',
  }),
  'outlook.mailRail': defineSetting({
    schema: z.boolean(),
    group: 'outlook',
    label: 'Mail rail',
    description: 'Read unread mail from Outlook and show it next to the calendar.',
    default: true,
    scope: 'global',
  }),
  'outlook.mailRailCollapsed': defineSetting({
    schema: z.boolean(),
    group: 'outlook',
    label: 'Mail rail collapsed',
    description:
      'Fold the mail rail to a narrow strip with the unread count. The rail button, the palette and its key change it.',
    default: false,
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
    label: 'Tick interval',
    description: 'How often the scheduler looks for due triggers.',
    default: 30,
    scope: 'global',
    unit: 'seconds',
  }),
  'scheduler.missedPolicy': defineSetting({
    schema: MissedTriggerPolicy,
    group: 'scheduler',
    label: 'Missed triggers',
    description:
      'What happens at startup to triggers whose time passed while the server was down: run them now, mark them missed with a "Run now" action, or mark them missed and skip them.',
    default: 'mark',
    scope: 'global',
    radio: true,
    options: {
      run: {
        label: 'Run them now',
        description: 'Start every missed workflow as soon as wow starts.',
      },
      mark: {
        label: 'Mark as missed',
        description: 'Show them as missed on the calendar with a "Run now" action.',
      },
      skip: {
        label: 'Skip them',
        description: 'Show them as missed and do not offer to run them.',
      },
    },
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
    label: 'Toast duration',
    description:
      'How long a notification or a confirmation (with its Undo) stays in the corner of the window.',
    default: 8,
    scope: 'global',
    unit: 'seconds',
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
    label: 'Check interval',
    description: 'How often the desktop app looks for a new release while it runs.',
    default: 240,
    scope: 'global',
    unit: 'minutes',
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
    schema: z.string().meta({
      widget: 'template',
      placeholders: [
        'previousStep',
        'previousMessage',
        'backlogBody',
        'previousArtifacts',
        'previousError',
        'expectedArtifacts',
        'event',
        'pullRequestNumber',
        'pullRequestUrl',
        'pullRequestBranch',
        'commentUrl',
        'commentAuthor',
      ],
    }),
    group: 'workflows',
    label: 'Handover text',
    description:
      'Text added to every step prompt after the skill invocation. The placeholders below are replaced; a {{#name}}…{{/name}} section is left out when that value is empty.',
    default: defaultHandoverTemplate,
    scope: 'project',
  }),
  'workflows.sendBackTemplate': defineSetting({
    schema: z.string().meta({ widget: 'template', placeholders: ['note', 'skill', 'attempt'] }),
    group: 'workflows',
    label: 'Send back text',
    description:
      "The message a step gets in its own thread when you send it back at a gate. {{note}} is what you wrote, {{skill}} the step's skill and {{attempt}} the number of this try; a {{#name}}…{{/name}} section is left out when that value is empty.",
    default: defaultSendBackTemplate,
    scope: 'project',
  }),
  'workflows.goBackTemplate': defineSetting({
    schema: z.string().meta({
      widget: 'template',
      placeholders: ['fromStep', 'reason', 'message', 'skill', 'attempt'],
    }),
    group: 'workflows',
    label: 'Go back text',
    description:
      "The message a step gets in its own thread when a rule of a later step sends the run back to it. {{fromStep}} is the step that sent it back, {{reason}} the fact that held, {{message}} that step's final message (or its error), {{skill}} this step's skill and {{attempt}} the number of this try; a {{#name}}…{{/name}} section is left out when that value is empty.",
    default: defaultGoBackTemplate,
    scope: 'project',
  }),
  'workflows.unitPromptTemplate': defineSetting({
    schema: z
      .string()
      .meta({ widget: 'template', placeholders: ['intentId', 'unitKey', 'unitTitle'] }),
    group: 'workflows',
    label: 'Unit text',
    description:
      "What every step is told about its unit when a plan run starts the workflow for one. It goes after the step's skill and before the handover. {{intentId}} is the intent's folder name, {{unitKey}} the unit's key and {{unitTitle}} its title; a {{#name}}…{{/name}} section is left out when that value is empty.",
    default: defaultUnitPromptTemplate,
    scope: 'project',
  }),
  'workflows.planRunOnFailure': defineSetting({
    schema: PlanRunOnFailure,
    group: 'workflows',
    label: "When a unit's run fails",
    description: 'What a plan run does when the run of one of its units fails or is stopped.',
    default: 'stop',
    scope: 'project',
    radio: true,
    options: {
      stop: {
        label: 'Stop the plan run',
        description: 'No further unit starts until you start a plan run again.',
      },
      skip: {
        label: 'Leave the unit and go on',
        description: 'The next ready unit starts. Units that depend on the one left stay waiting.',
      },
    },
  }),
  'workflows.verdictApprovedLine': defineSetting({
    schema: z.string().trim().min(1),
    group: 'workflows',
    label: 'Approved verdict line',
    description:
      'The line a step\'s final message must end with for the "Approved verdict" part of a gate\'s condition to hold. Only the last line that is not empty counts; backticks or bold around it are ignored.',
    default: 'APPROVED',
    scope: 'project',
  }),
  'workflows.verdictChangesRequestedLine': defineSetting({
    schema: z.string().trim().min(1),
    group: 'workflows',
    label: 'Changes requested verdict line',
    description:
      'The line a step\'s final message ends with for a rule on the verdict "changes requested" to hold. Read like the approved line: only the last line that is not empty counts.',
    default: 'CHANGES_REQUESTED',
    scope: 'project',
  }),
  'workflows.verdictBlockedLine': defineSetting({
    schema: z.string().trim().min(1),
    group: 'workflows',
    label: 'Blocked verdict line',
    description:
      'The line a step\'s final message ends with for a rule on the verdict "blocked" to hold. Read like the approved line: only the last line that is not empty counts.',
    default: 'BLOCKED',
    scope: 'project',
  }),
  'workflows.maxStepVisits': defineSetting({
    schema: z.number().int().min(1).max(50),
    group: 'workflows',
    label: 'Step starts before a run waits for you',
    description:
      'How often one step may start in a run. When a rule or the order of the steps would start it once more, the run waits for you there: Approve lets the step run once more, Stop ends the run. A workflow can set its own number.',
    default: 3,
    scope: 'project',
  }),
  'workflows.alwaysStopSkills': defineSetting({
    schema: z.array(z.string().trim().min(1)),
    group: 'workflows',
    label: 'Skills that always stop',
    description:
      'The gate after a step with one of these skills always waits for you and cannot get a condition. capture-intent, plan-work, design-work and shape-work always stop, whether they are listed or not; add the skills your project plans or specifies with. The builder and saving a workflow use the list as set for all projects.',
    default: [...alwaysStopSkillDefaults],
    scope: 'project',
  }),
  'workflows.gateChecksTimeoutMinutes': defineSetting({
    schema: z.number().int().min(1).max(1440),
    group: 'workflows',
    label: 'Wait for checks at a gate',
    description:
      "How long a gate whose condition includes the pull request's checks waits for them to finish after its step ended. After that the run waits for you.",
    default: 30,
    scope: 'project',
    unit: 'minutes',
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
  'plans.intentsDirectory': defineSetting({
    schema: IntentsDirectory,
    group: 'plans',
    label: 'Intents folder',
    description:
      'Folder inside a project whose <id>/intent.md, spec.md and plan.md files the Plans view reads. wow only reads them.',
    default: 'intents',
    scope: 'project',
  }),
  'plans.writeSettleMs': defineSetting({
    schema: z.number().int().min(0).max(10_000),
    group: 'plans',
    label: 'Wait for a file to settle',
    description:
      'How long an intent, spec or plan file must stay the same size before it is read again after a change, so a file is not read halfway through a save.',
    default: 200,
    scope: 'global',
    unit: 'ms',
  }),
  'trackers.jira.baseUrl': defineSetting({
    schema: TrackerUrl,
    group: 'trackers',
    label: 'Jira URL',
    description:
      'Address of your Jira site, such as https://acme.atlassian.net for Jira Cloud or https://jira.example.com for Jira Server or Data Center.',
    default: '',
    scope: 'project',
  }),
  'trackers.jira.authMode': defineSetting({
    schema: JiraAuthMode,
    group: 'trackers',
    label: 'Jira sign-in',
    description: 'How wow signs in to Jira.',
    default: 'cloud-basic',
    scope: 'project',
    radio: true,
    options: {
      'cloud-basic': {
        label: 'Jira Cloud',
        description: 'Your Atlassian email and an API token.',
      },
      pat: {
        label: 'Jira Server or Data Center',
        description: 'A personal access token.',
      },
    },
  }),
  'trackers.jira.email': defineSetting({
    schema: z.string().trim(),
    group: 'trackers',
    label: 'Jira email',
    description: 'Your Atlassian account email. Only used for Jira Cloud.',
    default: '',
    scope: 'project',
  }),
  'trackers.jira.token': defineSetting({
    schema: SecretSetting,
    group: 'trackers',
    label: 'Jira token',
    description:
      'An API token for Jira Cloud, or a personal access token for Jira Server or Data Center. Stored in the wow secret store and never shown again.',
    default: null,
    scope: 'project',
    secret: true,
  }),
  'trackers.jira.projectKey': defineSetting({
    schema: z.string().trim(),
    group: 'trackers',
    label: 'Jira project key',
    description: 'Project new issues are created in, such as PROJ.',
    default: '',
    scope: 'project',
  }),
  'trackers.jira.issueType': defineSetting({
    schema: z.string().trim().min(1),
    group: 'trackers',
    label: 'Jira issue type',
    description: 'Issue type name new issues get, such as Task or Story.',
    default: 'Task',
    scope: 'project',
  }),
  'trackers.github.baseUrl': defineSetting({
    schema: TrackerUrl,
    group: 'trackers',
    label: 'GitHub API URL',
    description:
      "https://api.github.com for github.com, or https://<host>/api/v3 for GitHub Enterprise Server. A project whose git remote is on a GitHub host uses that host's instead.",
    default: 'https://api.github.com',
    scope: 'project',
  }),
  'trackers.github.token': defineSetting({
    schema: SecretSetting,
    group: 'trackers',
    label: 'GitHub token',
    description:
      'Token allowed to create issues in the repository. Stored in the wow secret store and never shown again.',
    default: null,
    scope: 'project',
    secret: true,
  }),
  'trackers.github.owner': defineSetting({
    schema: z.string().trim(),
    group: 'trackers',
    label: 'GitHub owner',
    description:
      "User or organization that owns the repository issues are created in. A project whose git remote is a GitHub repository uses the remote's owner instead.",
    default: '',
    scope: 'project',
  }),
  'trackers.github.repo': defineSetting({
    schema: z.string().trim(),
    group: 'trackers',
    label: 'GitHub repository',
    description:
      "Repository name issues are created in, without the owner. A project whose git remote is a GitHub repository uses the remote's name instead.",
    default: '',
    scope: 'project',
  }),
  'trackers.github.labels': defineSetting({
    schema: z.array(z.string().trim().min(1)),
    group: 'trackers',
    label: 'GitHub labels',
    description: 'Labels every issue published to GitHub gets. Leave empty for none.',
    default: [],
    scope: 'project',
  }),
  'trackers.gitlab.baseUrl': defineSetting({
    schema: TrackerUrl,
    group: 'trackers',
    label: 'GitLab URL',
    description:
      'The GitLab site, such as https://gitlab.example.com. A project whose git remote is on this host reads its merge requests from it; its token goes nowhere else.',
    default: '',
    scope: 'project',
  }),
  'trackers.gitlab.token': defineSetting({
    schema: SecretSetting,
    group: 'trackers',
    label: 'GitLab token',
    description:
      'A personal or project access token with read_api. Stored in the wow secret store and never shown again.',
    default: null,
    scope: 'project',
    secret: true,
  }),
  'trackers.confluence.baseUrl': defineSetting({
    schema: TrackerUrl,
    group: 'trackers',
    label: 'Confluence URL',
    description:
      'Address of your Confluence site, such as https://acme.atlassian.net/wiki for Confluence Cloud or https://confluence.example.com for Server or Data Center. Only pages on this site that a ticket, pull request or intent links to are read; its token goes nowhere else.',
    default: '',
    scope: 'project',
  }),
  'trackers.confluence.authMode': defineSetting({
    schema: JiraAuthMode,
    group: 'trackers',
    label: 'Confluence sign-in',
    description: 'How wow signs in to Confluence.',
    default: 'pat',
    scope: 'project',
    radio: true,
    options: {
      'cloud-basic': {
        label: 'Confluence Cloud',
        description: 'Your Atlassian email and an API token.',
      },
      pat: {
        label: 'Confluence Server or Data Center',
        description: 'A personal access token, sent as a bearer token.',
      },
    },
  }),
  'trackers.confluence.email': defineSetting({
    schema: z.string().trim(),
    group: 'trackers',
    label: 'Confluence email',
    description: 'Your Atlassian account email. Only used for Confluence Cloud.',
    default: '',
    scope: 'project',
  }),
  'trackers.confluence.token': defineSetting({
    schema: SecretSetting,
    group: 'trackers',
    label: 'Confluence token',
    description:
      'An API token for Confluence Cloud, or a personal access token for Confluence Server or Data Center, allowed to read the linked pages. Stored in the wow secret store and never shown again.',
    default: null,
    scope: 'project',
    secret: true,
  }),
  'trackers.requestTimeoutMs': defineSetting({
    schema: z.number().int().min(1000).max(300_000),
    group: 'trackers',
    label: 'Request timeout',
    description:
      'How long creating an issue in Jira or GitHub may take before it is reported as failed.',
    default: 30_000,
    scope: 'global',
    unit: 'ms',
  }),
  'trackers.gitTimeoutMs': defineSetting({
    schema: z.number().int().min(500).max(60_000),
    group: 'trackers',
    label: 'Git timeout',
    description:
      "How long reading a project's git remotes, branches and recent commits may take before wow shows the project without them.",
    default: 5_000,
    scope: 'global',
    unit: 'ms',
  }),
  'trackers.jira.keyScanCommits': defineSetting({
    schema: z.number().int().min(0).max(5_000),
    group: 'trackers',
    label: 'Commits searched for Jira keys',
    description:
      'How many recent commits of a project wow reads to suggest its Jira project key from references such as ABC-123. 0 turns the suggestion off.',
    default: 200,
    scope: 'global',
  }),
  'triggers.eventsEnabled': defineSetting({
    schema: z.boolean(),
    group: 'triggers',
    label: 'Start runs from events',
    description:
      'Let event triggers start a workflow run when polling first sees a pull request merged, its checks fail or a review comment arrive. Off: events seen meanwhile start nothing, also not later. A paused scheduler does the same.',
    default: true,
    scope: 'global',
  }),
  'triggers.ignoredCommentAuthors': defineSetting({
    schema: z.array(z.string().trim().min(1)),
    group: 'triggers',
    label: 'Accounts whose comments start nothing',
    description:
      "Host account names whose review comments never start a run, for example the account your agents write as. A comment that arrives while the trigger's own run for that pull request is still going starts nothing either, so a run that answers a review cannot start the next one.",
    default: [],
    scope: 'global',
  }),
  'hosts.polling': defineSetting({
    schema: z.boolean(),
    group: 'hosts',
    label: 'Ask the hosts on a timer',
    description:
      'Read pull requests of followed plans and live runs from their host at every interval. Off: nothing is asked until you press Refresh now, except once when a unit run of a plan run ends and once when a gate starts waiting for the checks of a pull request. A paused scheduler also stops it.',
    default: true,
    scope: 'global',
  }),
  'hosts.pollSeconds': defineSetting({
    schema: z.number().int().min(10).max(86_400),
    group: 'hosts',
    label: 'Interval',
    description:
      'How often wow asks the hosts. A host that says its request limit is used up is left alone until the limit resets, however short this is.',
    default: 60,
    scope: 'global',
    unit: 'seconds',
  }),
  'hosts.listFallbackCount': defineSetting({
    schema: z.number().int().min(1).max(100),
    group: 'hosts',
    label: 'Pull requests read without search',
    description:
      "On a host without search, how many of the repository's newest pull requests are read to find a plan's own.",
    default: 30,
    scope: 'global',
  }),
  'viewer.maxFileBytes': defineSetting({
    schema: z.number().int().min(1000).max(50_000_000),
    group: 'viewer',
    label: 'Largest file shown',
    description:
      'A file larger than this is not read when you open it in the side panel; the panel says so instead.',
    default: 2_000_000,
    scope: 'global',
    unit: 'bytes',
  }),
  'viewer.htmlScripts': defineSetting({
    schema: z.boolean(),
    group: 'viewer',
    label: 'Run scripts in HTML files',
    description:
      'Let an HTML file shown in the side panel run the scripts written in it. Scripts in attributes such as onclick stay off, and the page still cannot reach the app, the network or the disk.',
    default: false,
    scope: 'global',
  }),
  'viewer.highlightMaxBytes': defineSetting({
    schema: z.number().int().min(0).max(50_000_000),
    group: 'viewer',
    label: 'Largest file highlighted',
    description:
      'A text file larger than this is shown as plain text, because coloring a very long file makes the app slow. 0 turns coloring off.',
    default: 200_000,
    scope: 'global',
    unit: 'bytes',
  }),
  'diff.maxFileBytes': defineSetting({
    schema: z.number().int().min(1000).max(1_000_000),
    group: 'diff',
    label: 'Largest file compared',
    description:
      "A changed file larger than this is listed in a run's Changes tab with its status and size, without its lines.",
    default: 400_000,
    scope: 'global',
    unit: 'bytes',
  }),
  'diff.maxFiles': defineSetting({
    schema: z.number().int().min(10).max(20_000),
    group: 'diff',
    label: 'Most files listed',
    description:
      "How many changed files a run's Changes tab lists and remembers per step. The tab says how many it left out.",
    default: 2_000,
    scope: 'global',
  }),
  'workspaces.root': defineSetting({
    schema: z.string().trim().min(1),
    group: 'workspaces',
    label: 'Folder for working copies',
    description:
      'Where runs of a workflow with "Own working copy" get their copy of the project. A full path, or a folder name inside wow\'s own folder. On Windows a short path leaves more room for long file names.',
    default: 'workspaces',
    scope: 'global',
  }),
  'workspaces.fetchBeforeCreate': defineSetting({
    schema: z.boolean(),
    group: 'workspaces',
    label: 'Fetch before making a working copy',
    description:
      "Fetch the project's remote first, so a working copy starts at the newest commit of the default branch. Off, or when the fetch fails: it starts at the commit this computer already has, and the run says so.",
    default: true,
    scope: 'project',
  }),
  'workspaces.gitTimeoutMs': defineSetting({
    schema: z.number().int().min(1_000).max(3_600_000),
    group: 'workspaces',
    label: 'Git timeout',
    description:
      'How long fetching, making or removing a working copy may take. A fetch that takes longer counts as failed; a working copy that cannot be made in time fails its run.',
    default: 120_000,
    scope: 'global',
    unit: 'ms',
  }),
  'appearance.theme': defineSetting({
    schema: Theme,
    group: 'appearance',
    label: 'Theme',
    description: 'Dark or light colors.',
    default: 'dark',
    scope: 'global',
    radio: true,
    options: { dark: { label: 'Dark' }, light: { label: 'Light' } },
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
    options: { comfortable: { label: 'Comfortable' }, compact: { label: 'Compact' } },
  }),
  'appearance.paletteRecent': defineSetting({
    schema: z.number().int().min(0).max(20),
    group: 'appearance',
    label: 'Recent items in the palette',
    description:
      'How many recent threads, runs and backlog items the command palette lists before you type.',
    default: 5,
    scope: 'global',
  }),
  'appearance.contextPanel': defineSetting({
    schema: z.boolean(),
    group: 'appearance',
    label: 'Context panel',
    description:
      'Show the panel on the right with the details and thread of what you select. In a narrow window it folds away on its own and opens over the view.',
    default: false,
    scope: 'global',
  }),
  'appearance.contextPanelWidth': defineSetting({
    schema: z.number().int().min(contextPanelWidthBounds.min).max(contextPanelWidthBounds.max),
    group: 'appearance',
    label: 'Context panel width',
    description: 'Width of the context panel. Dragging its left edge changes it.',
    default: 380,
    scope: 'global',
    unit: 'pixels',
  }),
  'keybindings.palette': keybinding('Command palette', 'Open the command palette.', 'Mod+K'),
  'keybindings.toggleSidebar': keybinding(
    'Toggle sidebar',
    'Show or hide the left sidebar.',
    'Mod+B',
  ),
  'keybindings.toggleRightPanel': keybinding(
    'Toggle context panel',
    'Show or hide the context panel on the right.',
    'Mod+J',
  ),
  'keybindings.focusContextPanel': keybinding(
    'Focus context panel',
    'Move the focus into the context panel, and back to the view when it is already there. Opens the panel when it is closed.',
    'F6',
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
  'keybindings.goPlans': keybinding('Go to Plans', 'Open the plans.', 'Mod+5'),
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
  'keybindings.calendarZoomIn': keybinding(
    'Zoom in calendar',
    'Make hours taller in the day and week views (while the calendar is open).',
    'Mod+=',
  ),
  'keybindings.calendarZoomOut': keybinding(
    'Zoom out calendar',
    'Make hours shorter in the day and week views (while the calendar is open).',
    'Mod+-',
  ),
  'keybindings.calendarZoomReset': keybinding(
    'Reset calendar zoom',
    'Go back to the default hour height (while the calendar is open).',
    'Mod+0',
  ),
  'keybindings.newCard': keybinding(
    'New card',
    'Open the form for a new card on the day the calendar shows (while the calendar is open).',
    'C',
  ),
  'keybindings.toggleMailRail': keybinding(
    'Toggle mail rail',
    'Fold or unfold the unread mail rail next to the calendar (while the calendar is open).',
    'M',
  ),
  'keybindings.newThread': keybinding('New thread', 'Start a new chat thread.', 'Mod+Alt+N'),
  'keybindings.stopTurn': keybinding(
    'Stop turn',
    'Interrupt the running turn of the open thread. What it produced so far stays.',
    'Mod+.',
  ),
  'keybindings.gateApprove': keybinding(
    'Approve',
    "Approve the step a workflow run waits for you on, so the run continues, from its run view or the waiting step's thread.",
    'Mod+Enter',
  ),
  'keybindings.gateSendBack': keybinding(
    'Send back',
    "Open the note field to send the step a workflow run waits for you on back to its agent, from its run view or the waiting step's thread.",
    'Mod+Shift+Enter',
  ),
  'keybindings.runChanges': keybinding(
    'Run: show changes',
    'Switch the open workflow run between its steps and its Changes tab.',
    'Mod+Shift+D',
  ),
  'keybindings.runPath': keybinding(
    'Run: show path',
    'Switch the open workflow run between its steps and its Path tab.',
    'Mod+Shift+Y',
  ),
  'keybindings.changesStepOnly': keybinding(
    'Changes: this step only',
    "Narrow the open run's Changes tab to the files the step under review changed, and back (while the tab is open).",
    'O',
  ),
  'keybindings.ruleAdd': keybinding(
    'Rule: add',
    'Add a rule under "After this step" to the step being edited in the workflow builder.',
    'Alt+R',
  ),
  'keybindings.ruleMoveUp': keybinding(
    'Rule: move up',
    'Move the rule that has the keyboard one place up in its step, so it is tried earlier (in the workflow builder).',
    'Alt+ArrowUp',
  ),
  'keybindings.ruleMoveDown': keybinding(
    'Rule: move down',
    'Move the rule that has the keyboard one place down in its step, so it is tried later (in the workflow builder).',
    'Alt+ArrowDown',
  ),
  'keybindings.stopRun': keybinding(
    'Stop run',
    'Stop the open workflow run. Empty by default, because a stopped run cannot be continued.',
    '',
  ),
  'keybindings.approvalAllowOnce': keybinding(
    'Approval: allow once',
    'Allow the request the open thread waits for, this time only (while the approval has focus or nothing else does).',
    'A',
  ),
  'keybindings.approvalAllowSession': keybinding(
    'Approval: allow for this session',
    'Allow the request the open thread waits for, and the same kind for the rest of the session.',
    'S',
  ),
  'keybindings.approvalDeny': keybinding(
    'Approval: deny',
    'Deny the request the open thread waits for.',
    'D',
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
    options: {
      error: { label: 'Errors only' },
      warn: { label: 'Warnings and errors' },
      info: { label: 'Information' },
      debug: { label: 'Everything (debug)' },
    },
  }),
  'advanced.secretsTimeoutMs': defineSetting({
    schema: z.number().int().min(1000).max(600_000),
    group: 'advanced',
    label: 'Secret store timeout',
    description:
      'How long one DPAPI protect or unprotect call may take on Windows before it is stopped and reported as failed.',
    default: 30_000,
    scope: 'global',
    unit: 'ms',
  }),
  'advanced.showSettingKeys': defineSetting({
    schema: z.boolean(),
    group: 'advanced',
    label: 'Show setting keys',
    description:
      "Show each setting's key and stored default under it, for editing config files or reporting issues.",
    default: false,
    scope: 'global',
  }),
} as const satisfies Record<string, SettingDefinition>;

export type SettingsRegistry = typeof settingsRegistry;
export type SettingKey = keyof SettingsRegistry;
export type SettingValue<K extends SettingKey> = z.output<SettingsRegistry[K]['schema']>;
