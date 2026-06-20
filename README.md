# ClockWorld 🌍⛏️

A **Minecraft-style voxel sandbox** that runs in the browser — built from scratch
with **raw WebGL and vanilla JavaScript**. No engine, no frameworks, no build
step, **zero dependencies**, no external image assets. Every texture is generated
procedurally at runtime and the whole world is yours to dig, build, and explore.
Choose **Survival** or **Creative**, and keep as many separate worlds as you like.

> A literal 1:1 copy of Minecraft is a decade of work by a large studio, so this
> isn't that. It *is* a genuine, playable implementation of the core Minecraft
> loop — infinite procedural worlds, two game modes, an inventory, and saves.

## Play

**Option A — just open it:** open `index.html` in a modern browser.

**Option B — local server (recommended):**

```bash
node serve.js          # then open http://localhost:8080
# or
npm run serve
```

From the **world menu**, create a world (pick a name, optional seed, and a mode)
or load an existing one, then click **Play** to lock the mouse and start.

## Game modes

- **Survival** — health (10 hearts), fall damage, drowning, and the void are all
  lethal. Blocks take time to mine based on hardness and drop into your
  **inventory**; placing consumes from your selected stack. No flying.
- **Creative** — fly freely, instant-break anything (even bedrock), infinite
  blocks from the creative palette, and no damage.

Switch modes anytime from the pause menu.

## Controls

| Input | Action |
| --- | --- |
| **Mouse** | Look around |
| **W A S D** | Move |
| **Space** | Jump · swim up · fly up |
| **Shift** | Sneak · fly down |
| **Ctrl** / double-tap **W** | Sprint |
| **Left click** | Mine (hold; survival respects hardness) |
| **Right click** | Place block |
| **Middle click** | Pick block (creative) |
| **E** | Open / close inventory |
| **1–9** / **Mouse wheel** | Select hotbar slot |
| **F** | Toggle fly (creative) |
| **T** | Freeze the day/night cycle |
| **Esc** | Pause |

In the inventory, **click** picks up / drops a stack, **right-click** takes or
places one. In the creative inventory, click a palette block to bind it to your
selected hotbar slot.

## Features

- **Two game modes** — Survival (health, hazards, mining, inventory) and Creative
  (fly, infinite blocks), switchable mid-game.
- **Infinite procedural terrain** from seeded Perlin/fBm noise — rolling hills,
  beaches, oceans, snow-capped peaks, caves, ore veins, and trees.
- **Chunk-based world** (16×16×128) streamed in and out as you move, with
  hidden-face culling, per-vertex **ambient occlusion**, and directional shading.
- **Mining & building** with per-block hardness, drops, and a 36-slot stacking
  inventory (9-slot hotbar + creative palette).
- **Survival mechanics** — hearts, fall damage, drowning with an air meter, a
  damage flash, death + respawn.
- **Full physics**: gravity, jumping, swept AABB collision, swimming, free-fly.
- **Procedural pixel-art textures** drawn to a canvas atlas — grass, dirt, stone,
  wood, leaves, sand, water, glass, bricks, ores, and more.
- **Day/night cycle** with a moving sun, sky-colour shifts, and distance fog.
- **Multiple named worlds** saved to `localStorage` (seed, mode, every edit,
  inventory, and player state), with **export/import** to a `.json` file.

## Project layout

```
index.html        # markup + UI overlay, loads the scripts in order
css/style.css     # HUD, hotbar, crosshair, menu styling
js/math.js        # vec3 / mat4 (perspective, lookAt, multiply)
js/noise.js       # seeded Perlin noise + fBm + hash
js/blocks.js      # block registry: tiles, hardness, drops, stacks
js/inventory.js   # stack-based inventory model
js/saves.js       # multi-world registry + export/import
js/textures.js    # procedural texture-atlas painter
js/world.js       # chunks, terrain gen, meshing, raycasting
js/renderer.js    # WebGL program, chunk buffers, draw passes
js/player.js      # controller: look, movement, physics, health, modes
js/main.js        # bootstrap: UI, modes, mining, streaming, loop, saves
serve.js          # tiny static server for local play
tests/            # Node unit + headless smoke tests
```

## Tests

The dependency-free logic (matrix math, noise, terrain, meshing, raycasting,
physics) is unit-tested, and a headless harness stubs the DOM/WebGL to run the
real game through `init()` and many frames of locked gameplay.

```bash
npm test
# or
node tests/test.js && node tests/smoke.js
```

## How it works (short version)

The world is a sparse map of chunks. Each chunk is generated lazily: a noise
heightmap lays down stone/dirt/grass/sand/snow, caves are carved with 3D noise,
ore veins and trees are stamped deterministically (so they're consistent across
chunk borders), and any saved player edits are re-applied. A chunk is meshed by
emitting only the block faces that touch a non-opaque neighbour, baking
ambient-occlusion and a fake-sun shade into each vertex. The renderer draws all
opaque geometry (with alpha-testing for leaf/glass cutouts) then water in a
blended pass, with distance fog hiding the streaming edge. The player is an AABB
resolved one axis at a time against the voxels each frame.

## License

GPL-2.0 (see `LICENSE`).
