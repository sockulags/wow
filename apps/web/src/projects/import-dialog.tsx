import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useDispatch, useTopic } from '@/chat/data';
import { notify } from '@/lib/feedback';
import { ImportList, importFolders, useDiscoveredProjects } from './import-list';

export const importLabel = (count: number) =>
  count === 1 ? 'Import 1 project' : `Import ${count} projects`;

// "Import from Claude and Codex": the folders the configured provider instances worked in that
// are not projects yet, as a checklist. Each checked folder becomes a project named after it.
export function ImportProjects({ onClose }: { onClose: () => void }) {
  const send = useDispatch();
  const existing = useTopic('projects') ?? [];
  const discovered = useDiscoveredProjects();
  const [busy, setBusy] = useState(false);
  const [failures, setFailures] = useState<readonly string[]>([]);
  const { chosen, offered } = discovered;

  const importChosen = async () => {
    setBusy(true);
    setFailures([]);
    const { imported, failed } = await importFolders(send, chosen, existing);
    setBusy(false);
    if (imported.size > 0) {
      notify.success(
        imported.size === 1 ? '1 project imported' : `${imported.size} projects imported`,
      );
    }
    if (failed.length === 0) {
      onClose();
      return;
    }
    setFailures(failed);
    discovered.keepOnly(offered.filter((entry) => !imported.has(entry.cwd)));
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import from Claude and Codex</DialogTitle>
          <DialogDescription>
            Folders your Claude and Codex instances have worked in that are not projects yet. Each
            one you keep checked becomes a project named after its folder.
          </DialogDescription>
        </DialogHeader>
        <ImportList discovered={discovered} />
        {failures.length > 0 && (
          <ul role="alert" className="text-xs break-all text-destructive">
            {failures.map((failure) => (
              <li key={failure}>{failure}</li>
            ))}
          </ul>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={busy || chosen.length === 0}
            onClick={() => void importChosen()}
          >
            {importLabel(chosen.length)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
