# STORM.EXE — Rocky Pass

A browser racing demo with four selectable cars, three AI rivals, a complete Rocky Pass lap, cockpit camera and heavy rain. This source is the tested WEB 02.2 release.

## Controls

W / ↑ accelerate · S / ↓ brake, then reverse · A / D steer · Space handbrake · C camera · V wipers · R recover · Esc pause.

## Local preview

Run a static HTTP server from `public`, then open its root URL. The game has no external asset or API dependency. All four cars and the two supplied sound recordings are included in `public/assets`.

## Publishing

The GitHub Actions workflow publishes the exact `public` directory to GitHub Pages when `main` changes. Repository Pages settings must use **GitHub Actions** as the build source. All asset links are relative so the game also works at a project Pages URL.
