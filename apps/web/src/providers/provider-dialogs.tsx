import { useEffect, useRef } from 'react';
import { useLayout, useRuntime } from '@/app/runtime';
import { useTopic } from '@/chat/data';
import { FirstRunWizard } from './first-run-wizard';
import { InstanceEditor } from './instance-editor';
import { draftFromInstance, emptyDraft, testInstance } from './model';

// Tests instances that were never tested, and renders whichever provider dialog the settings
// page or a palette command asked for. With no instance, the first-start gate (app/first-start)
// shows the step "Connect an agent" instead of opening the wizard; the wizard stays one palette
// command away ("Detect installed providers").
export function ProviderDialogs() {
  const { connection, layout } = useRuntime();
  const dialog = useLayout((state) => state.providerDialog);
  const instances = useTopic('providerInstances');
  const tested = useRef(false);

  useEffect(() => {
    if (tested.current || !connection || instances === undefined) return;
    tested.current = true;
    // An instance never tested says "Not tested" until someone presses Test; test it now
    // instead (audit E-03). The result arrives through the subscription.
    for (const instance of instances) {
      if (instance.status === 'unknown') void testInstance(connection, instance.id);
    }
  }, [connection, instances]);

  const close = () => layout.setState({ providerDialog: undefined });
  if (!dialog) return null;
  switch (dialog.type) {
    case 'wizard':
      return <FirstRunWizard onClose={close} />;
    case 'create':
      return (
        <InstanceEditor
          key={`create-${dialog.kind}`}
          instance={undefined}
          initial={emptyDraft(
            dialog.kind,
            (instances ?? []).map((instance) => instance.name),
          )}
          onClose={close}
        />
      );
    case 'edit': {
      const instance = instances?.find((candidate) => candidate.id === dialog.providerInstanceId);
      if (!instance) return null;
      return (
        <InstanceEditor
          key={`edit-${instance.id}`}
          instance={instance}
          initial={draftFromInstance(instance)}
          onClose={close}
        />
      );
    }
  }
}
