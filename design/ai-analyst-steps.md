# AI Claims Analyst — Step-by-Step Call Trace

Source: `backend/services/claims_agent_service.py`.

This documents exactly what happens on one "Analyze with AI" click, in call order,
distinguishing **LLM calls** (`_client.messages.create`, i.e. `anthropic.AsyncAnthropic`)
from everything else (DynamoDB reads, the deterministic rules function, and MCP calls to
the standalone weather Lambda).

Every agent (coordinator and both subagents) runs the same generic loop, `_run_tool_loop`
(lines 108-163): call Claude → if it asked for a tool, run the tool and feed the result
back → repeat, up to `max_turns=6`, until Claude returns plain text instead of a tool
request. **One iteration of that loop = exactly one LLM call.** The call order below is
not hardcoded control flow — it's what each agent's system prompt tells Claude to do,
and Claude's own reasoning produces the sequence, turn by turn.

`analyze_claim(claim_id)` (line 321) is the entry point, called from `POST /agent/analyze/{claim_id}`.

---

## Coordinator — turn 1

**LLM call #1**
Loop: Coordinator (`_run_coordinator`, line 301)
Messages so far: `[user: "Analyze claim {id} and provide a complete adjuster recommendation."]`
Claude's move: requests tool `call_fraud_risk_subagent(claim_id)`

→ This tool isn't a plain function — it's a wrapper (`_call_fraud`, line 302) that runs an
entire nested agent loop and returns its final text as the "tool result."

---

## Fraud Risk subagent (nested loop, `_run_fraud_subagent`, line 175)

**LLM call #2** — subagent turn 1
Messages so far: `[user: "Assess fraud risk for claim {id}."]`
Claude's move: requests tool `get_claim_details(claim_id)`
Tool execution (no LLM): `_get_claim_details` → `MainEntryRepository.get_claim()` → DynamoDB read.

**LLM call #3** — subagent turn 2
Messages so far: turn 1 + the claim record as a tool result.
Claude's move: requests tool `assess_fraud_indicators(loss_type, estimated_amount, description)`
Tool execution (no LLM): `_assess_fraud_indicators` — a pure Python rules function. Flags
`estimated_amount > $50,000`, `loss_type == "liability"`, and red-flag keywords
(attorney, lawyer, whiplash, "pain and suffering", settlement) in the description; maps
the resulting risk level to a recommended path.

**LLM call #4** — subagent turn 3
Messages so far: turn 1 + turn 2 + the fraud-indicator result.
Claude's move: returns plain text — a 2-4 sentence fraud risk summary. `stop_reason != tool_use`, loop ends.

Subagent returns this text to the coordinator as the result of `call_fraud_risk_subagent`.

---

## Coordinator — turn 2

**LLM call #5**
Messages so far: turn 1 + the fraud subagent's summary as a tool result.
Claude's move: requests tool `call_weather_verification_subagent(claim_id)`

→ Same pattern: `_call_weather` (line 305) runs the Loss Verification subagent's full nested loop.

---

## Loss Verification subagent (nested loop, `_run_weather_subagent`, line 205)

Before any LLM call, non-LLM MCP setup happens:
- Opens a `streamablehttp_client` connection to `WEATHER_MCP_URL` (the standalone
  `WeatherMcpFunction` Lambda).
- `session.initialize()` — MCP handshake.
- `session.list_tools()` — discovers `geocode_location` and `get_historical_weather` at
  runtime (these are not hardcoded in this file; their schemas come from the MCP server).
- Builds this subagent's tool list as `[get_claim_details] + <the two discovered MCP tools>`.

**LLM call #6** — subagent turn 1
Messages so far: `[user: "Verify the reported loss conditions for claim {id}."]`
Claude's move: requests tool `get_claim_details(claim_id)`
Tool execution (no LLM): DynamoDB read, same `_get_claim_details` as the fraud subagent uses.

**LLM call #7** — subagent turn 2
Messages so far: turn 1 + the claim record (location, date_of_loss).
Claude's move: requests tool `geocode_location(location)` — an MCP-sourced tool.
Tool execution (no LLM): `session.call_tool("geocode_location", ...)` → HTTP call to the
weather Lambda → Open-Meteo geocoding API → returns coordinates.

**LLM call #8** — subagent turn 3
Messages so far: turn 1 + turn 2 + the coordinates.
Claude's move: requests tool `get_historical_weather(lat, lon, date)` — an MCP-sourced tool.
Tool execution (no LLM): `session.call_tool("get_historical_weather", ...)` → HTTP call to
the weather Lambda → Open-Meteo archive API → returns historical conditions for that date/location.

**LLM call #9** — subagent turn 4
Messages so far: turn 1 + turn 2 + turn 3 + the historical weather record.
Claude's move: returns plain text — comparing the observed weather to the claimant's
account and `loss_type`. `stop_reason != tool_use`, loop ends.

Subagent closes the MCP session and returns this text to the coordinator as the result
of `call_weather_verification_subagent`.

---

## Coordinator — turn 3 (final)

**LLM call #10**
Messages so far: turn 1 + turn 2 + both subagents' summaries as tool results.
Claude's move: returns plain text — the final synthesized recommendation, using the five
fixed headings (**Triage Decision**, **Risk Assessment**, **Weather Verification**,
**Suggested Next Steps**, **Missing Information**). `stop_reason != tool_use`, loop ends.

`_run_coordinator` returns this text as `analysis`. `analyze_claim` returns
`(analysis, trace)`. The API layer caches both onto the claim record
(`ai_analysis`, `ai_analysis_trace`, `ai_analysis_at`).

---

## Totals

| | LLM calls | Non-LLM calls |
|---|---|---|
| Coordinator | 3 (call fraud, call weather, synthesize) | 0 |
| Fraud Risk subagent | 3 | 2 (DynamoDB read, rules function) |
| Loss Verification subagent | 4 | 1 MCP setup (`list_tools`) + 3 (DynamoDB read, 2× MCP `call_tool`) |
| **Total** | **10** | — |

**Sequential, not parallel.** `_run_tool_loop`'s tool-execution step is a plain `for`
loop with `await` inside it (line 137), not `asyncio.gather`, and the coordinator's
prompt calls the two subagents one after another anyway. All 10 LLM calls, and both
subagent runs, happen strictly in series — nothing here overlaps in wall-clock time.

**Every tool call across all three agents is recorded** to the flat `trace` list
(`_run_tool_loop`, line 146) with `agent`, `tool`, `input`, `output`, and `source`
(`"internal"` or `"mcp"`) — this is what backs the Agent Trace panel in the UI.
