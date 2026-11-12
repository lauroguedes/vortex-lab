# Graph Report - twistter-simulation  (2026-11-12)

## Corpus Check
- 34 files · ~43,893 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 430 nodes · 796 edges · 17 communities (16 shown, 1 thin omitted)
- Extraction: 97% EXTRACTED · 3% INFERRED · 0% AMBIGUOUS · INFERRED: 27 edges (avg confidence: 0.5)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- main.ts
- UI
- Tornado
- props.ts
- debris.ts
- city.ts
- package.json
- fetch-cities.mjs
- compilerOptions
- Twistter — Tornado Simulation Lab
- shapes.ts
- generate-sounds.mjs
- StormAudio
- DebrisSystem
- Street
- manifest.json

## God Nodes (most connected - your core abstractions)
1. `Tornado` - 29 edges
2. `UI` - 23 edges
3. `City` - 20 edges
4. `DebrisField` - 14 edges
5. `buildCity()` - 12 edges
6. `DebrisSystem` - 11 edges
7. `Street` - 11 edges
8. `compilerOptions` - 11 edges
9. `StormAudio` - 10 edges
10. `Minimap` - 10 edges

## Surprising Connections (you probably didn't know these)
- `reset()` --calls--> `placeVehicles()`  [EXTRACTED]
  src/main.ts → src/world/props.ts
- `reset()` --calls--> `placeYardObjects()`  [EXTRACTED]
  src/main.ts → src/world/props.ts
- `TornadoConfig` --inherits--> `TornadoPreset`  [EXTRACTED]
  src/physics/tornado.ts → src/data/presets.ts
- `buildConfig()` --references--> `PRESETS`  [EXTRACTED]
  src/main.ts → src/data/presets.ts
- `applyEnvironment()` --calls--> `applyLighting()`  [EXTRACTED]
  src/main.ts → src/render/environment.ts

## Import Cycles
- None detected.

## Communities (17 total, 1 thin omitted)

### Community 0 - "main.ts"
Cohesion: 0.05
Nodes (52): PRESETS, adaptResolution(), advance(), applyEnvironment(), applyQuality(), audio, bolt, bufferSize (+44 more)

### Community 1 - "UI"
Cohesion: 0.09
Nodes (12): efRating(), CameraMode, ChangeKind, COMPASS, ICONS, kmh(), mph(), seg() (+4 more)

### Community 2 - "Tornado"
Cohesion: 0.09
Nodes (14): EF_BOUNDS, EF_COLORS, TornadoPreset, GRAV, lut(), LUT_N, LUT_RMAX, MAX_SUB (+6 more)

### Community 3 - "props.ts"
Cohesion: 0.06
Nodes (24): CONTENTS, DamageEvent, DamageModel, DamageStats, FITTINGS, LADDER, Step, w3 (+16 more)

### Community 4 - "debris.ts"
Cohesion: 0.05
Nodes (32): debrisMaterial(), ImpactKind, PAINT, ROLL, shadowAssets(), SIN, Spec, SPECS (+24 more)

### Community 5 - "city.ts"
Cohesion: 0.11
Nodes (11): Minimap, City, CityTile, GROUND_SCALE, mulberry32(), PARAPET, rnd2(), ROOFS (+3 more)

### Community 6 - "package.json"
Cohesion: 0.09
Nodes (21): dependencies, three, devDependencies, @types/three, typescript, vite, name, private (+13 more)

### Community 7 - "fetch-cities.mjs"
Cohesion: 0.18
Nodes (19): assembleRings(), buildCity(), cities, classify(), cleanRing(), D(), ENDPOINTS, guessHeight() (+11 more)

### Community 8 - "compilerOptions"
Cohesion: 0.11
Nodes (17): DOM, DOM.Iterable, ES2022, src, vite/client, compilerOptions, isolatedModules, lib (+9 more)

### Community 9 - "Twistter — Tornado Simulation Lab"
Cohesion: 0.25
Nodes (7): Adding a city, Controls, Limits of the model, Sound, Stack, Twistter — Tornado Simulation Lab, What is simulated

### Community 11 - "shapes.ts"
Cohesion: 0.13
Nodes (36): bathtub(), bed(), bin(), bus(), c3, cabinet(), car(), CarSpec (+28 more)

### Community 12 - "generate-sounds.mjs"
Cohesion: 0.13
Nodes (15): args, dry, env, fileOf(), force, generate(), groups, jobs (+7 more)

### Community 13 - "StormAudio"
Cohesion: 0.20
Nodes (8): AudioState, COOLDOWN, Loop, LOOPS, LoopVoice, OneShot, seamless(), StormAudio

### Community 14 - "DebrisSystem"
Cohesion: 0.33
Nodes (3): DebrisSystem, fcos(), fsin()

### Community 16 - "manifest.json"
Cohesion: 0.40
Nodes (4): groups, loopModel, oneShotModel, source

## Knowledge Gaps
- **144 isolated node(s):** `name`, `private`, `version`, `type`, `dev` (+139 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **1 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Tornado` connect `Tornado` to `main.ts`, `props.ts`, `debris.ts`, `city.ts`, `DebrisSystem`, `Street`?**
  _High betweenness centrality (0.074) - this node is a cross-community bridge._
- **Why does `UI` connect `UI` to `main.ts`?**
  _High betweenness centrality (0.070) - this node is a cross-community bridge._
- **Why does `City` connect `city.ts` to `main.ts`, `Tornado`, `props.ts`, `debris.ts`, `Street`?**
  _High betweenness centrality (0.042) - this node is a cross-community bridge._
- **What connects `name`, `private`, `version` to the rest of the system?**
  _144 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `main.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.05323653962492438 - nodes in this community are weakly interconnected._
- **Should `UI` be split into smaller, more focused modules?**
  _Cohesion score 0.09390243902439024 - nodes in this community are weakly interconnected._
- **Should `Tornado` be split into smaller, more focused modules?**
  _Cohesion score 0.09206349206349207 - nodes in this community are weakly interconnected._