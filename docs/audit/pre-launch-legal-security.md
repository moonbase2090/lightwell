# Pre-launch legal and security audit (report-only)

**Date:** 2026-10-09  
**Scope:** `moonbase2090/lightwell` (Tauri desktop app + CLI) and `moonbase2090/lightwell-website` (static marketing site).  
**Status:** Findings only — no remediations in this change. Follow-up PRs after MB2090 review.

> **Not legal advice.** This document is an engineering checklist review. Items marked “counsel” need a qualified attorney for your jurisdictions and distribution channels (app stores, EU/UK, etc.).

## Summary

| Area | App | Website |
|------|-----|---------|
| Secrets in shipped client | No keys found; local FS + IPC | No keys in `public/` |
| Privacy policy links | Missing | Missing |
| Age gate | N/A (dev tool) | N/A |
| Analytics / pixels | None in source | CSP allows optional Cloudflare Insights |
| Email / subscriptions / AI chat | N/A | N/A |
| WCAG | Gaps (map keyboard, dialogs) | Mostly solid; mobile nav + contrast |
| DMCA / UGC hosting | N/A | N/A |
| Third parties | Bundled npm + Monaco licenses | Self-hosted fonts; optional CF analytics |

---

## 1. Secrets, tokens, and data access

### Lightwell app

| Severity | Location | Finding | Suggested fix |
|----------|----------|---------|---------------|
| Info | `crates/lightwell-app/capabilities/default.json:6` | Tauri permissions limited to `core:default` and `dialog:allow-open`. | Keep capability surface minimal as features grow. |
| Info | `src/` (frontend) | No `fetch`, WebSocket, or embedded API keys in the viewer. | Maintain secret scanning in CI. |
| Medium (privacy) | `crates/lightwell-app/src/workspace.rs:348-359` | Recent workspace paths and editor settings persist under the app config directory (`recent-workspaces.json`, `editor-settings.json`). | Disclose local persistence in a privacy notice; offer “clear recent workspaces” before broad distribution. |
| Medium (security) | `crates/lightwell-core/src/editor.rs:361` (via `open_block_in_editor` in `workspace.rs:132`) | User-defined editor command templates run as subprocesses (`Command::new`), with length/control-char checks in `workspace.rs:362-374`. | Warn in Settings that custom templates execute programs with the user’s privileges; consider confirmation or safer defaults. |
| Info (positive) | `crates/lightwell-app/src/workspace.rs:117-121` | Source reads are constrained to paths under the opened workspace root. | Document that opening a workspace grants read access to that tree. |
| Low | `maps/scorecard.annotations.json:288` | Bundled sample map text mentions `XAI_API_KEY` for **Scorecard**, not Lightwell runtime. | Optional: shorten annotation copy so shipped fixtures do not name env vars. |
| Low | `docs/plan/app-plan.md:36` | Planning doc references Apple Developer ID team id and notary profile name. | Keep signing details in private release docs if repo visibility changes. |

**Does not apply:** Row-level security or cloud database credentials — Lightwell has no server-side database or multi-tenant storage in these repos.

### lightwell-website

| Severity | Location | Finding | Suggested fix |
|----------|----------|---------|---------------|
| Info | `public/*`, `worker.js`, `public/main.js` | No API keys or tokens in shipped assets. | Continue storing Cloudflare deploy tokens only in GitHub Actions secrets. |
| Info | `.github/workflows/deploy.yml` | CI references `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` (names only). | Rotate if leaked; never commit values. |

---

## 2. Privacy policy (collection matches disclosure; footer, signup, app)

| Severity | Location | Finding | Suggested fix |
|----------|----------|---------|---------------|
| Medium | `index.html`, `src/App.tsx`, `README.md` (app) | No privacy policy or terms links in the desktop UI or README. | Add About / Help links to Moonbase policies; align App Store “privacy nutrition” labels with actual behavior (local paths, source read, notes file, editor spawn). **Counsel** for store wording. |
| Medium | `lightwell-website/public/index.html:277-281` | Footer has Features, Status, Moonbase — **no Privacy or Terms**. | Publish `/privacy` (and `/terms` if needed); link from footer; describe hosting logs and any analytics (see §4). |
| Info | `lightwell-website/public/index.html:35` | JSON-LD lists publisher `Moonbase 2090 LLC`. | Legal pages should name the same entity. |

**Does not apply:** Signup flows — neither product collects accounts in-repo today.

**Local data to disclose (app):** theme preference (`src/theme.ts:4-29`, `localStorage` key `lightwell.theme`); project notes at `.lightwell/notes.json` (`crates/lightwell-core/src/notes.rs`); workspace map extraction reads the user’s disk only.

---

## 3. Age gate and under-13 users

| Repo | Applicability |
|------|----------------|
| App | **N/A** — Developer-focused desktop tool; no accounts, no child-directed positioning in product copy. Revisit only if marketing targets minors. |
| Website | **N/A** — Static product marketing; no UGC or age-restricted content. |

**Counsel** if COPPA/GDPR-Kids positioning changes.

---

## 4. Analytics, session replay, and pixels (consent)

| Severity | Location | Finding | Suggested fix |
|----------|----------|---------|---------------|
| Info (positive) | App source (`*.ts`, `*.tsx`, `*.rs`, `index.html`) | No PostHog, Sentry, GA, gtag, Segment, Hotjar, FullStory, or ad pixels. | Re-audit before adding dependencies. |
| Info | `src/theme.ts:20-29` | `localStorage` used for theme only — functional, not analytics. | Mention in privacy policy if one is added; no banner required solely for this. |
| Medium | `lightwell-website/public/_headers:2` | CSP allows `https://static.cloudflareinsights.com` and `connect-src` to `cloudflareinsights.com`. | Confirm whether Cloudflare Web Analytics is enabled in the dashboard; document in privacy policy; add consent mechanism if required for EU/UK non-essential tracking. |
| Info | `lightwell-website/public/index.html`, `public/main.js` | No in-repo analytics script tags; `main.js` is scroll/reveal only. | If enabling CF Insights, treat as third-party processing in policy text. |

**Does not apply:** Tracking on payment, health, or in-app chat forms — none exist.

---

## 5. Marketing email (unsubscribe, postal address, opt-out SLA)

**N/A** for both repos — no email capture, newsletters, or transactional email implementation. When a waitlist launches, use a provider with CAN-SPAM/GDPR tooling and link the privacy policy at collection.

---

## 6. Subscriptions (terms at pay button, confirmation email, one-click cancel)

**N/A** — No Stripe, IAP, or subscription UI in either repo (`lightwell-website` “Coming soon” only). Before monetization: terms next to pay button, receipt email, and cancellation path per counsel and platform rules.

---

## 7. AI / chatbot transparency (EU AI Act)

| Repo | Applicability |
|------|----------------|
| App | **N/A** — No conversational AI or LLM calls in Lightwell UI or Rust commands. Sample map text in `maps/scorecard.annotations.json` describes another product’s optional review endpoint; it is not in-app behavior. |
| Website | **N/A** — No embedded chat or LLM widgets; marketing copy only. |

If AI-assisted features ship later, disclose “AI” in the first message of any automated assistant (**counsel** for Aug 2026 EU transparency rules).

---

## 8. WCAG 2.1 AA basics

### Lightwell app

| Severity | Location | Finding | Suggested fix |
|----------|----------|---------|---------------|
| High | `src/App.tsx:976` | React Flow `elementsSelectable={false}`; map interaction is primarily pointer-driven (`onNodeClick` ~730). | Add keyboard-operable nodes (`tabIndex`, Enter/Space), or document an equivalent path (e.g. search-only open) and test with screen readers. |
| Medium | `src/viewer/BlockNode.tsx:36-40` | Block nodes are `<div>` with hover handlers; no `role`, `tabIndex`, or keyboard handlers. | Treat nodes as buttons or link to search results pattern. |
| Medium | `src/App.tsx:194` | Search results use `role="listbox"` without full listbox keyboard pattern (`aria-activedescendant`, arrow keys). | Implement WAI-ARIA listbox or simplify roles. |
| Medium | `src/App.tsx:330` | `role="tablist"` / `role="tab"` without paired `tabpanel` ids / `aria-controls`. | Wire tabs to panels. |
| Medium | `src/EditorSettingsPanel.tsx:76-83` | Settings dialog lacks focus trap (contrast `ProjectNotesDialog` which traps focus). | Trap focus and return focus on close. |
| Medium | `src/style.css` (~22) | `min-width: 920px` and `overflow: hidden` on `body` hinder small viewports and zoom. | Allow scroll/reflow; test 200% zoom. |
| Low | `src/style.css` | `outline: 0` on some controls; placeholder contrast may be below 4.5:1 in places. | Visible `:focus-visible` on all controls; verify contrast tokens. |
| Low | Animations | No `prefers-reduced-motion` guard for graph motion. | Respect reduced motion. |
| Info | Monaco (`src/SourceCodeEditor.tsx`) | Editor accessibility depends on upstream Monaco. | Document limitations; ensure “open in external editor” remains viable. |

No `<img>` in `src/` — decorative icons via Lucide/SVG; icon-only controls largely have `aria-label`.

### lightwell-website

| Severity | Location | Finding | Suggested fix |
|----------|----------|---------|---------------|
| Info (positive) | `public/index.html:41` | Skip link to `#main`. | Keep. |
| Info (positive) | `public/styles.css`, `public/main.js` | `focus-visible` styles; `prefers-reduced-motion` disables reveal animations. | Keep. |
| Medium | `public/styles.css` (~326-329) + nav markup | Below ~640px, primary nav links hidden; footer anchors remain. | Add mobile menu or ensure all destinations reachable without hidden links. |
| Low | `public/styles.css:9` (`--dim` on `--bg`) | Muted meta text may be near 4.5:1 — verify with a contrast checker. | Lighten `--dim` if needed. |

---

## 9. DMCA and user-uploaded content

| Repo | Applicability |
|------|----------------|
| App | **N/A (platform)** — No hosted UGC service. Notes are local `.lightwell/notes.json`; maps are local or bundled. DMCA agent not required unless Lightwell operates a sharing/CDN product. |
| Website | **N/A** — No uploads or comment hosting. |

**Low (operational):** Users can write arbitrary text into project notes locally — organizational policy, not DMCA.

---

## 10. Third-party scripts and fonts

### Lightwell app

| Asset | Location | Notes |
|-------|----------|--------|
| React, XYFlow, elkjs, lucide-react, Monaco | `package.json` | Bundled at build; `npm run check:licenses` in CI |
| Monaco worker | `src/SourceCodeEditor.tsx` | Local worker bundle, not a CDN |
| Fonts | `src/style.css` | System UI stack only |
| HTML entry | `index.html` | Single module script from same origin |
| Shipped notices | `public/third-party-licenses/` | Monaco third-party license texts |

### lightwell-website

| Asset | Location | Notes |
|-------|----------|--------|
| `/main.js` | `public/index.html:285` | First-party only |
| JSON-LD | `public/index.html:28-37` | Inline, no external fetch |
| JetBrains Mono Nerd, Rajdhani | `public/styles.css` (~360-374) | Self-hosted WOFF/WOFF2; OFL files under `public/assets/fonts/` |
| Inter | `public/styles.css:13-14` | Named in stack only — not loaded from Google Fonts |
| Optional Cloudflare Web Analytics | `public/_headers:2` | Allowed by CSP; may be injected at edge if enabled |
| Worker redirect | `worker.js` | Apex/www HTTPS redirect only |

Prefer self-hosting (already done for fonts). Revisit CSP if new marketing tags are added.

---

## Release and distribution (extra)

| Severity | Location | Finding | Suggested fix |
|----------|----------|---------|---------------|
| Info | `.github/workflows/ci.yml` | macOS artifacts may build unsigned in some jobs. | Signed + notarized builds before public macOS distribution (`docs/plan/app-plan.md`). |
| Info (positive) | `crates/lightwell-app/tauri.conf.json` | Bundle includes `LICENSE` (MPL-2.0). | Add in-app “Open source licenses” if a store requires it. |

---

## Recommended follow-up order (after MB2090 review)

1. **Legal pages** — Privacy (and terms when needed) on website + links in app About; align with Moonbase 2090 LLC entity.
2. **Accessibility** — Map keyboard path and settings dialog focus trap (app); mobile nav and contrast check (website).
3. **Disclosure** — Local data (paths, notes, editor commands) and optional Cloudflare analytics.
4. **Distribution** — Signing/notarization and store privacy labels before consumer launch.

---

## Proof

- Manual review of `moonbase2090/lightwell` at branch `main` (2026-10-09): searched for analytics vendors, secrets, privacy links, payment/email/AI UI; read Tauri capabilities, workspace persistence, editor spawn path, and primary React surfaces (`App.tsx`, `BlockNode.tsx`, `EditorSettingsPanel.tsx`).
- Manual review of `moonbase2090/lightwell-website` at `main`: read `public/index.html`, `public/main.js`, `public/styles.css`, `public/_headers`, `worker.js`, and deploy workflow.
- No application code or CI workflow changes in this PR — documentation only.

## Review

Request **prismattyc-review** (Astra) per leaf policy. MB2090 approves findings before implementation PRs.
