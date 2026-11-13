import { z } from 'zod';

// "Save conversation…" in the desktop app (thread work spec 7): the page hands the main process
// a name to suggest and the text, the main process shows the system's save dialog and writes the
// text where the user chose. The page never names the path; the server writes nothing.
export const SaveTextFileRequest = z.object({
  suggestedName: z.string().min(1).max(255),
  text: z.string(),
});
export type SaveTextFileRequest = z.infer<typeof SaveTextFileRequest>;
