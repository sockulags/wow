import { SearchIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import type { ItemContext } from '../items';
import type { ToolPayload } from './facts';
import { oneLineParts } from './line';

// "Search kettle in src".
export const searchParts = (payload: ToolPayload, context: ItemContext, extra?: ReactNode) =>
  oneLineParts(payload, context, SearchIcon, extra);
