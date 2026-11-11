---
id: 2026-11-wow-skills
status: accepted
rev: 1
supersedes: null
---

# Skills that belong to wow: built in, and my own, picked with a slash and shown as a chip

## Who and why

Lucas runs agents through wow with skills from his own folders (agent-os, his Claude and Codex
skill folders, each project's). wow itself has none. So the things only wow knows have to be typed
into each step's extra prompt, or the agent gets them wrong: ending with the line a gate or a rule
reads, writing the artifacts a step is expected to leave, putting the `Intent-Unit` line in a pull
request so the Plans view sees the unit, writing a handover the next step can use.

He also has no place in wow to write a skill of his own. A short instruction he wants in several
workflows means making a folder and a file by hand in the right place for each provider.

Picking a skill in the composer is awkward too: it is typed with `$`, where he and the agents he
uses expect `/`, and a picked skill stays raw text in the message.

## Desired outcome

When this is done:

- wow comes with a small set of its own skills for the things only wow knows. They are in the
  skill list and the workflow builder under their own group, and work the same on Claude Code and
  Codex without copying files anywhere.
- Where a workflow needs one (a gate or a rule that reads a verdict, a step with expected
  artifacts), the step gets it without Lucas adding it, and the builder shows that it did.
- Lucas can write, change and remove his own skills in wow, use them in chat and in workflow
  steps, and they travel in the setup file he sends to colleagues.
- A step can be given more than one skill: the one it runs, and others it should also follow.
- The assistant can write a skill for him, and that waits for his yes, because a skill steers
  what agents do.
- In the composer a skill is picked with `/`, and a picked skill is a chip, in the composer and
  in the sent message, not raw text.

## Out of scope

- A marketplace, sharing skills other than through the setup file, or versions of a skill.
- Editing skills that live in other folders (agent-os, the providers' own, a project's). wow lists
  them as before.
- Skills with scripts or bundled files. A wow skill is a name, a description and a text.
- Changing how the providers find their own skills.

## Open questions

None. The owner confirmed both kinds of skill, the `/` trigger and the chip, and delegated the
rest; the decisions are recorded in the spec.

## Decision log
