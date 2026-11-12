# Graph Report - twistter-simulation  (2026-11-12)

## Corpus Check
- 30 files · ~26,835 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 295 nodes · 527 edges · 11 communities
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 5 edges (avg confidence: 0.5)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- main.ts
- ui.ts
- Tornado
- debris.ts
- props.ts
- City
- package.json
- fetch-cities.mjs
- compilerOptions
- Twistter — Tornado Simulation Lab

## God Nodes (most connected - your core abstractions)
1. `Tornado` - 26 edges
2. `UI` - 22 edges
3. `City` - 17 edges
4. `DebrisSystem` - 14 edges
5. `buildCity()` - 12 edges
6. `compilerOptions` - 11 edges
7. `Minimap` - 10 edges
8. `DamageModel` - 9 edges
9. `switchCity()` - 8 edges
10. `reset()` - 8 edges

## Surprising Connections (you probably didn't know these)
- `switchCity()` --calls--> `loadCity()`  [EXTRACTED]
  src/main.ts → src/world/city.ts
- `TornadoConfig` --inherits--> `TornadoPreset`  [EXTRACTED]
  src/physics/tornado.ts → src/data/presets.ts
- `buildConfig()` --references--> `PRESETS`  [EXTRACTED]
  src/main.ts → src/data/presets.ts
- `applyEnvironment()` --calls--> `applyLighting()`  [EXTRACTED]
  src/main.ts → src/render/environment.ts
- `applyEnvironment()` --references--> `LIGHTING`  [EXTRACTED]
  src/main.ts → src/render/environment.ts

## Import Cycles
- None detected.

## Communities (11 total, 0 thin omitted)

### Community 0 - "main.ts"
Cohesion: 0.05
Nodes (52): StormAudio, PRESETS, adaptResolution(), advance(), applyEnvironment(), applyQuality(), audio, buildConfig() (+44 more)

### Community 1 - "ui.ts"
Cohesion: 0.10
Nodes (12): efRating(), CameraMode, ChangeKind, COMPASS, ICONS, kmh(), mph(), seg() (+4 more)

### Community 2 - "Tornado"
Cohesion: 0.09
Nodes (14): EF_BOUNDS, EF_COLORS, TornadoPreset, GRAV, lut(), LUT_N, LUT_RMAX, MAX_SUB (+6 more)

### Community 3 - "debris.ts"
Cohesion: 0.09
Nodes (17): DamageModel, DamageStats, LADDER, Step, w3, DebrisSystem, DebrisType, fcos() (+9 more)

### Community 4 - "props.ts"
Cohesion: 0.08
Nodes (20): env, LIGHT_GLSL, LightingPreset, VORTEX_GLSL, CityTile, GROUND_SCALE, loadCity(), ROOFS (+12 more)

### Community 5 - "City"
Cohesion: 0.12
Nodes (5): Minimap, City, mulberry32(), rnd2(), Trees

### Community 6 - "package.json"
Cohesion: 0.10
Nodes (20): dependencies, three, devDependencies, @types/three, typescript, vite, name, private (+12 more)

### Community 7 - "fetch-cities.mjs"
Cohesion: 0.18
Nodes (19): assembleRings(), buildCity(), cities, classify(), cleanRing(), D(), ENDPOINTS, guessHeight() (+11 more)

### Community 8 - "compilerOptions"
Cohesion: 0.11
Nodes (17): DOM, DOM.Iterable, ES2022, src, vite/client, compilerOptions, isolatedModules, lib (+9 more)

### Community 9 - "Twistter — Tornado Simulation Lab"
Cohesion: 0.29
Nodes (6): Adding a city, Controls, Limits of the model, Stack, Twistter — Tornado Simulation Lab, What is simulated

## Knowledge Gaps
- **93 isolated node(s):** `name`, `private`, `version`, `type`, `dev` (+88 more)
  These have ≤1 connection - possible missing edges or undocumented components.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `UI` connect `ui.ts` to `main.ts`?**
  _High betweenness centrality (0.092) - this node is a cross-community bridge._
- **Why does `Tornado` connect `Tornado` to `main.ts`, `debris.ts`, `props.ts`, `City`?**
  _High betweenness centrality (0.084) - this node is a cross-community bridge._
- **Why does `City` connect `City` to `main.ts`, `Tornado`, `debris.ts`, `props.ts`?**
  _High betweenness centrality (0.050) - this node is a cross-community bridge._
- **What connects `name`, `private`, `version` to the rest of the system?**
  _93 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `main.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.05076679005817028 - nodes in this community are weakly interconnected._
- **Should `ui.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.09615384615384616 - nodes in this community are weakly interconnected._
- **Should `Tornado` be split into smaller, more focused modules?**
  _Cohesion score 0.09206349206349207 - nodes in this community are weakly interconnected._