import { settingValue, type SettingsStore } from '@wow/client-runtime';
import { useStore } from 'zustand';
import { useRuntime, useSetting, type LayoutStore } from '@/app/runtime';
import { isBelow, useBelow } from '@/lib/use-breakpoint';

// Whether the context panel is on screen (owner decision F-1). A wide window follows the
// appearance.contextPanel setting; a narrow one never gives the panel room, and opening it there
// lays it over the view until it is closed again (contextPanelPeek), without changing the setting.

export const CONTEXT_PANEL_ID = 'context-panel';
export const MAIN_VIEW_ID = 'main-view';

interface PanelContext {
  readonly settings: SettingsStore;
  readonly layout: LayoutStore;
}

export function useContextPanelShown(): boolean {
  const open = useSetting('appearance.contextPanel');
  const narrow = useBelow('narrow');
  const peek = useStore(useRuntime().layout, (state) => state.contextPanelPeek);
  return narrow ? peek : open;
}

export function isContextPanelShown({ settings, layout }: PanelContext): boolean {
  return isBelow('narrow')
    ? layout.getState().contextPanelPeek
    : settingValue(settings.getState().values, 'appearance.contextPanel');
}

export function setContextPanelShown({ settings, layout }: PanelContext, shown: boolean): void {
  if (isBelow('narrow')) {
    layout.setState({ contextPanelPeek: shown });
    return;
  }
  layout.setState({ contextPanelPeek: false });
  if (settingValue(settings.getState().values, 'appearance.contextPanel') !== shown) {
    void settings.write('appearance.contextPanel', shown);
  }
}

export function toggleContextPanel(context: PanelContext): void {
  if (isContextPanelShown(context)) closeContextPanel(context);
  else setContextPanelShown(context, true);
}

// Where "Focus context panel" goes back to: the element that had the focus before.
let returnFocus: HTMLElement | undefined;

const panelElement = () => document.getElementById(CONTEXT_PANEL_ID) ?? undefined;

export function focusPanel(panel: HTMLElement): void {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !panel.contains(active)) {
    returnFocus = active instanceof HTMLElement && active !== document.body ? active : undefined;
  }
  panel.focus();
}

// A dialog (the palette) holds the focus while it is open and puts it back where it was when it
// closes, so a request made from inside one waits for the dialog to let go.
const inDialog = (element: Element | null): boolean =>
  element?.closest('[role="dialog"], [role="alertdialog"]') != null;

// Focuses the panel if a request is waiting and nothing holds the focus; true when it did. A
// closing dialog calls it with `closing`, as it is about to let go.
export function takePanelFocusRequest(layout: LayoutStore, closing = false): boolean {
  const panel = panelElement();
  if (!layout.getState().contextPanelFocus || !panel) return false;
  if (!closing && inDialog(document.activeElement)) return false;
  layout.setState({ contextPanelFocus: false });
  focusPanel(panel);
  return true;
}

function requestPanelFocus(context: PanelContext): void {
  const active = document.activeElement;
  if (!inDialog(active)) {
    returnFocus = active instanceof HTMLElement && active !== document.body ? active : undefined;
  }
  context.layout.setState({ contextPanelFocus: true });
  if (!isContextPanelShown(context)) setContextPanelShown(context, true);
  else takePanelFocusRequest(context.layout);
}

// Into the panel, or back to the view when the focus is already in it. A closed panel opens
// first and takes the focus once it is rendered.
export function toggleContextPanelFocus(context: PanelContext): void {
  const panel = panelElement();
  const active = document.activeElement;
  if (panel && active instanceof Node && panel.contains(active)) {
    const back =
      returnFocus?.isConnected === true ? returnFocus : document.getElementById(MAIN_VIEW_ID);
    returnFocus = undefined;
    back?.focus();
    return;
  }
  requestPanelFocus(context);
}

// "Show in panel": open it on what the view has selected and move the focus there.
export function showInContextPanel(context: PanelContext): void {
  requestPanelFocus(context);
}

// Closing from inside the panel puts the focus back where it came from.
export function closeContextPanel(context: PanelContext): void {
  const active = document.activeElement;
  const inside = active instanceof Node && panelElement()?.contains(active) === true;
  if (!inside) {
    setContextPanelShown(context, false);
    return;
  }
  const back =
    returnFocus?.isConnected === true ? returnFocus : document.getElementById(MAIN_VIEW_ID);
  returnFocus = undefined;
  setContextPanelShown(context, false);
  back?.focus();
}
