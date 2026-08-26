# Ink Tide

A cel-shaded arcade boat racing game on an infinite procedural ocean, built with
Vite, Three.js and TypeScript.

**Zero runtime assets.** Every mesh is generated as `BufferGeometry` in code,
every texture is painted into a canvas or generated as noise at runtime, and
every sound is synthesised with the Web Audio API. The game does not load a
`.png`, `.glb`, `.hdr` or `.mp3`, and nothing is fetched at runtime. The PNGs
under `audit1/` are committed verification frames; they are not part of the
build.

```bash
npm install
npm run dev
```

Then open the URL it prints (http://127.0.0.1:43117 by default). On Windows you
can also double-click `run.bat`, which installs dependencies, starts the dev
server, and opens that URL.

The game needs a WebGL2 context with multiple render targets.

## Controls

| Action | Keyboard | Gamepad | Touch |
| --- | --- | --- | --- |
| Throttle | `W` / `Up` | Right trigger | Right half of the screen |
| Brake / reverse | `S` / `Down` | Left trigger | — |
| Steer | `A` `D` / `Left` `Right` | Left stick | Drag on the left half |
| Powerslide | `Space` / `Shift` | `A` / cross | — |
| Reset | `R` | — | — |
| Camera | `C` | — | — |
| Pause | `Esc` | Start | — |
| Confirm (menus) | `Enter` | — | — |

`C` cycles chase → onboard → heli. Hold the powerslide through a corner to
charge the boost meter, then release to cash it in on the exit.

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Dev server with HMR on port 43117 |
| `npm run build` | Typecheck, then a production bundle |
| `npm run preview` | Serve the production bundle |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run shots` | Capture the verification screenshot set (see below) |
| `npm run shots:tiers` | Same waterline shot at low / medium / high / ultra |
| `npm run probe:handling` | Measure top speed, turn times, drift, airtime |
| `npm run probe:race` | Simulate a full three-lap race headlessly |
| `npm run probe:course` | Circuit geometry, swell alignment, curvature spread |
| `npm run probe:sea` | Sweep wave height against time spent airborne |
| `npm run probe:perf` | Triangle and draw-call accounting |
| `npm run probe:adaptive` | Feed the quality controller synthetic frame times |
| `npm run probe:rider` | Hand IK, lean, foot gap against the real rig |
| `npm run probe:ink` | Which meshes actually carry an outline shell |
| `npm run probe:uniforms` | Shader uniforms declared but never defined |
| `npm run probe:audio` | Engine pitch, rush, and one-shots on a silent bus |

## Architecture

```
src/
  contracts.ts            Shared types. The only module every subsystem may import.
  Game.ts                 Wires the systems together. The one place allowed to.
  main.ts                 Bootstrap.

  core/
    Engine.ts             Renderer, frame loop, adaptive resolution controller.
    CameraRig.ts          Spring chase cam, FOV kick, shake, cinematic modes.
    Input.ts              Keyboard, gamepad and touch collapsed to one state object.
    Palette.ts            THE palette. Nothing invents a colour locally.
    Effects.ts            Effect request bus (spray, flash, shake).

  render/
    layers.ts             Draw slices (opaque, ocean, sky, overlay) plus minimap.
    CelPipeline.ts        MRT scene render, Sobel interior lines, bloom, grade.
    FullScreenPass.ts     Minimal full-screen triangle pass.
    shaderLib.ts          Shared GLSL: MRT outputs, cel lighting, haze.
    OutlineHull.ts        Inverted-hull ink outlines with smoothed normals.
    materials/
      CelMaterial.ts      The workhorse surface material, and the outline shell.
      proceduralTextures.ts  Ramps, matcap, noise — all generated in code.

  world/
    gerstner.ts           The wave field. One source of truth for CPU and GPU.
    Ocean.ts              Camera-locked radial disc, banded water, foam systems.
    WakeField.ts          Persistent world-space wake foam, ping-ponged on the GPU.
    Spray.ts              Instanced cel-styled spray particles.
    Sky.ts                Banded dome, cel clouds, graphic sun.

  entities/
    hullSpec.ts           Dimensions, buoyancy probes, thrust, rider mount.
    boatGeometry.ts       Lofted hull, deck, sponsons, engine — procedural.
    liveryGeometry.ts     Seven-segment race numbers on the sponson walls.
    Boat.ts               Boat visuals and outlines.
    BoatPhysics.ts        Buoyancy, planing, drift/boost, airtime, collisions.
    riderGeometry.ts      Procedural character parts.
    riderMaterials.ts     Shared suit/gear/skin/visor; paint per colour index.
    RiderRig.ts           The bone hierarchy.
    Rider.ts              Procedural animation layers.
    Gate.ts / Buoy.ts     Floating course furniture.

  race/
    Course.ts             The circuit spline, checkpoints, start grid.
    RacingLine.ts         The glowing ribbon that rides the wave surface.
    RaceDirector.ts       Countdown, laps, placement, wrong way, results.
    AIController.ts       Lookahead steering, personalities, mistakes.

  ui/
    hudPrimitives.ts      Shared vector type and panel drawing.
    Hud.ts                In-race canvas HUD.
    Minimap.ts            Orthographic course map.
    Screens.ts            Title, pause, results (DOM + the HUD stroke font).

  audio/
    AudioEngine.ts        Engine voices, water rush, one-shots, buses.
    synth.ts              Oscillators, noise, envelopes — no sample files.

  dev/
    ProbeScene.ts         Cel-calibration primitives (`?probe=1`).
    WaterlineRig.ts       Hull-station waterline overlay (`?waterline=1`).

tools/
  capture.mjs             Headless retina screenshot harness.
  shots.mjs               Canonical adversarial shot list.
  tierCapture.mjs         Same shot at every quality tier.
  *Shots.mjs / *Probe.*   Subsystem shot lists and headless probes.

ai/
  REQUIREMENTS.md         Demand diary (user-stated leaves only).
  REQUIREMENTS_LOG.md     Append-only evidence tape.
  CONSTRAINTS.md          Operating rules for this repo.

scripts/
  sync-ai-docs.ps1        Copy ai/*.md to .cursor/
  check-ai-docs.ps1       Fail if the mirrors drift.
```

The dependency graph is a tree. Subsystems talk through `contracts.ts` and never
import one another; `Game.ts` is the only module that knows about more than one
of them.

### The two things worth reading first

**`src/world/gerstner.ts`** is the single source of truth for the water surface.
Boat buoyancy, the racing line ribbon and the gate floats all need the same
surface the vertex shader displaces, so the GLSL wave table is *emitted* from
the same TypeScript numbers the CPU sampler reads. They cannot drift apart.
Gerstner waves also move the surface horizontally, so finding the height at a
given world XZ means inverting that displacement — the CPU sampler does it with
three fixed-point iterations and the shader does the same.

**`src/render/layers.ts`** explains why the frame is drawn in slices instead of
one. Short version: the water reads the depth of everything behind it to find
its waterline foam, and a pass cannot sample the attachment it is writing to, so
opaque geometry finishes and is copied before the ocean draws. The sky then runs
*after* the ocean, depth-tested into leftover far pixels, so its transparent
clouds cannot overwrite the normal buffer the interior-line pass depends on, and
so a 2× retina frame does not pay for a full-screen sky fill under the water.
`LAYER_MINIMAP` is a camera mask, not a fifth draw slice.

## Rendering

The frame is rendered into a two-attachment framebuffer: lit colour, and packed
view-space normal plus linear depth. That second attachment drives the
screen-space edge pass.

Two independent line systems run together:

- **Inverted-hull outlines** for silhouettes. The shell is pushed along a
  *smoothed* normal set computed by merging vertices on position, because
  pushing along shading normals splits the shell open at every hard edge. The
  push happens in clip space so the line is exactly N pixels wide at any
  distance and on any shape.
- **A Sobel pass over the normal/depth buffer** for interior creases the hull
  trick cannot produce. It suppresses itself wherever the depth gradient is
  large — that is the silhouette, where the hull shell has already drawn ink —
  so the two systems never double up.

Everything else is deliberately non-physical: a nearest-filtered band ramp for
diffuse, thresholded highlight shapes for specular, a painted matcap standing in
for environment reflection, and a quantised haze that steps distant geometry
onto discrete planes like painted background layers. There is no roughness, no
metalness, no IBL and no cubemap probe anywhere in the project.

## Performance

Targets 60 fps at retina on mid-range hardware. The levers, in the order they
are pulled when a frame runs long:

1. **Adaptive resolution.** A windowed median of frame time (not a mean — one GC
   spike should not drop a tier) moves the pixel ratio in small steps with a long
   cooldown, so the controller cannot oscillate.
2. **Quality tiers.** Default play (`high`) is **2× retina, no MSAA, no bloom**,
   with interior lines and the pre-ocean depth copy at half-res. The main MRT is
   LDR on any tier that has bloom off (half the bandwidth of a 2× half-float
   target). Ultra keeps **2× + 4× MSAA**, native-res lines, HDR colour, and bloom
   for captures. Medium is 1× with bloom and lines. Low drops both post passes.
   The same callback also rebuilds the ocean disc coarser, shrinks the wake
   field (high is 384² / 24 Hz), trims spray, and hides distant AI riders. HUD
   canvas is 1× on every play tier (2× only on ultra). Low hides the cloud dome
   overdraw entirely. Ocean feature LOD is measured in CSS pixels, so a denser
   framebuffer sharpens bands without evaluating extra octaves. A play session
   opens at ~1× and climbs toward 2× if frames stay under budget. Adaptive
   never promotes into ultra (2× + 4× MSAA); that tier is opt-in via
   `?quality=ultra`.
3. **Instancing** for buoys, spray, regular gate shells (collar, mast, arch,
   plus ink) and the pulsing overlay lamps/banners. The unique start/finish
   gate stays a mesh. Rider suit/gear/skin/visor
   materials are shared across the field.
4. **LOD by construction.** The ocean's radial disc has exponentially-spaced
   rings, so vertex density tracks 1/z without a discrete pop, and short-wave
   detail is damped with distance. Far gates skip their Gerstner solve and are
   not submitted.

Quality can be pinned with `?quality=low|medium|high|ultra` and adaptive scaling
disabled with `?adaptive=0` (the screenshot harness does both). Other flags:

| Flag | Effect |
| --- | --- |
| `?perf=1` | Live fps / tier / draw-call meter |
| `?harness=1` | Keep the drawing buffer for `toDataURL` (full-frame blit every vsync; play leaves this off) |
| `?probe=1` | Cel-calibration primitives (`src/dev/ProbeScene.ts`) |
| `?waterline=1` | Hull-station waterline overlay (`src/dev/WaterlineRig.ts`) |

Pinning `?quality=` (or `harness=1`) starts at the tier's native pixel ratio
instead of climbing from ~1×.

## The screenshot harness

Every visual claim about this project is verified against a real captured frame.

```bash
npm run shots                                  # the full list at retina scale
node tools/capture.mjs --shots water           # one group
node tools/capture.mjs --only water-04-into-sun
node tools/capture.mjs --list                  # what is available
```

The harness loads the game in headless Chromium with the render loop stopped,
steps the simulation with a fixed 1/60 delta to an exact timestamp, positions
the camera, and reads the framebuffer directly. A shot at `t = 12.0s` is the
same moment on every run and every machine. Output lands in `shots/latest/`
alongside an `index.html` contact sheet and a `report.json` with per-shot draw
call and triangle counts.

The shot list is deliberately adversarial: it includes the angles where each
subsystem is most likely to look wrong — grazing water, straight into the sun,
a boat at 95 m, a silhouette against bright sky — rather than only the
flattering hero angles.

Additional shot lists live alongside it and are selected with `--shotfile`:
`probeShots.mjs` (cel calibration primitives), `boatShots.mjs`, `riderShots.mjs`,
`hudShots.mjs`, `hullShots.mjs`, `archShots.mjs`, `raceShots.mjs`,
`floatShots.mjs`, `waterlineShots.mjs`, and `oceanTermShots.mjs`.

## The headless probes

Screenshots verify how the game *looks*. They cannot verify how it *drives*, and
several of the worst bugs in this project were invisible in a frame:

- Top speed was 1.6 m/s instead of 34, because thrust wetness was sampled at the
  intake point, which sits at the design waterline by definition.
- The buoyancy spring was generating twelve times the boat's weight off a crest
  and throwing it 13 m into the air.
- Boats were airborne 47% of a race. A sea-state sweep proved the swell was not
  the cause — reducing it barely moved the number, and driving *along* the swell
  was airborne more than driving across it. The hull was floating so shallow
  that planing lift left it skipping off ripples.
- `AI_PRESETS` is indexed by boat id, and an off-by-one meant the erratic racer
  was never instantiated.

Each probe runs the real code — real physics against the real wave field, the
real AI against the real director — and prints measured numbers against stated
targets. Most take a few seconds and need no GPU. `probe:adaptive` and
`probe:audio` drive a headless Chromium page so they can see the framebuffer
and the audio graph; they still cannot tell you whether a real GPU holds 60 fps
or whether the mix sounds good.

## Where this actually stands

Measured, not asserted.

**Handling** hits every target it was designed against: 33.3 m/s top speed, 95%
of it in 5.5 s, a 180° turn in 4.5 s dropping to 2.9 s if you drift it, a 1.35 s
boost worth about +7 m/s, and roughly 1.2 s of hang time off a crest. Run
`npm run probe:handling` to check.

**A full race** finishes 4/4 with a 3.7–5.0 s spread across three laps and a
1–2 s winning margin, no wrong-way events and under 1% time off course. Two
runs of `npm run probe:race` are byte-identical.

**The look** is the weaker half. The cel pipeline and the water each self-assess
at around 80% and that is fair. Specifically:

- Near-field water reads flatter than the mid distance — the deep tone drops
  out at grazing angles, so the frame loses contrast exactly where the player
  is looking.
- There is a 2–3 px screen-space line artefact where a hull meets the water,
  from the interior-line pass's relative-depth rejection leaking.
- Crest silhouettes against the sky pick up a faint grey fringe, because
  multisampling resolves saturated cyan against the horizon band through grey.
- The specular still has one glossy highlight that a Guilty Gear frame would
  not have.

**Not verified at all.** Nobody has heard the audio; it was developed on a
machine with no audio device, so every gain, filter Q and send level is a
considered guess. `npm run probe:audio` can prove the graph emits signal and
that engine pitch tracks RPM; it cannot prove the mix is good. Nothing has been
judged in motion either — every frame in `shots/` is a paused capture, and
temporal stability of the edge pass and the band edges under camera movement is
where NPR most often falls apart.

## Licence

MIT.
