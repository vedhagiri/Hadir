# Hadir frontend — Claude Code notes

## Status
P1 complete: Vite + React 18 + TS strict boots, renders "Hadir" using the
design system CSS, all four CSS files imported in order in `src/main.tsx`.
P3 adds the API client + AuthProvider; P4 adds the shell, login, and
role-aware nav.

## Stack
- Vite 5 + React 18
- TypeScript strict (`tsconfig.json` enables `strict`, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `noUnusedLocals/Parameters`, `verbatimModuleSyntax`)
- React Router v6 (installed; routes wired in P4)
- TanStack Query (installed; `QueryClientProvider` wired in P3)
- Zustand (installed; small client state in P4+)
- React Hook Form + Zod (installed; first used on the P4 login form)
- **No Tailwind, no CSS-in-JS.** Styling is plain CSS via the design system.
- **No component library.** Components are ported from the design archive
  in `src/design/`.

## Layout
```
frontend/
  package.json
  tsconfig.json
  vite.config.ts
  index.html
  Dockerfile
  .env.example
  src/
    main.tsx         # entry; imports CSS in order, mounts <App/>
    App.tsx          # P1 placeholder rendering "Hadir"
    styles/          # design system CSS, copied verbatim — DO NOT EDIT
      styles.css
      styles-enhancements.css
      styles-enhancements2.css
      styles-enhancements3.css
    design/          # design archive JSX, READ-ONLY reference for later sessions
      icons.jsx
      shell.jsx
      ui.jsx
      pages.jsx
      dashboards.jsx
      employee.jsx
      data.jsx
```

## Run
- Dev (containerised): `docker compose up frontend` — http://localhost:5173.
- Dev (host): `npm install && npm run dev` from `frontend/` — set
  `VITE_BACKEND_URL=http://localhost:8000` in `frontend/.env`.
- Type-check: `npm run typecheck`.
- The Vite dev server proxies `/api` → backend so cookies are same-origin.

## Conventions
- **Design files are sacred.** `src/styles/*.css` and `src/design/*.jsx` are
  copied verbatim from the design archive. Do not edit, reformat, or
  "modernise" them. Port their structure into TS components when needed.
- TypeScript strict mode, no `any`. Prefer narrow inferred types.
- `src/design/` is excluded from `tsconfig.json` because it is JSX, not TSX,
  and is a read-only reference — not part of the build graph.
- Primary buttons are **black** (per the design system). The teal accent is
  for signals, not CTAs.

## Pilot prompt currently active
P1 — repo scaffold. Next: P2 (backend Alembic), then P3 (auth), then P4
(frontend shell). Wait for the user before starting any subsequent prompt.
