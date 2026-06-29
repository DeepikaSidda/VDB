# AI Database Architect — Web (Next.js / Vercel)

The frontend for the AI Database Architect. It provides the prompt input, the
refinement question UI, the job-status view, and the generated Admin_Dashboard,
all wired to the backend generation pipeline.

This is a **separate package** from the root backend engine so it never affects
the root project's `tsconfig` / `build` / `test`.

## How the frontend reaches the backend pipeline

The backend engine is the in-process TypeScript pipeline at the repository root
(`src/`). It is compiled to `dist/src/**` (with `.d.ts` declarations), and the
web app imports it **as a built library**:

```ts
// web/lib/backend.ts
import { GenerationPipeline } from '../../dist/src/pipeline/pipeline.js';
```

This is the production-accurate shape of the dependency — the web app consumes
the backend as a library/build, not by reaching into its raw `.ts` sources. In a
real deployment the backend would be published as a versioned package and
imported by name; the relative `../../dist` import keeps the hackathon slice a
single repository. `next.config.mjs` sets `experimental.externalDir: true` so
Next can bundle these out-of-app modules.

Server-side Route Handlers expose the pipeline to the browser:

| Route | Method | Purpose |
| --- | --- | --- |
| `/api/generate` | POST | Start a run from a prompt; returns a generation id + initial snapshot. |
| `/api/generate/{id}` | GET | Poll the current stage / status / failure, and (once deployed) the dashboard descriptor + entity list (Req 9.2, 7.1). |
| `/api/generate/{id}/questions` | GET | Clarifying questions derived from the model (Req 8.1); optional/skippable (Req 8.6). |
| `/api/generate/{id}/entities/{entity}` | GET / POST | List / search / filter records; create a record (Req 7.2–7.8, 7.3). |
| `/api/generate/{id}/entities/{entity}/{pk}` | PUT / DELETE | Update / delete a record by primary key (Req 7.3–7.5). |

A process-local `Map<generationId, session>` (`web/lib/backend.ts`) keeps the
deployed `Backend` (the live `EntityCrudSet` + dashboard descriptor + auth)
server-side so the dashboard acts on the actually-deployed backend. The live
backend is never serialized to the client — only the dashboard descriptor,
entity list, and status snapshot are.

## Requirements coverage

- **Req 9.2** — `JobStatus` polls `/api/generate/{id}` and renders the stage
  timeline as the orchestrator advances; on failure it shows the failing stage
  and reason.
- **Req 8.1 / 8.6** — `RefinementQuestions` shows clarifying questions grounded
  in the model with selectable options and a Skip control; interactive
  refinement is optional (the pipeline runs refinement non-interactively).
- **Req 7.1–7.8** — `Dashboard` / `EntityTable` render from the descriptor:
  entity navigation, a paginated records table, search and filter inputs, an
  empty-result indication, and Add / Edit / Delete actions wired to the CRUD
  routes. Successful actions refetch and reflect the new state; failed actions
  show an error and leave the displayed records unchanged.

## Run

From the repository root, build the backend so `dist/` exists, then run the web
app:

```bash
# repo root
npm install
npm run build        # emits dist/src/** consumed by the web app

# web app
cd web
npm install
npm run dev          # http://localhost:3000
```

## Notes / slice limitations

- The default pipeline uses a stub LLM and an in-memory transactional
  provisioner, so generation completes without live AWS or an LLM key.
- The in-memory session store is per server process (fine for demo).
- Single-column primary keys are addressable through the scalar `{pk}` route;
  composite-key edit/delete is out of scope for the slice.
