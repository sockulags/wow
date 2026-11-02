import {
  settingsRegistry,
  type ResolvedSetting,
  type SettingKey,
  type SettingValue,
} from '@wow/contracts';

// The settings the desktop shell acts on. They live in the server like every other setting; the
// shell reads them resolved and follows changes through the `settings` topic.
export const desktopSettingKeys = {
  autostart: 'desktop.autostart',
  closeToTray: 'desktop.closeToTray',
  startMinimized: 'desktop.startMinimized',
  schedulerPaused: 'scheduler.paused',
  notifications: 'scheduler.notifications',
  updatesEnabled: 'updates.enabled',
  updateCheckIntervalMinutes: 'updates.checkIntervalMinutes',
} as const satisfies Record<string, SettingKey>;

type Keys = typeof desktopSettingKeys;

export type DesktopSettings = { readonly [K in keyof Keys]: SettingValue<Keys[K]> };

export function readDesktopSettings(resolved: readonly ResolvedSetting[]): DesktopSettings {
  const values = new Map(resolved.map((setting) => [setting.key, setting.value]));
  const read = <K extends SettingKey>(key: K): SettingValue<K> => {
    const definition = settingsRegistry[key];
    const parsed = definition.schema.safeParse(values.get(key));
    return (parsed.success ? parsed.data : definition.default) as SettingValue<K>;
  };
  return {
    autostart: read(desktopSettingKeys.autostart),
    closeToTray: read(desktopSettingKeys.closeToTray),
    startMinimized: read(desktopSettingKeys.startMinimized),
    schedulerPaused: read(desktopSettingKeys.schedulerPaused),
    notifications: read(desktopSettingKeys.notifications),
    updatesEnabled: read(desktopSettingKeys.updatesEnabled),
    updateCheckIntervalMinutes: read(desktopSettingKeys.updateCheckIntervalMinutes),
  };
}
