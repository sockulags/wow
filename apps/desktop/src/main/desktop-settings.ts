import { settingsRegistry, type ResolvedSetting, type SettingKey } from '@wow/contracts';

// The settings the desktop shell acts on. They live in the server like every other setting; the
// shell reads them resolved and follows changes through the `settings` topic.
export const desktopSettingKeys = {
  autostart: 'desktop.autostart',
  closeToTray: 'desktop.closeToTray',
  startMinimized: 'desktop.startMinimized',
  schedulerPaused: 'scheduler.paused',
  notifications: 'scheduler.notifications',
} as const satisfies Record<string, SettingKey>;

export type DesktopSettings = { readonly [K in keyof typeof desktopSettingKeys]: boolean };

type DesktopSettingKey = (typeof desktopSettingKeys)[keyof typeof desktopSettingKeys];

export function readDesktopSettings(resolved: readonly ResolvedSetting[]): DesktopSettings {
  const values = new Map(resolved.map((setting) => [setting.key, setting.value]));
  const read = (key: DesktopSettingKey): boolean => {
    const definition = settingsRegistry[key];
    const parsed = definition.schema.safeParse(values.get(key));
    return parsed.success ? parsed.data : definition.default;
  };
  return {
    autostart: read(desktopSettingKeys.autostart),
    closeToTray: read(desktopSettingKeys.closeToTray),
    startMinimized: read(desktopSettingKeys.startMinimized),
    schedulerPaused: read(desktopSettingKeys.schedulerPaused),
    notifications: read(desktopSettingKeys.notifications),
  };
}
