# Privacy

Lightwell 0.1.0 keeps workspace data on the machine where you run it.

## What stays local

- The browser preview reads the map files in this repository. It does not upload them.
- Opening a workspace reads the Cargo manifests and Rust sources in the folder you choose.
- Project notes are stored in `.lightwell/notes.json` inside that workspace. Lightwell never uploads them. Because the file sits inside your project, notes are shared only if you commit and push that file yourself with your own git tooling; a commit on its own does not upload anything.
- The desktop app stores recent workspaces in `recent-workspaces.json` and the editor command in `editor-settings.json`, both in the app's user config folder.
- The browser preview stores the theme and pane sizes in local storage in that browser.

Lightwell does not create an account. This repository does not ship a telemetry client.

## Questions

Questions about the marketing site go to the contact on its privacy page. This note covers the application only.
