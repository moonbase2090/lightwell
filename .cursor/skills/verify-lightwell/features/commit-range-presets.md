# Commit range toolbar

Use a real Git project with at least six linear commits and a version tag such as `v1.0.0` at the oldest commit. Keep the source map small enough that changed blocks are visible. Presets end at the newest project commit listed by the existing history API.

1. Open the project in the native app. Capture Show changes set to Off.
2. Choose Last commit. Confirm the summary names one commit and matches its changed blocks. Expand the list and use Prev, Next, `[` and `]` outside inputs to navigate.
3. Choose Last 5 commits. Confirm the endpoints exclude the older base, include the newest commit, and match `git rev-list --count BASE..TO`. A six-commit linear fixture shows five commits.
4. Choose Since last release. Confirm the nearest reachable version tag supplies the excluded base. A tag at To produces zero commits and zero changed blocks. Tags on unrelated branches must not be selected.
5. Choose Custom. Confirm From (older) appears before To (newer). Tab moves from From to To. Select an older ancestor and verify the exact count, endpoints and changed blocks. Changing To resets From to Before To, which shows one commit.
6. Clear. Confirm Show changes returns to Off and the prior diff closes.
7. Repeat the custom and preset views at desktop width and the minimum supported 920px width. Controls must remain fully inside their row above the summary.

Check explicit messages with a short history, no reachable version tag, and a merge whose five mainline steps contain more than five total commits. These cases must not silently choose a different range. The existing diff engine only accepts strict ancestor endpoints; the Last 5 preset therefore needs an older base and exactly five commits in the resulting full ancestry range.

Focused browser checks: `npx playwright test e2e/commit-range.spec.ts e2e/diff.spec.ts`. Core metadata checks: `cargo test -p lightwell-core --lib --locked diff::ranges`. Browser IPC fixtures verify the real UI and request endpoints; native proof must also use actual Git metadata and diff commands.

Capture before/after screenshots for explicit owner UX approval before merge. Preserve native build logs, exact source hashes, selected fixture endpoint IDs and expected counts. Do not treat elapsed time or peer approval as owner UX approval.
