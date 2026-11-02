import { SecretRef } from '@wow/contracts';
import { useState } from 'react';
import { useRuntime } from '@/app/runtime';
import { errorMessage } from '@/chat/data';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

// The secret store entry a secret setting's value goes to.
export const settingSecretName = (key: string) => `setting:${key}`;

// A setting marked `secret` stores only a reference (architecture "Secrets"): the value goes to
// the secret store with `secrets.set` and is never sent back, so the field only says whether one
// is stored. Clearing resets the setting and deletes the stored value.
export function SecretField({
  id,
  label,
  settingKey,
  value,
}: {
  id: string;
  label: string;
  settingKey: string;
  value: unknown;
}) {
  const { connection, settings } = useRuntime();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const stored = SecretRef.safeParse(value).success;

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const save = () =>
    run(async () => {
      if (!connection) return;
      const ref = SecretRef.parse(
        await connection.request('secrets.set', {
          name: settingSecretName(settingKey),
          value: text,
        }),
      );
      const result = await settings.write(settingKey, ref);
      if (!result.ok) throw new Error(result.issues.join('; '));
      setText('');
    });

  const clear = () =>
    run(async () => {
      await settings.reset(settingKey);
      await connection?.request('secrets.delete', { name: settingSecretName(settingKey) });
    });

  return (
    <div className="grid gap-1.5">
      <div className="flex items-center gap-2">
        <Input
          id={id}
          type="password"
          autoComplete="off"
          aria-label={label}
          placeholder={stored ? 'Stored; type to replace' : 'Not set'}
          value={text}
          disabled={!connection}
          onChange={(event) => setText(event.target.value)}
        />
        <Button
          type="button"
          size="sm"
          disabled={!connection || busy || text === ''}
          onClick={() => void save()}
        >
          Save
        </Button>
        {stored && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void clear()}
          >
            Clear
          </Button>
        )}
      </div>
      <p data-testid={`${id}-status`} className="text-xs text-muted-foreground">
        {stored ? 'A value is stored.' : 'No value stored.'}
        {!connection && ' Connect to the wow server to store one.'}
      </p>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
