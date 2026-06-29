# AI Database Architect

**Turn a prompt, a document, or an existing database into a live AWS backend — relational schema, CRUD APIs, and an admin dashboard — in seconds.**

AI Database Architect takes whatever you already have — a sentence, a messy spreadsheet, or a legacy database — and produces a **production-shaped relational backend**: it models the data, deploys an isolated schema to **Amazon RDS / Aurora PostgreSQL**, loads your real rows, and generates a full **CRUD REST API** plus an **admin dashboard**. A round-trip verification gate guarantees a lossy schema can never deploy.

---

## ✨ Three ways to create a backend

| Mode | Input | What happens |
|------|-------|--------------|
| **1. Prompt → Backend** | Natural language ("a vet clinic with owners, pets, appointments…") | An LLM (AWS Bedrock) infers entities, relationships, and validation rules. |
| **2. Document → Backend** | CSV, Excel (multi-sheet), or PDF | **Intelligent relational modeling**: a flat attendance sheet becomes `Students + Faculty + Attendance`, not one dumb table. Your rows are loaded into the database. |
| **3. Existing Database Import** | Live PostgreSQL or MySQL | Introspects the schema, migrates it to Aurora PostgreSQL, **copies the data**, and suggests improvements. |

Every path then generates:
- an ordered SQL migration, gated by a **round-trip verifier** (parse the DDL back into a model and structurally diff it — fail closed on any drift);
- an isolated `gen_<id>` schema deployed to **RDS PostgreSQL**;
- a **CRUD REST API** + **admin dashboard** that read and write the real database;
- a **structure (ER) diagram** and a **REST API panel** with copy-paste `curl`.

---

## 🏗️ Architecture

Everything is a deterministic projection of a single **dialect-independent data-model IR** ("model first, generate second"):

```
Input ─► Modeling Engine ─► Refinement ─► Schema Generator ─► Round-Trip Verifier (deploy gate)
                                                                      │
                                              Provisioner (RDS) ◄─────┘
                                                     │
                              API Generator + Auth + Admin Dashboard
```

- **Modeling Engine** — prompt path via AWS Bedrock; document path via deterministic, LLM-free relational decomposition (detects repeating field groups and extracts them into their own entities).
- **Schema Generator** — projects the IR to ordered PostgreSQL DDL (topological order, FK indexes, constraints).
- **Round-Trip Verifier** — reconstructs the IR from the generated DDL and diffs it against the source; blocks deploy on any difference.
- **Provisioner** — transactional migration runner; one isolated schema per generation.
- **API / Dashboard generators + Auth Service + Orchestrator** state machine.

Validated with **property-based testing** (fast-check): **211 tests** covering 46 correctness properties.

---

## 📁 Repository layout

```
src/                Backend engine (TypeScript, ESM)
  model/            The Data_Model IR + invariants
  modeling/         Prompt + document modeling, Bedrock client
  schema/           DDL generation + round-trip verifier + targets
  provisioner/      Transactional RDS migration runner + data seeding + indexing
  api/              CRUD API surface + runtime
  auth/             Role-based auth (hashed passwords, JWT)
  dashboard/        Dashboard descriptor + query logic
  import/           PostgreSQL / MySQL introspection + data copy
  orchestrator/     Pipeline state machine
  pipeline/         Wires it all together (+ env-driven factory)
test/               Vitest + fast-check test suite (211 tests)
web/                Next.js frontend (consumes the engine as a library)
samples/            Example CSV / Excel / PDF files
scripts/            Helper scripts (schema cleanup, import-source setup)
.kiro/specs/        The spec (requirements, design, tasks) this was built from
```

---

## 🚀 Getting started

### Prerequisites
- **Node.js ≥ 18**
- Optional (for live mode): an **AWS account** with Bedrock access and an **RDS/Aurora PostgreSQL** instance.

### 1. Install & build the engine
```bash
npm install
npm run build      # compiles src/ -> dist/
npm test           # optional: run the 211-test suite
```

### 2. Run the web app
```bash
cd web
npm install
npm run dev        # http://localhost:3000
```

> The web app imports the compiled engine from `../dist`, so run `npm run build` at the repo root **before** `npm run dev`.

### 3. Choose a mode (local vs live AWS)

The app works in two modes, selected by environment variables (see below):

- **Local / demo mode (no AWS needed):** uses a deterministic offline model generator and an in-memory database. Great for trying the UI and the modeling instantly.
- **Live mode:** real AWS Bedrock for prompt modeling + real RDS/Aurora PostgreSQL for deployment and data.

---

## ⚙️ Configuration

Configuration is read from environment variables. For the web app, put them in **`web/.env.local`** (this file is gitignored — never commit it). Copy `.env.example` as a starting point.

### LLM (prompt mode)
| Variable | Values | Notes |
|----------|--------|-------|
| `AIDA_LLM_PROVIDER` | `stub` \| `bedrock` \| `http` | `stub` = offline (default). |
| `AIDA_BEDROCK_MODEL_ID` | e.g. `us.amazon.nova-pro-v1:0` | Used when provider is `bedrock`. |
| `AIDA_BEDROCK_REGION` / `AWS_REGION` | e.g. `us-east-1` | AWS region for Bedrock. |
| `AIDA_LLM_ENDPOINT`, `AIDA_LLM_API_KEY`, `AIDA_LLM_MODEL` | — | For an OpenAI-compatible `http` provider. |

AWS credentials for Bedrock come from your standard AWS chain (e.g. `aws configure`, env vars, or an IAM role) — **not** from this repo.

### Deployment target
| Variable | Values | Notes |
|----------|--------|-------|
| `AIDA_DEPLOY_TARGET` | `memory` \| `postgres` | `memory` (default) = in-memory; `postgres` = live RDS/Aurora. |
| `AIDA_DB_HOST` | host | Required for `postgres`. |
| `AIDA_DB_PORT` | default `5432` | |
| `AIDA_DB_NAME` | database name | |
| `AIDA_DB_USER` | user | |
| `AIDA_DB_PASSWORD` | password | |

> Each generation is deployed into its own `gen_<id>` schema, so repeated runs never collide.

---

## 🖥️ CLI usage (engine only, no web)

```bash
# Generate from a prompt using the env-configured pipeline
npm run generate -- "A hotel booking system with rooms, guests, and bookings"
```

### Maintenance scripts
```bash
# List / clean up the gen_* schemas in your live database (safe by default — lists only)
node scripts/cleanup-generations.mjs                 # list
node scripts/cleanup-generations.mjs --keep 3 --yes  # drop all but newest 3

# Create a sample "legacy store" database to test the Import flow
node scripts/setup-import-source.mjs
```

---

## 🧪 Try it

Sample files live in `samples/`:
- `student-attendance.csv` — flat sheet → `Record` + `branch` (intelligent decomposition)
- `invoices.csv` — → `invoice`, `customer`, `productName`, line-item `Record`
- `store.xlsx` — multi-sheet workbook → related `customers` + `orders`
- `students.pdf` — table-in-PDF extraction

Upload any of them in the **Document → Backend** tab and watch the structure diagram + generated API appear.

---

## 🔌 Generated REST API (shape)

For every entity the runtime serves:

| Method | Path | Operation |
|--------|------|-----------|
| `GET` | `/…/entities/{Entity}?page=1&size=25` | List (paginated) |
| `POST` | `/…/entities/{Entity}` | Create |
| `PUT` | `/…/entities/{Entity}/{id}` | Update |
| `DELETE` | `/…/entities/{Entity}/{id}` | Delete |

Validation (required, unique, email format, numeric range, foreign-key existence) is derived from the model and enforced on every write.

---

## 🔒 Security notes

- Secrets (`.aida-db-pw.txt`, `web/.env.local`, `.env*`) are **gitignored** and never committed. AWS credentials are sourced from your local AWS configuration.
- This is a hackathon/demo project: the session store is in-memory and the dashboard is unauthenticated by default. Add the included auth layer and a persistent session store before any production use.

---

## 🛠️ Built with

TypeScript · Node.js · Next.js / React · AWS Bedrock (Amazon Nova) · Amazon RDS / Aurora PostgreSQL · node-postgres (`pg`) · `mysql2` · SheetJS (`xlsx`) · `pdf-parse` / `pdfjs-dist` · Vitest · fast-check (property-based testing) · built spec-first with **Kiro**.

---

## 📜 License

Provided as-is for demonstration purposes.
