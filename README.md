# Vortex Lab — Tornado Simulator

A real-time 3D tornado simulator that runs in the browser. Pick a real city, a tornado
type and the atmospheric conditions, then watch the storm cross the map and survey the damage.

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # type-check + production bundle in dist/
```

## Stack

- **Three.js** (WebGL2) + **TypeScript** + **Vite** — no other runtime dependencies.
- Custom render pipeline: HDR scene pass → ray-marched volumetric pass (funnel, wall cloud,
  dust) at reduced resolution → screen-space ambient occlusion → bloom → ACES tone-mapped composite.
- Physics runs on the CPU in typed arrays (fixed sub-steps), rendering is GPU-instanced.
- WebAudio mix driven by the physics. Sound effects are generated with ElevenLabs (see *Sound*);
  without them the engine falls back to synthesised wind and thunder.

## What is simulated

Everything is in SI units at 1:1 scale (1 world unit = 1 metre).

| Part | Model |
| --- | --- |
| **Cities** | New York (Midtown), London (the City), Paris (Louvre – Île de la Cité), Rome (Centro Storico), Tokyo (Shinjuku) and Rio de Janeiro (Centro). Real building footprints, heights, roads, water and parks from OpenStreetMap, 2.4 × 2.4 km tiles (`public/cities/*.json`), each with its own materials: limestone and zinc, ochre and terracotta, stock brick and slate… |
| **Traffic** | The mapped streets form a graph; several hundred vehicles follow it lane by lane with the Intelligent Driver Model, slow for turns and take junctions one at a time (keeping left in London and Tokyo). Drivers speed away from the storm, crawl in strong wind and stop when it is undriveable; once the wind can move a vehicle the debris physics takes it over. Police, ambulances and fire engines are dispatched as damage is reported and head for it with lights flashing. `src/world/traffic.ts` |
| **Wind field** | Smoothed modified-Rankine tangential profile (solid-body core, `r^-α` decay, far-field taper), boundary-layer inflow, one-/two-cell corner-flow updraft, translation, optional orbiting sub-vortices. `src/physics/tornado.ts` |
| **Pressure** | Cyclostrophic balance `∂p/∂r = ρV²/r`, integrated numerically from the wind profile. |
| **Funnel** | Not a mesh: the shader condenses cloud wherever the pressure drop exceeds the hydrostatic difference to the cloud base (`y + Δp/ρg > LCL`). Width, taper and whether the funnel touches down follow from wind speed, core size and cloud-base height. `src/render/pipeline.ts` |
| **Damage** | Enhanced Fujita Damage Indicators / Degrees of Damage for houses (FR12), low-, mid- and high-rise buildings, metal buildings and hardwood trees. Each structure tracks its peak gust and steps through the DOD ladder; the final rating comes from the worst damage found, like a real survey. `src/physics/damage.ts` |
| **Debris** | Each piece has a ballistic coefficient `b = ρ·Cd·A / 2m` and is integrated with quadratic drag, gravity, near-ground lift and turbulence. Small pieces: shingles, plywood, 2×4 lumber, masonry, sheet metal, glass, doors, wall and roof panels. `src/physics/debris.ts` |
| **Objects** | The same physics moves whole objects, each with its own mass and drag area: cars, SUVs, pickups, box trucks, buses, semi-trailers and emergency vehicles (tumbling vehicles are bluff bodies with autorotation lift: a violent vortex tosses them tens of metres, a weak one only rolls them); sofas, beds, refrigerators, washers, tables, chairs, bathtubs and cabinets thrown from collapsing houses; gable roof sections that lift off in one piece and break up on landing; rooftop air handlers, wheelie bins, dumpsters, trampolines, sheds, shipping containers, back-yard fences, street signs, tyres and the crowns of snapped trees. Models are in `src/world/shapes.ts`. |
| **Streets** | Timber utility poles with overhead lines and steel street lights along the mapped roads. Poles lean and break at the EF-scale wind speeds for DI 24 / DI 26, bringing their spans down with a power flash; lights go out when the power fails. `src/world/street.ts` |
| **Buildings** | Pitched roofs with eaves, brick or lap siding, doors and garages on houses; shopfronts, parapets, rooftop plant and penthouses on commercial buildings; reflective curtain walls on towers. When a roof is lost you look down into the rooms (interior mapping). `src/world/city.ts` |
| **First person** | "Caught in it" (key **5**) puts the camera at the eyes of someone standing where the core will pass. The body is a 75 kg adult in the same drag physics as everything else: blown off their feet when drag beats friction (about 30 m/s, 110 km/h), then rolled, dragged or thrown as the wind dictates, with autorotation lift, bouncing off the ground, sliding along building walls and landing on roofs. The readout shows speed, height, wind and g-load; vision tunnels under load and blacks out briefly on impact. Weak tornadoes drag the body tens of metres; violent ones throw it into the air. `src/world/victim.ts` |
| **Hemisphere** | Cyclonic rotation: counter-clockwise in the north, clockwise in the south. |

## Controls

- **Mouse**: drag to orbit, right-drag to pan, wheel to zoom.
- **Space** run / pause · **R** reset · **1–5** camera modes (5 = first person) · **H** hide interface · **M** sound.
- Click the survey map during setup to aim the track.

## Sound

The audio engine (`src/audio/sound.ts`) mixes looping layers (distant and close tornado roar,
wind, rain, debris, warning siren), the moving sirens of the nearest police car, ambulance and
fire engine, and positioned one-shots (thunder, structural collapse, glass, sheet metal, vehicle
impacts, car horns, transformer arcs, falling trees). Each one-shot is delayed
by its travel time at 343 m/s, panned, and dulled with distance.

The clips are generated with the [ElevenLabs sound-effects API](https://elevenlabs.io/docs/api-reference/text-to-sound-effects/convert):

```bash
echo 'ELEVEN_LABS_API_KEY=sk_...' > .env    # the secret key, not the key ID
npm run generate-sounds                     # writes public/audio/*.mp3 + manifest.json
```

About 300 s of audio in 31 clips. The script skips clips that already exist (`--force`
regenerates, `--only=siren,glass` limits it, `--dry` lists the work). One-shots use
`eleven_text_to_sound_v3`; loops use `eleven_text_to_sound_v2`, the only sound-effects model
that loops seamlessly. The key is read at build time only and never reaches the browser.

Sound switches on with the first run; **M** or the toolbar button toggles it.

## Adding a city

Add an entry to `src/data/cities.json` (id, name, latitude/longitude of the tile centre; optionally
`style` for the material palette, `levels` for the storeys assumed where OpenStreetMap has no
height, `urban` for paved rather than grassed open ground, `pitched` for roofs on city blocks and
`left` for left-hand traffic) and run

```bash
npm run fetch-cities -- <id>
```

which downloads the tile from the Overpass API. Set `"infill": true` for places where
OpenStreetMap has streets but few mapped buildings.

## Limits of the model

This is a kinematic (prescribed) vortex, not a CFD solution: the wind field does not react
to buildings or terrain, terrain is flat (Rio's hills included), and neither debris nor traffic
collides with structures. Traffic ignores one-way streets and signals.
Damage thresholds are the EF-scale *expected* values with ±15 % random construction quality.
It is an educational visualisation, not a forecasting or engineering tool.

Map data © OpenStreetMap contributors (ODbL).
