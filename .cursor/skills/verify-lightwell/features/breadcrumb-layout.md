# Modules breadcrumb return

The Modules view retains the eight most recently used completed layouts. Returning to an unchanged scope reuses its layout, including a reduced layout produced after a timeout. Changed hierarchy, dependencies, root, or limits require a new layout. Worker replacement preserves completed results; disposing the client clears them. A cached navigation still cancels pending work for an older scope.

## Drive

Build each revision with `npm ci && npm run build` in separate worktrees. Serve each production build on its own port. Use the baseline and updated URLs in that order:

```sh
node scripts/verify/breadcrumb-layout-proof.mjs "$BEFORE_URL,$AFTER_URL" "$ARTIFACTS" 5 --dense
```

The helper alternates revisions across five fresh browser contexts per side. It opens Modules, sets depth to All, enters a child group, and clicks the workspace breadcrumb. Timing starts at the click and ends after the restored graph and camera settle. The deterministic dense fixture has 802 blocks and 1,600 dependency edges and exercises timeout fallback with the real layout worker and ELK. Only the map-loading transport is supplied by the helper; rendering, worker computation, fallback, selection and navigation run unchanged.

Use a facts file from `lightwell extract` instead of `--dense` to measure a real workspace. Omit the final argument to use the bundled Prismattyc map. A normal workspace whose worker cache is already warm may show little improvement; report its result separately from the timeout workload. Do not claim the dense-fixture result reproduces a particular owner workspace.

Expect all graph node IDs and positions and the edge count to match the original root on every return, with zero browser errors. The helper fails and retains diagnostic screenshots if they differ. Adaptive fallback can choose different detail levels under load; that makes an exact comparison fail, rather than silently accepting less work. Keep `results.json`, `summary.json`, and the final screenshots. Report median, range, run count, graph counts, and the machine's load and core count. Optional `BREADCRUMB_PROFILE=1` records main-thread CPU profiles; run profiling separately from reported timing runs.

## Checks and cleanup

```sh
npm test
npm run test:e2e
```

Client regression checks cover reuse across scope changes, original-input fallback caching, invalidation, eviction, disposal and cancellation races. Stop only the preview processes and proof VM started for this run. Remove temporary worktrees and build directories; retain the proof artifacts.
