# Browser preview maps

A developer opens the static Lightwell viewer (built site) to browse the checked-in Prismattyc and Scorecard maps without network calls.

## Sub-features

- `preview-serves` — production build preview responds on localhost.
- `fixtures-bundled` — maps ship inside the built assets (imported at build time).

## How to get to it (user POV)

- Run `npm run dev` for development or `npm run build` then `npm run preview` for the production bundle.
- Open the URL Vite prints (default preview port `4173`).

## Driving it with HTTP

Preconditions:

- `npm ci` and `npm run build` succeeded.
- Preview server running on `http://127.0.0.1:$PORT/` (see skill **Launch**).

- **Serve:** run `scripts/verify/browser-preview-proof.sh 127.0.0.1 "$PORT" /tmp/lightwell-verify-$RUN_ID/proof`; expect exit `0` and `browser-preview-proof: ok` on stdout.
- **Manual UI (optional):** open the preview URL in a browser; choose **Prismattyc** or **Scorecard** from the map picker; the canvas `aria-label` should include `architecture map`.

## Gotchas

- The browser preview does not open arbitrary folders; only checked-in fixtures (`prismattyc`, `scorecard`). Desktop **Open workspace** is a separate Tauri flow (not covered here).
