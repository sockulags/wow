---
id: 2026-11-parallel-threads
status: done
rev: 1
supersedes: null
---

# Many threads at once: see them all, and take their work home

## Who and why

Lucas runs several agents at the same time. Since thread work (0.3.8) a chat thread can have its
own working copy on its own branch, and since the chief of staff (0.4.0) the assistant starts its
threads that way. Two things now get in the way of running many at once:

- The work of a thread in its own working copy only comes back through a commit and a pull
  request. For a small change, or one he wants to try in his own folder before he commits, that is
  a branch, a push and a pull request too many. He copies files by hand or asks the agent to.
- He cannot see what his threads are doing without opening them one by one. The thread list says
  Working or Needs you; "Needs you" in the assistant lists what waits, not what runs. A thread is
  shown alone: next to one thread he cannot follow another.

## Desired outcome

When this is done:

- **Bring the work home.** From a thread's Changes, "Apply to project folder" puts what the thread
  changed in its working copy into the project's own folder as uncommitted changes, after a
  confirm that lists every file. A file he changed too is merged where Git can do it without a
  conflict, and otherwise left for him and named; nothing of his is overwritten. Undo puts the
  files back.
- **See all threads at work.** One view lists every thread that works, waits for him, or finished
  since he last looked, with what each does right now ("Running pnpm test · 2:10 · 14 tool
  calls"), what it waits for, or the last thing it said. One key gets there; Enter opens a thread.
- **Two threads side by side.** Any thread can open in a tab of the side panel next to the thread
  or view he is in, with its conversation and composer, as a workflow step's thread already does.

## Out of scope

- Merging or rebasing branches, resolving conflicts, or committing in the project folder. Apply
  writes files; what to commit stays his.
- Applying from a thread without its own working copy (its changes are already in the folder), or
  from a workflow run's working copy (the run's delivery owns that).
- The assistant applying changes on its own. It has no tool for it, as for commits.
- A grid of several conversations in the main view. One more thread fits in the side panel.

This intent changes one boundary of `2026-11-thread-work` ("no merge"): wow may write a thread's
changes into the project folder, file by file, using `git merge-file` for a file both sides
changed. It still makes no commit, merge commit or rebase.

## Open questions

None. The owner picked these two of three proposals ("Kör på 2 och 3") and left the details to
the coordinator.

## Decision log

- 2026-11-22: the owner asked what the chat still lacks and chose "a way back without a pull
  request" and "an overview of everything that runs". Apply writes files rather than merging
  branches, so it never touches the project's history; a file both sides changed is merged only
  when Git reports no conflict.
