# ClockWorld 🌍⛏️

A **Minecraft-style voxel sandbox** that runs in the browser — built from scratch
with **raw WebGL and vanilla JavaScript**. No engine, no frameworks, no build
step, **zero dependencies**, no external image assets. Every texture is generated
procedurally at runtime and the whole world is yours to dig, build, and explore.

> A literal 1:1 copy of Minecraft is a decade of work by a large studio, so this
> isn't that. It *is* a genuine, playable implementation of the core Minecraft
> loop — an infinite procedural voxel world you can mine and build in.

## Play

**Option A — just open it:** open `index.html` in a modern browser.

**Option B — local server (recommended):**

```bash
node serve.js          # then open http://localhost:8080
# or
npm run serve
```

Click **Play** to lock the mouse and start. Press **Esc** to pause.

## Controls

| Input | Action |
| --- | --- |
| **Mouse** | Look around |
| **W A S D** | Move |
| **Space** | Jump · swim up · fly up |
| **Shift** | Sneak · fly down |
| **Ctrl** / double-tap **W** | Sprint |
| **Left click** | Break block (hold to keep mining) |
| **Right click** | Place block (hold to keep placing) |
| **Middle click** | Pick the block you're looking at |
| **1–9** / **Mouse wheel** | Select hotbar slot |
| **F** | Toggle fly / creative mode |
| **T** | Freeze the day/night cycle |
| **Esc** | Pause (release mouse) |

## Features

- **Infinite procedural terrain** from seeded Perlin/fBm noise — rolling hills,
  beaches, oceans, snow-capped peaks, caves, ore veins, and trees.
- **Chunk-based world** (16×16×128) streamed in and out as you move.
- **Efficient meshing**: hidden faces are culled and each chunk is a single mesh,
  with per-vertex **ambient occlusion** and directional face shading.
- **Full physics**: gravity, jumping, swept AABB collision, swimming, and a
  free-fly creative mode.
- **Build & mine** any of 18 block types via voxel raycasting, with a live
  wireframe highlight on the targeted block.
- **Procedural pixel-art textures** drawn to a canvas atlas — grass, dirt, stone,
  wood, leaves, sand, water, glass, bricks, ores, and more.
- **Day/night cycle** with a moving sun, sky-colour shifts, and distance fog.
- **Your world is saved** automatically to `localStorage` (seed + every edit).

## Project layout

```
index.html        # markup + UI overlay, loads the scripts in order
css/style.css     # HUD, hotbar, crosshair, menu styling
js/math.js        # vec3 / mat4 (perspective, lookAt, multiply)
js/noise.js       # seeded Perlin noise + fBm + hash
js/blocks.js      # block registry & atlas tile layout
js/textures.js    # procedural texture-atlas painter
js/world.js       # chunks, terrain gen, meshing, raycasting
js/renderer.js    # WebGL program, chunk buffers, draw passes
js/player.js      # controller: look, movement, physics, collision
js/main.js        # bootstrap: streaming, input, loop, day/night, save
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
