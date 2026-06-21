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
| **Right click** | Place block · use chest/table/furnace/door · hold to eat food |
| **Middle click** | Pick block (creative) |
| **E** | Open / close inventory |
| **1–9** / **Mouse wheel** | Select hotbar slot |
| **F** | Toggle fly (creative) |
| **T** | Freeze the day/night cycle |
| **Enter** | Chat (multiplayer) |
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
- **Crafting** — shaped & shapeless recipes via a 2×2 inventory grid and a 3×3
  crafting table (planks, sticks, table, chest, furnace, door, bread, …).
- **Interactable blocks** — **chests** (27-slot storage), a **furnace** that
  smelts ore→ingots / sand→glass / log→charcoal using fuel, a **crafting table**,
  and **doors** you open/close.
- **Food & hunger** — a hunger bar with saturation, eating (apples from trees,
  bread from wheat, golden apples), natural regen, and starvation.
- **Survival mechanics** — hearts, fall damage, drowning with an air meter, a
  damage flash, death + respawn.
- **Multiplayer** — host a shared world with the built-in server and build,
  explore, and chat together; other players appear as avatars.
- **Modding SDK & texture packs** — add blocks, items, recipes, smelting, and
  event hooks from in-game JavaScript via a `ClockWorld` API, and reskin tiles
  with JSON texture packs. See **[MODDING.md](MODDING.md)**.
- **Full physics**: gravity, jumping, swept AABB collision, swimming with
  auto-step so you can climb out of water, and free-fly.
- **Procedural pixel-art textures** drawn to a canvas atlas, **day/night cycle**,
  and distance fog.
- **Multiple named worlds** saved to `localStorage` (seed, mode, every edit,
  inventory, containers, and player state), with **export/import** to a `.json` file.

## Multiplayer / hosting

The repo ships a **zero-dependency** game server (a from-scratch WebSocket
implementation over Node's `http`/`crypto`). It serves the game *and* hosts a
shared world on the same port:

```bash
node server/server.js            # http://localhost:8080  (also npm run host)
PORT=3000 CW_MODE=creative node server/server.js
```

Then open the URL to play, or from another machine open the menu's **Multiplayer**
box and connect to `ws://<host>:<port>`. The server is authoritative for the
world seed and every block edit, relays player movement and chat, and saves the
world to `server/world.json`.

## Project layout

```
index.html        # markup + UI overlay, loads the scripts in order
css/style.css     # HUD, hotbar, crosshair, menu styling
js/math.js        # vec3 / mat4 (perspective, lookAt, multiply)
js/noise.js       # seeded Perlin noise + fBm + hash
js/blocks.js      # block registry: tiles, hardness, drops, stacks, interact
js/items.js       # items (blocks + materials/food), fuel, smelting, icons
js/recipes.js     # crafting recipe matcher (shaped + shapeless)
js/furnace.js     # furnace smelting state machine
js/mods.js        # modding SDK (ClockWorld API + event hooks)
js/inventory.js   # stack-based inventory model
js/saves.js       # multi-world registry + export/import
js/textures.js    # procedural texture-atlas painter
js/world.js       # chunks, terrain gen, meshing, raycasting
js/renderer.js    # WebGL program, chunk buffers, draw passes, avatars
js/player.js      # controller: look, movement, physics, health, hunger, modes
js/net.js         # multiplayer client (WebSocket)
js/main.js        # bootstrap: UI, modes, crafting, containers, loop, net
serve.js          # tiny static server for local play
server/ws.js      # from-scratch WebSocket (RFC 6455) server
server/server.js  # multiplayer host: static files + shared world
tests/            # Node unit, headless smoke, and live server tests
```

## Tests

The dependency-free logic (matrix math, noise, terrain, meshing, raycasting,
physics, inventory, recipes, furnace, hunger) is unit-tested; a headless harness
stubs the DOM/WebGL to run the real game through `init()` and a full session
(survival, crafting, chest/furnace/table/doors, multiplayer client); and a third
test boots the real server and connects two live WebSocket clients.

```bash
npm test
# or
node tests/test.js && node tests/smoke.js && node tests/server.test.js
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
