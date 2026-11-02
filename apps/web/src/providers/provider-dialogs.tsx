import { useEffect, useRef } from 'react';
import { useLayout, useRuntime, useSetting } from '@/app/runtime';
import { useTopic } from '@/chat/data';
import { FirstRunWizard } from './first-run-wizard';
import { InstanceEditor } from './instance-editor';
import { draftFromInstance, emptyDraft, testInstance } from './model';

// Opens the first-run wizard once when the server has no provider instance (unless "Not now"
// turned providers.offerSetup off), tests instances that were never tested, and renders whichever
// provider dialog the settings page or a palette command asked for.
export function ProviderDialogs() {
  const { connection, layout } = useRuntime();
  const dialog = useLayout((state) => state.providerDialog);
  const instances = useTopic('providerInstances');
  const offerSetup = useSetting('providers.offerSetup');
  const offered = useRef(false);

  useEffect(() => {
    if (offered.current || !connection || instances === undefined) return;
    offered.current = true;
    if (instances.length === 0 && offerSetup && layout.getState().providerDialog === undefined) {
      layout.setState({ providerDialog: { type: 'wizard' } });
    }
    // An instance never tested says "Not tested" until someone presses Test; test it now
    // instead (audit E-03). The result arrives through the subscription.
    for (const instance of instances) {
      if (instance.status === 'unknown') void testInstance(connection, instance.id);
    }
  }, [connection, instances, layout, offerSetup]);

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
