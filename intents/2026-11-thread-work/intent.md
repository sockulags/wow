---
id: 2026-11-thread-work
status: accepted
rev: 1
supersedes: null
---

# A chat thread's work after the agent has changed files

## Who and why

Lucas works with agents all day, in wow and beside it in Claude Code and the Codex app. The agent
workbench (`2026-11-agent-workbench`, delivered in 0.3.2 to 0.3.5) made the chat read and steer
like those tools: the model bar, tool rows, diffs, a thread's Changes, approvals, fork and edit.
What happens once the agent has changed files still sends him back to the terminal or the other
apps:

- In a long thread he cannot find where the agent said or ran something. Ctrl+F does nothing, and
  text inside a closed tool row or a folded group is not on screen to find. He cannot copy or keep
  a conversation as a whole, only one message at a time.
- Two threads in one project edit the same files. Runs can have a working copy of their own; a
  chat thread cannot, so he opens a second checkout by hand or waits.
- Edit of the last message goes back in the conversation but leaves the files as the replaced
  turn left them. Claude Code's rewind puts the code back too. In wow he undoes by hand or asks
  the agent to.
- The Changes tab shows what the thread changed, and then he goes to a terminal to commit, push
  and open the pull request, and back to wow to look at it.
- When a tool is missing or an MCP server failed to start, nothing in wow says which servers,
  tools, skills, commands and subagents the session has. Claude Code shows that with `/mcp`.

## Desired outcome

When this is done, the work after an agent changed files stays in wow, from the keyboard, with
wow's look and wow's safety rules:

- Ctrl+F finds text anywhere in a thread's conversation, tool output included, with a count and
  next and previous, opening what holds a match. The whole conversation can be copied or saved as
  Markdown.
- A chat thread in a Git project can have its own working copy and branch, so threads do not
  edit the same files; the thread shows them, and the copy goes away when the thread is done
  without losing anything that was not committed unless he says yes.
- Edit of the last message, and "Restore files to here" on an earlier one, can put the thread's
  files back to how they were when that turn started, with Undo; changes made outside the thread
  are shown before anything is overwritten.
- From the Changes tab he commits the files he picks, with a message the agent proposes when
  asked, and opens a pull request or merge request on GitHub or GitLab; the result shows in the
  thread as a chip.
- A Tools tab lists the MCP servers with their state and error, the tools, skills, commands and
  subagents the session reports, with nothing secret.

## Out of scope

- A terminal, a file editor or a Git client inside wow: no staging of hunks, no branch switching,
  no merge, rebase or conflict resolution, no history browser.
- Merging, approving or commenting on pull requests; signing in to MCP servers; turning servers
  or tools on or off.
- Changing what the providers can do. Where a provider reports nothing, wow says so.
- Mobile and remote access.

## Open questions

None. The owner named the five gaps, their order of value and the safety rules (nothing unmerged
thrown away without a yes, never skip commit hooks, the assistant never commits or pushes, the
tools list holds nothing secret) and delegated the rest to the coordinator's judgement, with
Claude Code and the Codex app as the reference.

## Decision log
