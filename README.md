# STORM.EXE — Rocky Pass

A browser racing demo with four selectable cars, three AI rivals, a complete Rocky Pass lap, cockpit camera and heavy rain. This source is the tested WEB 02.2 release.

## Controls

W / ↑ accelerate · S / ↓ brake, then reverse · A / D steer · Space handbrake · C camera · V wipers · R recover · Esc pause.

## Local preview

Run a static HTTP server from `public`, then open its root URL. The game has no external asset or API dependency. All four cars and the two supplied sound recordings are included in `public/assets`.

## Publishing

The GitHub Actions workflow publishes the exact `public` directory to GitHub Pages when `main` changes. Repository Pages settings must use **GitHub Actions** as the build source. All asset links are relative so the game also works at a project Pages URL.

## Startup resilience

Surface detail images are optional: a failed request is retried once, with an
8-second limit per attempt. If a texture group still fails, the track keeps its
embedded base atlas and the game starts without that detail layer. Console
warnings identify the failed files; fatal errors retain readable diagnostics.
Required track, collision and vehicle data still fail visibly when unavailable.

Only complete medium-model chunk sets are listed in `mediumParts`. The current
release includes a complete Mercedes2005 medium model; Porsche992,
Mercedes2018 and MercedesGT3 use their bundled LOD models directly. Restore their
`mediumParts` entries only after all chunks have been uploaded and validated.

## Verification

With Node.js 24, run `node --test tests/*.test.mjs` (no npm install required).
The Pages workflow runs these checks before publishing. For browser verification,
serve `public` over HTTP, confirm all four cars can be selected and a race starts,
and repeat with the six `assets/*-*.jpg` detail images returning 404. The menu and
race must remain usable. A missing required `assets/road.json` must instead show a
fatal message that names the file and HTTP status.
