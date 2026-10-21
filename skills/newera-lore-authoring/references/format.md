# Theater world format

The authoritative contract and examples are in [docs/LORE_JSON_GUIDE.md](../../../docs/LORE_JSON_GUIDE.md). Runtime validation is implemented in `src/lib/theater/validation.ts`.

Author `newera-theater-source` version 2 with `definition`. Build it into `newera-theater` version 2 with `world.definition`, `world.state`, and `saves`.

Hierarchy: world → scenes → character/object instances. Reusable templates own descriptions, personality/goals, initial state, interactions and object reactions. Instances own identity, current scene, state, companion status and witnessed memories. Explicit exits constrain scene transitions. Companions follow while retaining identity.

State values are strings, finite numbers, booleans or null. Interaction conditions compare exact property values and declared effects modify the target. Object reactions inspect events in their own scene. Autonomous character decisions are made at runtime by OEV; do not bake their future choices into generated events.

The example source in `../assets/example-source.json` contains multiple scenes, independent objects of one template, local characters and a companion.
