# ClockWorld Modding SDK

ClockWorld is moddable from inside the game — no build step. Open the menu →
**Mods & Texture Packs**, paste or import a mod, then **Apply & Reload**.

A mod is plain JavaScript that runs once at startup with a global `ClockWorld`
object. Mods load *before* the texture atlas is built, so blocks/items you
define get tiles automatically.

```js
// A simple mod
ClockWorld.log("Hello from my mod!");

const ruby = ClockWorld.defineItem({ name: "Ruby", color: "#e0115f", food: 0 });
const rubyBlock = ClockWorld.defineBlock({ name: "Ruby Block", color: "#e0115f", hardness: 4 });

// 9 rubies -> 1 ruby block, and back (1 block -> 9 rubies)
ClockWorld.addRecipe({ rows: ["RRR", "RRR", "RRR"], key: { R: ruby }, result: rubyBlock });
ClockWorld.addRecipe({ shapeless: [rubyBlock], result: ruby, count: 9 });

// Smelt cobblestone straight into ruby (just because)
ClockWorld.addSmelting(ClockWorld.ID.COBBLE, ruby);

// React to gameplay
ClockWorld.on("blockBreak", (e) => {
  if (e.id === ClockWorld.ID.DIAMOND_ORE) ClockWorld.log("nice find at", e.x, e.y, e.z);
});
```

## API

### Content
- `ClockWorld.defineBlock(spec) -> id`
  - `name` — display name
  - `color` — `"#rrggbb"` base colour, **or** `pixels` — array of 256 hex
    strings (16×16, row-major) for a custom tile
  - `hardness` — seconds to mine (default 1)
  - `solid` (default true), `opaque` (default true)
  - `drop` — item id dropped when broken (default: the block itself)
  - `interact` — `"chest" | "craft" | "furnace" | "door"` (optional)
  - `creative` — set `false` to keep it out of the creative palette
- `ClockWorld.defineItem(spec) -> id`
  - `name`, `color`/`pixels`, `stack` (default 64)
  - `food` (hunger restored), `sat` (saturation), `heal` (HP)
  - `fuel` — burn seconds when used as furnace fuel
  - `smeltFrom` — id that smelts into this item
- `ClockWorld.addRecipe(recipe)`
  - Shaped: `{ rows: ["RR","RR"], key: { R: id }, result: id, count?: 1 }`
  - Shapeless: `{ shapeless: [id, id, ...], result: id, count?: 1 }`
- `ClockWorld.addSmelting(inputId, outputId)`
- `ClockWorld.setTexturePack(map)` — `{ tileName: "#rrggbb" | { pixels:[256] } }`

### World access
Available once a world is running (no-ops in the menu):
- `ClockWorld.setBlock(x, y, z, id)` — edit the world; routes through the same
  path as a player edit, so multiplayer sync and the water simulation both
  react (place `ClockWorld.ID.WATER` and it flows).
- `ClockWorld.getBlock(x, y, z) -> id`
- `ClockWorld.getTime() -> t` / `ClockWorld.setTime(t)` — day cycle, `0..1`
  (0.25 = noon, 0.75 = midnight).
- `ClockWorld.playerPos() -> [x, y, z]`
- `ClockWorld.teleport(x, y, z)`

### Events — `ClockWorld.on(event, callback)`
| Event | Data |
| --- | --- |
| `worldStart` | `{ mode, seed, online }` |
| `blockPlace` | `{ x, y, z, id }` |
| `blockBreak` | `{ x, y, z, id }` |
| `eat` | `{ id }` |
| `tick` | `{ dt }` (each frame while playing) |

### Reference
`ClockWorld.ID` (block ids), `ClockWorld.ITEM` (item ids), and the raw
`ClockWorld.Blocks` / `ClockWorld.Items` / `ClockWorld.Recipes` registries are
exposed for advanced use.

## Texture packs

A texture pack is JSON that recolours existing tiles — no images needed:

```json
{
  "name": "Sunset",
  "tiles": {
    "grass_top": "#c98a3c",
    "grass_side": "#a86a2c",
    "stone": "#caa0a0",
    "water": "#ff9f6b"
  }
}
```

Tile names: `grass_top, grass_side, dirt, stone, cobblestone, log_top, log_side,
leaves, sand, water, planks, glass, brick, bedrock, snow, gravel, coal_ore,
iron_ore, gold_ore, diamond_ore, chest, craft_top, craft_side, furnace_front,
furnace_lit, furnace_side, furnace_top, door, door_open`.

Each value is a base colour `"#rrggbb"` (the tile is shaded from it) or
`{ "pixels": [ ...256 hex strings... ] }` for pixel-perfect art. Import it under
**Mods & Texture Packs → Import Pack**, or apply it from a mod with
`ClockWorld.setTexturePack({...})`.

## Notes
- Mods run with full page privileges (it's your browser) — only install mods you
  trust.
- Multiplayer: modded recipes/among clients work if everyone installs the same
  mod; the server syncs block ids, not mod code.
