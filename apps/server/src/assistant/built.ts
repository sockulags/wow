import type { Command } from '@wow/contracts';
import type { z } from 'zod';
import type { AssistantToolsDeps } from './tools.js';

// A change tool whose command the tool writes from a smaller input than the command's own.
export interface BuiltTool<S extends z.ZodType = z.ZodType> {
  readonly description: string;
  readonly input: S;
  // The command, or the reason it is refused, or null when it is already so.
  build(
    args: z.output<S>,
    deps: AssistantToolsDeps,
  ): Command | { refused: string } | null | Promise<Command | { refused: string } | null>;
}

export const built = <S extends z.ZodType>(tool: BuiltTool<S>): BuiltTool =>
  tool as unknown as BuiltTool;
