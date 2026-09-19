---
name: newera-lore-authoring
description: Create, revise, build, and validate importable lore JSON files for the newera adult text game. Use when a user provides a world or adult character concept and wants a ready-to-import newera lore, preset, or lore JSON correction.
---

# newera lore authoring

Create a lore that can be imported from newera's `/lores` page. Preserve the user's premise, character intent, relationship setup, and requested prose mode.

## New lore workflow

1. Read [references/format.md](references/format.md).
2. Copy [assets/example-source.json](assets/example-source.json) to the requested workspace and replace the example content. Write the easier `newera-lore-source` format; do not hand-escape `character_json`.
3. Preserve each character's stated age without applying a minimum. Give each character an ID that matches `^[a-z0-9][a-z0-9._-]*$`.
4. Keep persistent `TALENT`, `ABL`, `EXP`, `MARK`, and `RELATION` distinct from current-scene `PALAM`. Set numbers from the stated starting relationship instead of reflexively using zero.
5. Express gated behavior with `actionRequirements`. A missing requirement means that stat does not gate that action.
6. Build and validate with the scripts in this skill directory:

   ```bash
   node scripts/build-lore.mjs path/to/source.json path/to/importable-lore.json
   node scripts/validate-lore.mjs path/to/importable-lore.json
   ```

7. Report the resulting file path, title, prose mode, cast, and validation result.

## Existing lore workflow

An exported `newera-lore` file contains current play state and save slots. Preserve `events`, `memories`, `saves`, and runtime character values unless the user explicitly asks to rewrite progression. For structural questions, read the full-bundle section in [references/format.md](references/format.md), then run `validate-lore.mjs` after editing.

## Boundaries

- `newera-lore-source` is an authoring format consumed by `build-lore.mjs`; the game imports the generated `newera-lore` file.
- Use a module only when the user wants content installed into an existing lore. Full lore presets use `newera-lore`.
- Prose mode changes narration style. It does not remove action requirements or determine character acceptance.
- Do not invent prior events. Put established backstory in `world.memory`, profiles, relations, experience, and marks. Leave generated starter lore events and memories empty.
