# Modules breadcrumb layout reuse

Returning to the workspace on a dense dependency graph fell from a median **3383.5 ms to 350.1 ms**. Five runs per revision alternated before/after, using production builds, the real layout worker and ELK, and an identical 1440 × 900 viewport. Every return restored the same 400 nodes, their positions, and 792 visible edges with zero browser errors. Timing includes the root breadcrumb click, restored graph, and settled camera.

| Workload | Before median and range | After median and range | Runs per side |
| --- | --- | --- | --- |
| Generated dense graph, 802 input blocks and 1600 dependencies | 3383.5 ms, 3233.5–3616.5 ms | 350.1 ms, 333.5–365.3 ms | 5 |
| Real Prismattyc extraction, 981 input blocks and 62 dependencies | 400.5 ms, 400.0–434.2 ms | 433.8 ms, 407.2–468.5 ms | 5 |

The dense graph's root return previously retried the full layout for 2 seconds, terminated its worker, and spent another 0.9–1.3 seconds recomputing a reduced layout. Worker replacement also discarded its local cache. The completed-result cache retains the successful result under the original request, so all updated returns made zero layout-worker requests. A separate main-thread CPU profile spent about 2891 ms idle while the worker ran. Removing that wait explains the improvement; this is not a general paint optimization.

The real Prismattyc map already gets worker cache hits in roughly 3–4 ms. Its ranges overlap and show no clear performance gain. The owner's reported 10-second case was not reproduced on that workspace; its exact workspace, OS and depth remain unconfirmed. The dense workload demonstrates the repeated-timeout path with generated map input, not that specific report.

Measurements used Chromium 156 and Node.js 22.23.3 on an 18-logical-core macOS host. The shared host had sampled 1/5/15-minute load averages of 9.58/10.91/7.56; revisions were interleaved to expose both to that noise. No artificial delay or CPU throttling was used. The map-loading transport supplies data; the renderer, real worker computation, fallback and breadcrumb navigation run normally.

Raw samples are [dense-results.json](dense-results.json) and [prismattyc-results.json](prismattyc-results.json). Native browser captures show the restored graph [before](before.png) and [after](after.png).

## Clean VM validation

A fresh Ubuntu VM with 4 CPUs and 8 GiB RAM ran `npm ci`, `scripts/verify/doctor.sh`, and both production builds. Doctor returned `verify doctor: ok`. The updated build completed five dense-workload root returns with exact graph restoration, zero errors, and zero worker requests: median **366.9 ms**, range **363.9–376.7 ms**. See [VM samples](vm-results.json), [environment and summary](vm-summary.json), and [the VM screenshot](vm-after.png).

The VM's baseline sometimes selected a different fallback detail level on return under load. The helper rejected that comparison instead of accepting less work. Those timings are not used in the before/after claim. Cached returns preserve the completed initial layout, including its fallback detail level.

## Reproduce

Build baseline `fa23cc1` and the updated revision in separate worktrees and serve each production build on its own port. From the updated checkout:

```sh
node scripts/verify/breadcrumb-layout-proof.mjs "$BEFORE_URL,$AFTER_URL" "$ARTIFACTS" 5 --dense
node scripts/verify/breadcrumb-layout-proof.mjs "$BEFORE_URL,$AFTER_URL" "$REAL_ARTIFACTS" 5 "$FACTS_FILE"
```

Use `lightwell extract` to produce the real workspace facts file. The helper writes samples, median/range summaries, and screenshots. Graph mismatches and browser errors fail the run and retain diagnostics. See [the verification guide](../../../.cursor/skills/verify-lightwell/features/breadcrumb-layout.md).

Validation also passed all **390 unit tests**, the complete **280-test UI suite**, the production TypeScript/Vite build, and the configured Scorecard type/test/secret gates. Cache regression checks cover fallback reuse, changed graph inputs and limits, bounded retention, disposal, and cancellation of pending or already-timed-out scope work.
