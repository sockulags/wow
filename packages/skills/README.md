# @wow/skills

Discovers installed skills from `SKILL.md` files.

- `skillRoots(directories, {userHome, projectDirs})` expands the `skills.directories` setting.
- `claudePluginRoots(claudeDir)` finds the skill folders of installed Claude plugins.
- `scanSkills(roots)` reads `<root>/<skill>/SKILL.md` frontmatter and `agents/openai.yaml` into
  `Skill` rows with Claude and Codex invocation forms.
- `watchSkillRoots(roots, onChange)` watches the folders with chokidar.

The fixture tree in `fixtures/` stores `.claude`, `.codex` and `.agents` as `dot-claude` and so on,
so agents working in this repository do not load the invented skills; the tests restore the dots
in a temporary copy.
