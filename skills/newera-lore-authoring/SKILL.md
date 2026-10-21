---
name: newera-lore-authoring
description: Create, revise, build, and validate importable newera theater worlds with scenes, character and object templates, instances, companions, conditional interactions and event reactions.
---

# newera world authoring

Create a world that can be imported from newera's `/lores` page. Preserve the user's setting, characters, relationships and intended scene dynamics.

## Workflow

1. Read [references/format.md](references/format.md) and the authoritative [world JSON guide](../../docs/LORE_JSON_GUIDE.md).
2. Copy [assets/example-source.json](assets/example-source.json). Write `newera-theater-source` version 2 with a `definition` object.
3. Define the largest world setting, then scenes and directed exits. Decide which instances actually inhabit each scene.
4. Define reusable character/object templates. Put personality and personal goals on characters, and conditional interactions and event reactions on objects. Give each instance its own ID and state. A companion must be a character initially in the starting scene.
5. Use general state properties meaningful to the story. Do not add a fixed numerical relationship or command simulation. Do not invent prior events: place backstory in descriptions, personality and goals.
6. Build and validate:

   ```console
   node skills/newera-lore-authoring/scripts/build-lore.mjs source.json world.json
   node skills/newera-lore-authoring/scripts/validate-lore.mjs world.json
   ```

7. Report the output path, world name, scenes, cast/objects, companions and validation result.

## Existing worlds

An exported `newera-theater` file contains `world.definition`, current `world.state`, and `saves`. Preserve instance IDs, current locations, state, witnessed memories, events and save slots unless the user asks to change them. Editing initial spawns does not move current instances. Validate after editing.

Older source files can be converted by the build script. Older exported stories are converted by the application's importer. Keep compatibility code isolated in `legacy-format.mjs`; create new content in the current format.
