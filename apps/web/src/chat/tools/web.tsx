import { GlobeIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import type { ItemContext } from '../items';
import type { ToolPayload } from './facts';
import { oneLineParts } from './line';

// "Fetch example.org" or "Search the web for …". The address is text, not a link: what a link
// may open follows the chat's link rules, which are not this row's.
export const webParts = (payload: ToolPayload, context: ItemContext, extra?: ReactNode) =>
  oneLineParts(payload, context, GlobeIcon, extra);
