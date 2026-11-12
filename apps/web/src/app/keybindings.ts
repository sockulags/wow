// Shortcuts are stored as text such as "Mod+Shift+L" (see `Keybinding` in @wow/contracts). These
// helpers turn a keyboard event into the same text so matching is a string comparison.

const MODIFIER_ORDER = ['Mod', 'Ctrl', 'Alt', 'Shift', 'Meta'] as const;
type Modifier = (typeof MODIFIER_ORDER)[number];

const CODE_KEYS: Readonly<Record<string, string>> = {
  Comma: ',',
  Period: '.',
  Slash: '/',
  Semicolon: ';',
  Quote: "'",
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Backquote: '`',
  Equal: '=',
  Minus: '-',
  Space: 'Space',
};

const NAMED_KEYS = new Set([
  'Escape',
  'Enter',
  'Tab',
  'Backspace',
  'Delete',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
]);

export interface KeyLike {
  readonly key: string;
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly metaKey: boolean;
}

export const isMacPlatform = (): boolean =>
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent);

// The physical key, so a shortcut works the same on Swedish and US layouts.
function keyName(event: KeyLike): string | undefined {
  const { code, key } = event;
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^F([1-9]|1[0-2])$/.test(code)) return code;
  const mapped = CODE_KEYS[code];
  if (mapped) return mapped;
  if (NAMED_KEYS.has(code)) return code;
  if (NAMED_KEYS.has(key)) return key;
  if (/^F([1-9]|1[0-2])$/.test(key)) return key;
  if (/^[a-z0-9]$/i.test(key)) return key.toUpperCase();
  return undefined;
}

// Returns undefined for a bare modifier press or a key that cannot be bound.
export function eventToBinding(event: KeyLike, mac = isMacPlatform()): string | undefined {
  const key = keyName(event);
  if (!key) return undefined;
  const modifiers = new Set<Modifier>();
  if (mac ? event.metaKey : event.ctrlKey) modifiers.add('Mod');
  if (mac && event.ctrlKey) modifiers.add('Ctrl');
  if (!mac && event.metaKey) modifiers.add('Meta');
  if (event.altKey) modifiers.add('Alt');
  if (event.shiftKey) modifiers.add('Shift');
  return [...MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier)), key].join('+');
}

// Puts modifiers in a fixed order and folds Ctrl (Windows, Linux) or Meta (macOS) into Mod.
export function normalizeBinding(binding: string, mac = isMacPlatform()): string {
  if (binding === '') return '';
  const parts = binding.split('+');
  // A trailing "+" key would split into an empty part; the schema does not allow "+" as a key.
  const key = parts.pop() ?? '';
  const modifiers = new Set(
    parts.map((part) => {
      if (!mac && part === 'Ctrl') return 'Mod';
      if (mac && part === 'Meta') return 'Mod';
      return part;
    }),
  );
  return [...MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier)), key].join('+');
}

export function formatBinding(binding: string, mac = isMacPlatform()): string {
  if (binding === '') return '';
  return normalizeBinding(binding, mac)
    .split('+')
    .map((part) => {
      if (part === 'Mod') return mac ? '⌘' : 'Ctrl';
      if (part === 'Meta') return mac ? '⌘' : 'Win';
      if (part === 'Alt' && mac) return '⌥';
      if (part === 'Shift' && mac) return '⇧';
      return part;
    })
    .join(mac ? '' : '+');
}

export const hasCommandModifier = (binding: string): boolean =>
  /(^|\+)(Mod|Ctrl|Alt|Meta)\+/.test(binding);

// A function key types nothing, so like a shortcut with a modifier it works in a text field (F2
// renames the open thread while the composer has the keyboard).
export const worksInTextFields = (binding: string): boolean =>
  hasCommandModifier(binding) || /(^|\+)F([1-9]|1[0-2])$/.test(binding);
