import { Undo2Icon, XIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { createStore, useStore } from 'zustand';
import { useSetting } from '@/app/runtime';
import { Button } from '@/components/ui/button';
import { errorMessage } from './data';

// Delete at once, offer Undo (owner decision F-9). A local stand-in for the shared confirm-or-undo
// toast the design-system unit adds; call sites only use `offerUndo`, so swapping it is one file.

export interface UndoOffer {
  readonly id: string;
  // "Deleted Feature: search panel."
  readonly message: string;
  undo(): Promise<unknown>;
}

const offers = createStore<readonly UndoOffer[]>(() => []);

export function offerUndo(offer: Omit<UndoOffer, 'id'>): void {
  const id = globalThis.crypto.randomUUID();
  offers.setState((current) => [...current, { ...offer, id }]);
}

const dismiss = (id: string) =>
  offers.setState((current) => current.filter((offer) => offer.id !== id));

// Test hook: what is offered right now.
export const currentUndoOffers = (): readonly UndoOffer[] => offers.getState();

function UndoToast({ offer, seconds }: { offer: UndoOffer; seconds: number }) {
  const [error, setError] = useState<string>();
  const [paused, setPaused] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (paused || error) return undefined;
    const timer = setTimeout(() => dismiss(offer.id), seconds * 1000);
    return () => clearTimeout(timer);
  }, [offer.id, seconds, paused, error]);
  const undo = () => {
    setBusy(true);
    offer.undo().then(
      () => dismiss(offer.id),
      (reason: unknown) => {
        setBusy(false);
        setError(errorMessage(reason));
      },
    );
  };
  return (
    <li
      data-testid="undo-toast"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      className="flex w-80 flex-col gap-1 rounded-md border border-border bg-popover p-3 text-sm text-popover-foreground shadow-md"
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1">{offer.message}</span>
        <Button size="sm" variant="outline" disabled={busy} onClick={undo}>
          <Undo2Icon />
          Undo
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Dismiss"
          onClick={() => dismiss(offer.id)}
        >
          <XIcon />
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </li>
  );
}

export function LocalUndoToaster() {
  const shown = useStore(offers);
  const seconds = useSetting('appearance.undoSeconds');
  return (
    <ol
      aria-label="Undo"
      aria-live="polite"
      className="pointer-events-auto fixed bottom-3 left-1/2 z-50 flex -translate-x-1/2 flex-col gap-2"
    >
      {shown.map((offer) => (
        <UndoToast key={offer.id} offer={offer} seconds={seconds} />
      ))}
    </ol>
  );
}
