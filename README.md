# Ink Tide

A cel-shaded arcade boat racing game on an infinite procedural ocean, built with
Vite, Three.js and TypeScript.

**Zero external assets.** Every mesh is generated as `BufferGeometry` in code,
every texture is painted into a canvas or generated as noise at runtime, and
every sound is synthesised with the Web Audio API. There is not a single `.png`,
`.glb`, `.hdr` or `.mp3` in the repository, and nothing is fetched at runtime.

```bash
npm install
npm run dev
```

Then open the URL it prints (http://127.0.0.1:43117 by default).

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

Hold the powerslide through a corner to charge the boost meter, then release to
cash it in on the exit.

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Dev server with HMR on port 43117 |
| `npm run build` | Typecheck, then a production bundle |
| `npm run preview` | Serve the production bundle |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run shots` | Capture the verification screenshot set (see below) |
| `npm run probe:handling` | Measure top speed, turn times, drift, airtime |
| `npm run probe:race` | Simulate a full three-lap race headlessly |
| `npm run probe:course` | Circuit geometry, swell alignment, curvature spread |
| `npm run probe:sea` | Sweep wave height against time spent airborne |
| `npm run probe:perf` | Triangle and draw-call accounting |

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
    layers.ts             The four render slices and why they exist.
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
    boatGeometry.ts       Lofted hull, deck, sponsons, engine — procedural.
    Boat.ts               Boat visuals and outlines.
    BoatPhysics.ts        Buoyancy, planing, drift/boost, airtime, collisions.
    riderGeometry.ts      Procedural character parts.
    RiderRig.ts           The bone hierarchy.
    Rider.ts              Procedural animation layers.
    Gate.ts / Buoy.ts     Floating course furniture.

  race/
    Course.ts             The circuit spline, checkpoints, start grid.
    RacingLine.ts         The glowing ribbon that rides the wave surface.
    RaceDirector.ts       Countdown, laps, placement, wrong way, results.
    AIController.ts       Lookahead steering, personalities, mistakes.

  ui/                     Canvas-drawn HUD, minimap, screens.
  audio/                  Web Audio synthesis.

tools/
  capture.mjs             Headless retina screenshot harness.
  shots.mjs               The shot list.
  probeShots.mjs          Cel-pipeline calibration shots.
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

**`src/render/layers.ts`** explains why the frame is drawn in four slices
instead of one. Short version: the water reads the depth of everything behind it
to find its waterline foam, and a pass cannot sample the attachment it is
writing to; and the sky's transparent quads have to be quarantined or they erase
the normal buffer that the interior-line pass depends on.

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
2. **Quality tiers** drop MSAA (ultra only), then the interior-line pass, then
   bloom. Default play (`high`) is **2× retina with no MSAA** so a mid-range GPU
   is not paying 4× samples on every ocean pixel. Ultra keeps 4× MSAA for
   captures. The same callback also rebuilds the
   ocean disc coarser, shrinks the wake field, trims spray, and hides distant
   AI riders. HUD canvas density follows the same ladder (1× on low/medium,
   2× on high and ultra). Low hides the cloud dome overdraw entirely.
3. **Instancing** for buoys, spray, and the regular gate shells (collar, mast,
   arch, plus ink). The unique start/finish gate stays a mesh. Overlay lamps
   and banners stay per-gate because they pulse. Rider suit/gear/skin/visor
   materials are shared across the field.
4. **LOD by construction.** The ocean's radial disc has exponentially-spaced
   rings, so vertex density tracks 1/z without a discrete pop, and short-wave
   detail is damped with distance. Far gates skip their Gerstner solve and are
   not submitted.

Quality can be pinned with `?quality=low|medium|high|ultra` and adaptive scaling
disabled with `?adaptive=0` (the screenshot harness does both). Add `?perf=1` to
draw a live fps / tier / draw-call meter — that is how a real GPU answers
whether the race holds 60 at retina. The screenshot harness sets `harness=1`,
which is the only mode that keeps the drawing buffer for `toDataURL`; a normal
play session does not, because that copy is a full-frame blit every vsync.

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
`probeShots.mjs` (cel calibration primitives), `boatShots.mjs`, `riderShots.mjs`
and `hudShots.mjs`.

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
targets. They take a few seconds and need no GPU.

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
considered guess. Nothing has been judged in motion either — every frame in
`shots/` is a paused capture, and temporal stability of the edge pass and the
band edges under camera movement is where NPR most often falls apart.

## Licence

MIT.
