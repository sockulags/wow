import { FileTextIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import type { ItemContext } from '../items';
import type { ToolPayload } from './facts';
import { oneLineParts } from './line';

// "Read README.md lines 1-80".
export const readParts = (payload: ToolPayload, context: ItemContext, extra?: ReactNode) =>
  oneLineParts(payload, context, FileTextIcon, extra);
