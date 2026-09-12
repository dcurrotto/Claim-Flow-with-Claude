# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Claim Flow** — a P&C Claims Workflow Orchestrator portfolio/demo app. Adjusters log in to manage a claims queue; claimants submit First Notice of Loss (FNOL) via a public intake wizard. The system auto-triages incoming claims and routes them to the appropriate handling path.

- **Frontend**: React + TypeScript + Vite SPA with Cognito-based auth
- **Backend**: FastAPI (Python) deployed as an AWS Lambda via Mangum
- **Infrastructure**: AWS SAM (Serverless Application Model) managing Lambda, API Gateway, Cognito, DynamoDB, and IAM

## AWS Account & Environment Strategy

All environments live in a single AWS account. Three separate SAM stacks are deployed into this account:

| Environment | SAM config env | Stack name | Purpose |
|---|---|---|---|
| Dev | — | — | Frontend + backend run locally; Cognito + DynamoDB deployed as a `dev` stack |
| QA | `qa` | `claim-flow-qa` | Full stack deployed to AWS; used for testing before prod |
| Prod | `prod` | `claim-flow-prod` | Live production |

QA CloudFront: `https://dra74zpqiiy81.cloudfront.net`  
QA API Gateway: `https://i8mpp59137.execute-api.us-east-1.amazonaws.com/qa`

Deploy with `sam deploy --config-env qa` or `sam deploy --config-env prod`.

AWS credential profiles must be named `claim-flow-qa` and `claim-flow-prod` in `~/.aws/credentials`.

## First-Time AWS Account Setup

When setting up a new AWS account for this project, complete these manual steps once in the AWS console.

### 1. Enable IAM Billing Access (root required)
- Top right → **Account** → **IAM user and role access to Billing information** → **Edit** → check **Activate IAM Access** → **Update**

### 2. Set Alternate Contacts (root required)
- Top right → **Account** → **Alternate contacts**
- Add business email as contact for **Billing**, **Operations**, and **Security**

### 3. Enable CloudWatch Billing Alerts
- **Billing and Cost Management** → **Billing preferences** → **Alert preferences** → **Edit**
- Enable **CloudWatch billing alerts**

### 4. Create a CloudWatch Billing Alarm
Must be done in **us-east-1 (N. Virginia)**:
- CloudWatch → **Alarms** → **Create alarm** → **Billing** → **Total Estimated Charge** → **EstimatedCharges (USD)**
- Set threshold: Greater than `20`; create SNS topic `billing-alerts` with your email

### 5. Create an AWS Budget
- **Billing and Cost Management** → **Budgets** → **Create budget**
- Monthly cost budget, name: `Claim Flow Total`, Amount: `50`


## Commands

### Frontend (`cd frontend` first)
```
npm install          # install dependencies
npm run dev          # start dev server (http://localhost:3000)
npm run build        # tsc + vite build
npm run lint         # eslint with zero warnings allowed
npm run preview      # preview production build
```

### Backend (`cd backend` first, or run from root)
```powershell
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn app:app --reload                   # from backend/
uvicorn backend.app:app --reload           # from repo root
uvicorn weather_mcp.app:app --port 8001 --reload   # weather MCP server, run alongside the API for AI Claims Analyst
```
Health check: `http://localhost:8000/health`

Note: the `requirements.txt` at the repo root is a stale leftover from an earlier Strands/Bedrock-based version of the agent (still lists `strands-agents`, `opentelemetry-*`, etc.) and does not reflect the current backend. Always install from `backend/requirements.txt`.

### Infrastructure (`cd infrastructure` first)
```
sam build
sam deploy --guided --config-env qa    # first QA deploy (writes samconfig.toml)
sam deploy --guided --config-env prod  # first prod deploy
sam deploy --config-env qa             # subsequent QA deploys
sam deploy --config-env prod           # subsequent prod deploys
```

`samconfig.toml` stores stack names, S3 prefixes, and parameter overrides per environment. The `profile` field must match a named profile in `~/.aws/credentials`:
```ini
[claim-flow-qa]
aws_access_key_id = ...
aws_secret_access_key = ...

[claim-flow-prod]
aws_access_key_id = ...
aws_secret_access_key = ...
```

## Architecture

### Authentication Flow
Cognito is **invite-only** (`AllowAdminCreateUserOnly: true`) — no self-signup. Admins create users via the AWS console or admin API. The frontend redirects to Cognito Hosted UI, receives an auth code at the callback URL, then exchanges it for tokens via `POST /oauth2/token` (see [frontend/src/auth/cognito.ts](frontend/src/auth/cognito.ts)). Tokens (`id_token`, `access_token`, `refresh_token`) are stored in `localStorage`.

`useAuth()` ([frontend/src/hooks/useAuth.ts](frontend/src/hooks/useAuth.ts)) decodes the JWT client-side to extract `email`, `name`, `sub`, and `cognito:groups`. Role-based UI (e.g. Admin nav item) is driven by group membership (`Admins` / `Users`).

### FNOL Intake Flow
The intake wizard (`/intake`) is **fully public** — no login required.

1. Claimant completes a 3-step wizard (loss info → contact info → review)
2. Frontend POSTs to `POST /public/claims`
3. Backend auto-triages the claim and saves it to DynamoDB
4. Claimant sees a confirmation with a generated Claim ID (e.g. `CLM-2026-A3F8B2C1`)

### Auto-Triage Logic (server-side, `backend/api/claim_api.py`)
| Condition | Triage Result |
|---|---|
| `loss_type == "liability"` | `siu` |
| `estimated_amount > $50,000` | `siu` |
| `loss_type == "auto"` | `straight-through` |
| everything else | `manual-review` |

### AI Claims Analyst (`backend/services/claims_agent_service.py`)
On the claim detail page, an adjuster can click "Analyze with AI" to get an LLM-generated recommendation, separate from the deterministic auto-triage above. This is a hand-rolled **coordinator + subagents** architecture using the **direct Anthropic API** (not Bedrock) — a deliberate exam/portfolio pattern (Claude Certified Architect – Foundations), so the tool-use loops and MCP wiring are built by hand rather than via a higher-level agent framework.

- **Model**: `claude-sonnet-5` via `anthropic.AsyncAnthropic`, authenticated with `ANTHROPIC_API_KEY`.
- **Coordinator** (`_run_coordinator`) has two tools, each of which runs a full nested subagent tool-use loop and returns its final text as the tool result:
  - **Fraud Risk subagent** (`_run_fraud_subagent`) — tools: `get_claim_details` (reads the claim via the repository layer) and `assess_fraud_indicators` (rules-based: flags `estimated_amount > $50,000`, `loss_type == "liability"`, and red-flag keywords like "attorney", "whiplash", "settlement" in the description; returns a risk level and recommended path).
  - **Loss Verification subagent** (`_run_weather_subagent`) — tools: `get_claim_details` plus tools discovered dynamically (via MCP `list_tools`) from a **standalone weather MCP server** (`backend/weather_mcp/`), reached over HTTP at `WEATHER_MCP_URL`. That server wraps the free, key-less Open-Meteo geocoding + historical-weather APIs (`geocode_location`, `get_historical_weather`) to check whether a claimed weather event (storm, hurricane, flood, etc.) actually occurred at the loss date/location. Deployed as its own Lambda (`WeatherMcpFunction`), not in-process — a genuine remote MCP call.
- The coordinator's system prompt constrains its final output to fixed headings: **Triage Decision**, **Risk Assessment**, **Weather Verification**, **Suggested Next Steps**, **Missing Information**. It can override both subagents' recommendations (e.g. escalate to Manual Review/SIU) if the weather record contradicts the claimant's account.
- Every tool call (by the coordinator or either subagent, internal or MCP-sourced) is recorded to a flat `trace` list returned alongside the analysis — this is what powers the "Agent Trace" UI (below).
- Exposed via `POST /agent/analyze/{claim_id}` (`backend/api/agent_api.py`, now `async`). Results (`analysis` text + `trace`) are cached onto the claim record (`ai_analysis`, `ai_analysis_trace`, `ai_analysis_at`); pass `?force=true` (the "Re-analyze" button) to bypass the cache and re-run.
- Frontend: `AgentPanel` component in [frontend/src/pages/ClaimDetail.tsx](frontend/src/pages/ClaimDetail.tsx), rendered via `analyzeClaim()` in `src/api/claimApi.ts`. Output is Markdown plus a collapsible agent-trace panel.

**Local dev**: the weather MCP server runs as a second local process — see Commands below. Both `ANTHROPIC_API_KEY` and `WEATHER_MCP_URL` must be set in `backend/.env`.

**Deploy**: the Anthropic API key is *not* managed by SAM. Create it once per environment before first deploy:
```
aws secretsmanager create-secret --profile claim-flow-qa --name claim-flow-anthropic-api-key-qa --secret-string "sk-ant-..."
aws secretsmanager create-secret --profile claim-flow-prod --name claim-flow-anthropic-api-key-prod --secret-string "sk-ant-..."
```
`template.yaml` injects it into `ApiFunction` via a CloudFormation dynamic reference (`{{resolve:secretsmanager:...}}`) at deploy time — no runtime Secrets Manager IAM permission needed.

### DynamoDB Data Model
Single-table design — one table (`ClaimFlowMainEntry`) stores all entity types.

| EntityType | PK | SK |
|---|---|---|
| CLAIM | `CLAIM#<claimId>` | `META` |

Claim fields: `ClaimId`, `loss_type`, `date_of_loss`, `description`, `name`, `email`, `phone`, `triage`, `status`, `reported_at`, `ai_analysis`, `ai_analysis_trace`, `ai_analysis_at`.

Claim statuses: `new`, `open`, `pending`, `closed`.  
Triage values: `straight-through`, `manual-review`, `siu`.

### Frontend Structure
**Authenticated app pages** (`src/pages/`):
- `Dashboard` — claims queue with stat cards (new / open / pending / closed) and sortable table
- `ClaimDetail` — individual claim view and status management (`/claims/:id`)
- `Settings` — theme preferences (light/dark, accent color, sidebar color)
- `Admin` — admin-only operations
- `Landing` — public landing/info page
- `Callback` — Cognito OAuth callback handler

**Public (unauthenticated) pages** (`src/pages/public/`):
- `IntakePage` — 3-step FNOL wizard (loss info → contact → review → confirmation)

**Supporting:**
- `src/auth/` — Cognito token exchange, localStorage helpers, JWT decode (`cognito.ts`), env config (`config.ts`)
- `src/hooks/useAuth.ts` — reads and parses the stored JWT; no side effects
- `src/hooks/useUsers.ts` — fetches Cognito users (via `adminApi.ts`) for the Admin page
- `src/components/layout/` — `AppShell` (sidebar + header shell), `Sidebar`, `Header`
- `src/components/ui/` — primitive UI components (Button, Badge, Card, Input, Modal, ConfirmModal, DatePicker, TimePicker, EmptyState, Skeleton)
- `src/contexts/ThemeContext.tsx` — light/dark mode, accent color (5 options), sidebar color (5 options); all applied as CSS custom properties on `<html>`; persisted to `localStorage`
- `src/styles/` — `tokens.css` defines all CSS variables, `layout.css` handles the app shell layout, `ui.css` styles UI primitives
- `src/api/client.ts` — shared `apiFetch<T>()` helper: attaches the Cognito bearer token, reads `VITE_API_URL`, normalizes error responses
- `src/api/claimApi.ts` — typed API client for claim endpoints, built on `client.ts`
- `src/api/adminApi.ts` — `listUsers()`, calling `GET /admin/users`

`src/pages/Home.tsx` is an unrouted leftover from the original Cognito/Vite starter template — not reachable from `App.tsx`, safe to ignore or remove.

### Backend Structure
`backend/api/app.py` is the FastAPI entry point with Mangum adapter (`handler` = Lambda entrypoint).

**Routers** (all in `backend/api/`):
- `claim_api.py` — `GET /claims`, `GET /claims/{id}`, `PUT /claims/{id}/status` (authenticated); `POST /public/claims` (unauthenticated)
- `admin_api.py` — `GET /admin/users`: lists Cognito users with group membership, calling `cognito-idp:ListUsers`/`ListUsersInGroup` directly via boto3. Intentional exception to the repository-layer convention below — user data lives in Cognito, not DynamoDB.
- `agent_api.py` — `POST /agent/analyze/{claim_id}` — triggers the coordinator/subagent claim analysis (see [AI Claims Analyst](#ai-claims-analyst-backendservicesclaims_agent_servicepy))

**Layers:**
- `backend/repository/main_entry_repository.py` — all DynamoDB access; defines `EntityType` enum (includes `CLAIM`)
- `backend/services/claims_agent_service.py` — the coordinator/subagent agent logic behind `agent_api.py`
- `backend/weather_mcp/` — standalone MCP server (own Lambda, `WeatherMcpFunction`) wrapping Open-Meteo; called by the Loss Verification subagent over HTTP
- `backend/post_confirmation.py` — Cognito post-confirmation Lambda trigger (`PostConfirmationFunction`); auto-adds every newly confirmed user to the `Users` group

Auth: API Gateway Cognito Authorizer protects all routes by default. Public routes (`POST /public/claims`, `/health`) bypass the authorizer via explicit SAM event entries with `Auth: Authorizer: NONE`.

### Infrastructure (SAM)
`infrastructure/template.yaml` provisions:
- **Cognito User Pool** with `Admins` and `Users` groups, email-based sign-in, invite-only
- **Cognito User Pool Client** (no secret, SRP auth)
- **PostConfirmationFunction** — Lambda wired as the User Pool's `PostConfirmation` trigger
- **API Gateway** with Cognito Authorizer as default
- **API Lambda** (`ApiFunction`) running the FastAPI app
- **WeatherMcpFunction** — separate Lambda hosting the weather MCP server, routed at `/mcp-weather/{proxy+}`, `Auth: NONE`
- **DynamoDB** — `ClaimFlowMainEntry` table (single-table design)
- **CloudFront + S3** — hosts the compiled frontend SPA

Stack parameters accept only `qa` and `prod` for `EnvironmentName` — there is no deployed `dev` SAM stack; dev is local-only (see AWS Account & Environment Strategy above).

## Environment Variables

Frontend reads from `.env` (Vite prefix `VITE_`):
```
VITE_COGNITO_DOMAIN=       # e.g. claim-flow-qa.auth.us-east-1.amazoncognito.com
VITE_COGNITO_CLIENT_ID=
VITE_COGNITO_REDIRECT_URI= # must match Cognito app client callback URLs
VITE_COGNITO_LOGOUT_URI=
VITE_COGNITO_REGION=us-east-1
VITE_SYSTEM_NAME=Claim Flow
VITE_SYSTEM_LOGO=P&C Claims Workflow Orchestrator
VITE_API_URL=              # backend API base URL
```

Backend reads from Lambda environment variables (set in SAM template):
```
COGNITO_USER_POOL_ID=
ANTHROPIC_API_KEY=   # ApiFunction only; injected via a Secrets Manager dynamic reference, not set directly
WEATHER_MCP_URL=     # ApiFunction only; points at WeatherMcpFunction's /mcp-weather/mcp path
```

## Key Conventions

- **No UI component library** — all UI primitives are hand-rolled in `src/components/ui/` using CSS custom properties from `tokens.css`.
- **CSS custom properties over utility classes** — styling uses semantic tokens (`--color-accent`, `--color-text-muted`, etc.), not Tailwind or similar.
- **Single-table DynamoDB** — all entities share one table; always use the repository layer, never raw boto3 calls from routers.
- **Two Cognito groups** — `Admins` (elevated UI, admin nav visible) and `Users` (default for all authenticated users). Group membership comes from `cognito:groups` in the JWT.
- **Public routes** — the FNOL intake wizard and `POST /public/claims` are fully unauthenticated. Must be declared with `Auth: Authorizer: NONE` in SAM template events.
- **Invite-only auth** — users are created by admins only; group assignment on confirmation is automatic via `post_confirmation.py`, not manual.
- **No automated test suite** — no pytest/vitest/jest config or test files exist in this repo.
