---
updated: 2026-08-26
---

# Constraints

Operating rules for Ink Tide. Prefer this file over a generic skill when they
differ.

## Demand diary (PIRS)

Paths:

- Diary: `ai/REQUIREMENTS.md` (mirrored to `.cursor/REQUIREMENTS.md`)
- Tape: `ai/REQUIREMENTS_LOG.md` (mirrored to `.cursor/REQUIREMENTS_LOG.md`)
- These rules: `ai/CONSTRAINTS.md`

Edit `ai/`, then run `scripts/sync-ai-docs.ps1` and `scripts/check-ai-docs.ps1`.
Do not write only to `.cursor/` mirrors.

The diary is a **reference / development notebook**, not a schedule, backlog,
todo list, or implementation-status board. Record user-stated demands. Do not
judge whether they are met. Do not add done / partial / progress labels.

**Leaves only** hold demand specs. Later user wording for the same leaf
overwrites earlier wording. No version history inside a leaf.

### Modes

**First-run** when the diary is missing, empty, or the user asks for 全量建档:
list this project's Cursor sessions, extract every user-stated demand at user-
story grain, merge same leaf by path + semantic similarity, keep only the
latest user wording, set `mode: bootstrapped`.

**Incremental** otherwise: extract new or changed user-stated demands from the
latest user turn; overwrite the matching leaf or create one; bump `updated`;
append one evidence entry to the tape.

Do not ask for consent before writing the diary. If the turn has no demand
change, make no diary edits.

Record goals, constraints, UX, behaviour, exclusions. Do not record pure Q&A,
abandoned ideas, or agent plans the user never adopted. Do not put secrets
(tokens, passwords, PATs) in either document.

## Engineering

These are the rules the codebase already enforces. Do not break them to save a
few lines.

- **Zero runtime assets.** Meshes, textures, and sound are generated in code.
  Do not add `.png` / `.glb` / `.hdr` / `.mp3` to the play path. `audit1/` and
  `shots/` are verification frames, not game content.
- **Tree-shaped modules.** Subsystems import `contracts.ts` and nothing else in
  `src/`. `Game.ts` is the only module allowed to wire more than one subsystem.
- **One palette.** Colours come from `src/core/Palette.ts`. Do not invent a
  hex locally in a shader, HUD, or screen stylesheet.
- **One ocean.** CPU height samples and GPU displacement share
  `src/world/gerstner.ts`. Do not fork a second wave table.
- **Verify, don't assume.** Visual claims go through `tools/capture.mjs`.
  Handling, race, ink, uniforms, and similar claims go through the matching
  probe. Do not treat a paused screenshot as proof of motion or audio quality.
- **Quality ladder.** Play default is `high` (2×, no MSAA, no bloom). Adaptive
  resolution may drop tiers and pixel ratio; it must not auto-promote into
  `ultra`. Pin `ultra` with `?quality=ultra` for captures.

## Docs

Keep `README.md` aligned with the tree, `package.json` scripts, URL flags, and
quality presets actually in the code. Do not restate the demand diary there.
