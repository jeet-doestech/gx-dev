# gx-dev planning website

Static multi-page HTML documentation for the gx-dev development plan — twelve pages, dependency-free, with built-in client-side search.

## Open locally

Open `index.html` directly in a browser, or serve this directory:

From the repository root, run:

```bash
python3 -m http.server 8080
```

Then visit <http://localhost:8080/website/>. Serving the repo root also keeps links to `../PLAN.md` available. No build step, server runtime, or external assets (no CDNs or web fonts) are required.

## Pages

- `index.html` — executive overview and full documentation index
- `workflow.html` — workflow, gates, failures, and user checkpoints
- `architecture.html` — system architecture, Git worktrees, persistence, and security
- `agents.html` — role contracts and moderated communication
- `gates.html` — test gate, review severity model, five-failure escalation, and evidence
- `memory.html` — evidence, reviewed wiki, schema, retrieval, and linting
- `tui.html` — `/gx-dev` commands, dashboard, status widget, and modal questions
- `configuration.html` — full configuration model: keys, types, defaults, constraints
- `security.html` — prompt injection defense, project trust, paths, secrets, Git safety
- `installation.html` — pi package install (registry, Git URL, local), first run, upgrades
- `troubleshooting.html` — refusals, child-process failures, recovery, config and lint errors
- `reference.html` — state, event, completion, evidence, and memory schemas
- `delivery.html` — implementation phases, tests, scope, and definition of done (linked from the overview and every footer; not in the main nav)

## Search

The header search button (or the `/` keyboard shortcut) opens a dependency-free, ranked substring search across all pages. The index lives in `assets/search-index.js`; the engine in `assets/search.js` needs no network or libraries.

## Assets

- `assets/styles.css` — theme-aware styles driven by CSS custom properties (light/dark)
- `assets/site.js` — theme toggle, mobile navigation, year stamp
- `assets/search-index.js` — search entries for every page
- `assets/search.js` — self-initializing search modal (keyboard accessible, Escape closes)

The site is dependency-free, responsive, printable, accessible, and supports persisted light/dark themes. All diagrams are inline SVG that follows the active theme.
