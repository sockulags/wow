import { FileTextIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { OpenFileButton } from '@/panel/open-file-button';
import type { ItemContext } from '../items';
import { shownPath, type ToolPayload } from './facts';
import { oneLineParts } from './line';

// "Read README.md lines 1-80", with Open for its file (spec 17, 28).
export const readParts = (payload: ToolPayload, context: ItemContext, extra?: ReactNode) =>
  oneLineParts(
    payload,
    context,
    FileTextIcon,
    <>
      {extra}
      {payload.path !== undefined && <OpenFileButton path={shownPath(payload.path, context.cwd)} />}
    </>,
  );
