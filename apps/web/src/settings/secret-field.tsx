import { SecretRef } from '@wow/contracts';
import { dispatch } from '@wow/client-runtime';
import { useState } from 'react';
import { useRuntime } from '@/app/runtime';
import { errorMessage } from '@/chat/data';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

// The secret store entry a secret setting's value goes to: `setting:<key>` for the shared value,
// `setting:project:<id>:<key>` for a project's own (the server deletes those with the project).
export const settingSecretName = (key: string, projectId?: string) =>
  projectId ? `setting:project:${projectId}:${key}` : `setting:${key}`;

// A setting marked `secret` stores only a reference (architecture "Secrets"): the value goes to
// the secret store with `secrets.set` and is never sent back, so the field only says whether one
// is stored. Clearing resets the setting and deletes the stored value.
export function SecretField({
  id,
  label,
  settingKey,
  value,
  describedBy,
  projectId,
}: {
  id: string;
  label: string;
  settingKey: string;
  value: unknown;
  describedBy?: string | undefined;
  // Stores the project's own value (scope `project:<id>`) instead of the shared one.
  projectId?: string | undefined;
}) {
  const { connection, settings } = useRuntime();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [confirming, setConfirming] = useState(false);
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
          name: settingSecretName(settingKey, projectId),
          value: text,
        }),
      );
      if (projectId) {
        await dispatch(connection, {
          type: 'setting.set',
          key: settingKey,
          scope: `project:${projectId}`,
          value: ref,
        });
      } else {
        const result = await settings.write(settingKey, ref);
        if (!result.ok) throw new Error(result.issues.join('; '));
      }
      setText('');
    });

  const clear = () =>
    run(async () => {
      if (projectId && connection) {
        await dispatch(connection, {
          type: 'setting.reset',
          key: settingKey,
          scope: `project:${projectId}`,
        });
      } else {
        await settings.reset(settingKey);
      }
      await connection?.request('secrets.delete', {
        name: settingSecretName(settingKey, projectId),
      });
    });

  return (
    <div className="grid max-w-xl gap-1.5">
      <div className="flex items-center gap-2">
        <Input
          id={id}
          type="password"
          autoComplete="off"
          aria-label={label}
          aria-describedby={[`${id}-status`, describedBy].filter(Boolean).join(' ')}
          placeholder={stored ? 'Stored. Type to replace.' : 'Not set'}
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
            onClick={() => setConfirming(true)}
          >
            Clear
          </Button>
        )}
        <ConfirmDialog
          open={confirming}
          title={`Delete the stored ${label}?`}
          description="The value is deleted from the wow secret store and cannot be shown or restored. You can save a new one at any time."
          confirmLabel="Delete"
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            void clear();
          }}
        />
      </div>
      <p data-testid={`${id}-status`} className="text-xs text-muted-foreground">
        {stored ? 'Saved' : 'Not set'}
        {!connection && '. Connect to the wow server to save one.'}
      </p>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
