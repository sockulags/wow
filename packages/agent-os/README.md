# @wow/agent-os

Reads agent-os intent folders (`intents/<id>/{intent,spec,plan}.md`) from their text. Pure: no
files, no Git, no host. It follows agent-os's own parser
(`quality-ratchet/scripts/intent-files.mjs`), so wow and agent-os read a plan the same way.

- `readIntent({id, intent?, spec?, plan?})` answers title, status, revision, whether the spec and
  plan are stale, the plan's units (key, title, dependencies, blocked note, contract fields) and
  the problems found, each with its file and line. It never throws.
- `fileStatus(unit)` is what the files alone say about a unit: `blocked` or `unknown`.
- `parseFrontmatter`, `parseUnits`, `unitContracts`, `parseRev`, `parseBuiltOn` are the parts.
