import { z } from 'zod';

// The normalized provider protocol. Adapters translate their own wire format to and from these
// types; orchestration and the UI never see provider-specific shapes.

export const ProviderKind = z.enum(['claude', 'codex']);
export type ProviderKind = z.infer<typeof ProviderKind>;

export const ThreadState = z.enum(['idle', 'working', 'needs_you', 'done', 'failed']);
export type ThreadState = z.infer<typeof ThreadState>;

// Model, effort and permission mode values differ per provider and per installed version, so they
// stay strings here and each adapter validates them against what its provider reports.
const Model = z.string().min(1);
const Effort = z.string().min(1);
const PermissionMode = z.string().min(1);

export const ApprovalDecision = z.enum(['allowOnce', 'allowSession', 'deny']);
export type ApprovalDecision = z.infer<typeof ApprovalDecision>;

export const ProviderCommand = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('startTurn'),
    threadId: z.string().min(1),
    cwd: z.string().min(1),
    prompt: z.string(),
    model: Model,
    effort: Effort,
    permissionMode: PermissionMode,
    resumeId: z.string().min(1).optional(),
  }),
  z.object({ type: z.literal('interrupt'), threadId: z.string().min(1) }),
  z.object({
    type: z.literal('answerApproval'),
    approvalId: z.string().min(1),
    decision: ApprovalDecision,
  }),
  z.object({
    type: z.literal('answerQuestion'),
    questionId: z.string().min(1),
    answer: z.string(),
  }),
  z.object({ type: z.literal('setModel'), threadId: z.string().min(1), model: Model }),
  z.object({
    type: z.literal('setPermissionMode'),
    threadId: z.string().min(1),
    permissionMode: PermissionMode,
  }),
  z.object({ type: z.literal('listModels') }),
  z.object({ type: z.literal('test') }),
]);
export type ProviderCommand = z.infer<typeof ProviderCommand>;

export const ApprovalKind = z.enum(['command', 'fileChange', 'tool']);
export type ApprovalKind = z.infer<typeof ApprovalKind>;

export const QuestionOption = z.object({
  label: z.string().min(1),
  description: z.string().optional(),
});
export type QuestionOption = z.infer<typeof QuestionOption>;

export const TaskStatus = z.enum(['pending', 'in_progress', 'completed']);
export type TaskStatus = z.infer<typeof TaskStatus>;

const ThreadScoped = { threadId: z.string().min(1) };

export const ProviderEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('session'), ...ThreadScoped, providerSessionId: z.string().min(1) }),
  z.object({
    type: z.literal('textDelta'),
    ...ThreadScoped,
    itemId: z.string().min(1),
    delta: z.string(),
  }),
  z.object({
    type: z.literal('reasoningDelta'),
    ...ThreadScoped,
    itemId: z.string().min(1),
    delta: z.string(),
  }),
  z.object({
    type: z.literal('toolCallStarted'),
    ...ThreadScoped,
    itemId: z.string().min(1),
    name: z.string().min(1),
    input: z.unknown(),
  }),
  z.object({
    type: z.literal('toolCallOutput'),
    ...ThreadScoped,
    itemId: z.string().min(1),
    output: z.string(),
  }),
  z.object({
    type: z.literal('toolCallCompleted'),
    ...ThreadScoped,
    itemId: z.string().min(1),
    status: z.enum(['ok', 'error']),
  }),
  z.object({
    type: z.literal('approvalRequested'),
    ...ThreadScoped,
    approvalId: z.string().min(1),
    kind: ApprovalKind,
    summary: z.string(),
    request: z.unknown(),
  }),
  z.object({
    type: z.literal('questionAsked'),
    ...ThreadScoped,
    questionId: z.string().min(1),
    question: z.string().min(1),
    options: z.array(QuestionOption),
    multiSelect: z.boolean(),
  }),
  z.object({
    type: z.literal('taskListUpdated'),
    ...ThreadScoped,
    tasks: z.array(z.object({ id: z.string().min(1), content: z.string(), status: TaskStatus })),
  }),
  z.object({
    type: z.literal('usage'),
    ...ThreadScoped,
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cachedInputTokens: z.number().int().nonnegative(),
    costUsd: z.number().nonnegative().optional(),
  }),
  z.object({
    type: z.literal('contextUsage'),
    ...ThreadScoped,
    usedTokens: z.number().int().nonnegative(),
    maxTokens: z.number().int().positive(),
  }),
  z.object({ type: z.literal('turnCompleted'), ...ThreadScoped }),
  z.object({ type: z.literal('turnFailed'), ...ThreadScoped, error: z.string() }),
  z.object({ type: z.literal('turnInterrupted'), ...ThreadScoped }),
]);
export type ProviderEvent = z.infer<typeof ProviderEvent>;

// What every provider adapter implements. The server owns adapters, feeds them commands and
// turns the events they emit into thread commands; nothing outside an adapter sees its wire format.
export interface ProviderAdapter {
  readonly kind: ProviderKind;
  send(command: ProviderCommand): Promise<unknown>;
  onEvent(listener: (event: ProviderEvent) => void): () => void;
  dispose(): Promise<void>;
}
