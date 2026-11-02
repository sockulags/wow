import { createContext, useContext, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

// The shell header's middle: a view renders its toolbar into it instead of adding a second row
// under the header (audit A-21). Keep it to one line of size="sm" controls; it truncates rather
// than wraps.
//
//   <ShellToolbar>
//     <Button size="sm" variant="ghost">Today</Button>
//   </ShellToolbar>
const SlotContext = createContext<HTMLElement | null>(null);

export function ShellToolbarSlot({
  value,
  children,
}: {
  value: HTMLElement | null;
  children: ReactNode;
}) {
  return <SlotContext value={value}>{children}</SlotContext>;
}

// Renders nothing outside the shell (isolated tests), and inline as a fallback is not wanted:
// a view without the shell has no header to share.
export function ShellToolbar({ children }: { children: ReactNode }) {
  const slot = useContext(SlotContext);
  if (slot === null) return null;
  return createPortal(children, slot);
}
