import type { ChangeRequest, HostErrorKind, HostKind, Ticket, UnitRef } from '@wow/contracts';

// What the poller needs from a code host. One adapter per host kind; everything the host calls
// its own way (pull or merge request, check run or pipeline, review comment or note) is
// translated here, so the poller, the orchestrator and the UI see only the normalized shapes
// from packages/contracts. Adapters only read.

// A change request as a search or a list names it, before its checks and comments are read.
export interface FoundChangeRequest {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly state: ChangeRequest['state'];
  readonly draft: boolean;
  readonly mergedAt: string | null;
  // The `Intent-Unit` lines of its body.
  readonly units: readonly UnitRef[];
  // Present when the answer that found it already said where its head is.
  readonly head?: { readonly branch: string; readonly sha: string } | undefined;
}

// A change request as the host has it now; the poller adds the project.
export type HostChangeRequest = Omit<ChangeRequest, 'id' | 'projectId'>;

export interface HostAdapter {
  readonly kind: HostKind;
  // The host as the user knows it, such as github.com.
  readonly name: string;
  // The change requests whose body carries an `Intent-Unit: <intentId>/…` line: one search, or
  // the newest few of the repository on a host without search. Never the whole repository.
  findForIntent(intentId: string): Promise<FoundChangeRequest[]>;
  // The newest change request whose head is this branch, if there is one.
  findForBranch(branch: string): Promise<FoundChangeRequest | undefined>;
  // State, head commit, checks and review comments of one change request.
  read(found: FoundChangeRequest): Promise<HostChangeRequest>;
  // How many requests this adapter has sent.
  readonly requests: number;
  // Set when the host said to leave it alone until then (its request limit is used up).
  readonly waitUntil: Date | undefined;
}

// What the poller needs from a ticket host (Jira): one ticket by its key. Read only, like the
// code hosts; the description comes back as markdown, whatever markup the host writes.
export interface TicketAdapter {
  readonly kind: HostKind;
  // The host as the user knows it, such as jira.example.com.
  readonly name: string;
  read(key: string): Promise<Ticket>;
  readonly requests: number;
  readonly waitUntil: Date | undefined;
}

// A read that did not work, in words for the view. `refused` names the setting to look at.
export class HostFailure extends Error {
  constructor(
    readonly kind: Exclude<HostErrorKind, 'notSetUp'>,
    message: string,
    readonly setting: string | null = null,
  ) {
    super(message);
    this.name = 'HostFailure';
  }
}
