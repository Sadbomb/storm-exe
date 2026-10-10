# STORM.EXE — Rocky Pass

Club Racing 03: a browser racing game with four individually tuned cars, progressive tyre physics, three levels of driver assistance and AI, dry/rain presets, time attack, personal best ghosts, sector timing, and instant replay.

[中文更新说明：驾驶物理重构与另外 30 项改进](docs/UPDATE-V3.md)

**Play online:** https://sadbomb.github.io/storm-exe/

## Controls

W / ↑ accelerate · S / ↓ brake, then reverse · A / D steer · Space handbrake · B look back · C camera · V wipers · R recover · Esc pause.

Standard gamepad: left stick steer, RT throttle, LT brake, A handbrake, B look back, X recover, Y camera, Start pause. Mobile uses a sliding steering control and touch pedals.

Pause to replay the last 20 seconds. Select driving assistance, steering sensitivity, weather, AI difficulty, camera comfort, sound volume and HUD options in the garage. Settings and condition-specific best laps stay on this browser. Vehicle parameters are gameplay calibrations, not manufacturer specifications.

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

Race models load by default; choose full cockpit detail in the garage for the larger models. All four complete high-detail model chunk sets are listed in `mediumParts` and
verified by the publishing tests. If a chunk is temporarily unavailable,
the game falls back to that car's bundled race model.

## Verification

With Node.js 24, run `node --test tests/*.test.mjs` (no npm install required).
The Pages workflow runs these checks before publishing. For browser verification,
serve `public` over HTTP, confirm all four cars can be selected and a race starts,
and repeat with the six `assets/*-*.jpg` detail images returning 404. The menu and
race must remain usable. A missing required `assets/road.json` must instead show a
fatal message that names the file and HTTP status.
