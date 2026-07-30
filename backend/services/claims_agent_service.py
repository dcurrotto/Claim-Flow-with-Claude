import json
import os
from decimal import Decimal
from typing import Any, Awaitable, Callable, Dict, List, Optional

from anthropic import AsyncAnthropic
from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

from repository.main_entry_repository import MainEntryRepository

_MODEL = "claude-sonnet-5"
_WEATHER_MCP_URL = os.environ.get("WEATHER_MCP_URL", "http://127.0.0.1:8001/mcp")

_client = AsyncAnthropic()


def _serialize(obj: Any) -> Any:
    if isinstance(obj, Decimal):
        return float(obj)
    if isinstance(obj, dict):
        return {k: _serialize(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_serialize(v) for v in obj]
    return obj


# ── Shared tools (used directly by both subagents) ─────────────────────────

_GET_CLAIM_DETAILS_SCHEMA = {
    "name": "get_claim_details",
    "description": "Retrieve full claim details from the database by claim ID.",
    "input_schema": {
        "type": "object",
        "properties": {"claim_id": {"type": "string", "description": "e.g. CLM-2026-A3F8B2C1"}},
        "required": ["claim_id"],
    },
}


async def _get_claim_details(claim_id: str) -> Dict[str, Any]:
    repo = MainEntryRepository()
    claim = repo.get_claim(claim_id)
    if claim is None:
        return {"error": f"Claim {claim_id} not found"}
    return _serialize(claim)


_ASSESS_FRAUD_SCHEMA = {
    "name": "assess_fraud_indicators",
    "description": "Apply rules-based fraud indicator checks to a claim.",
    "input_schema": {
        "type": "object",
        "properties": {
            "loss_type": {"type": "string", "description": "auto, property, liability, etc."},
            "estimated_amount": {"type": "string", "description": "Dollar amount, e.g. '$12,000' or '15000'"},
            "description": {"type": "string", "description": "The claimant's incident description"},
        },
        "required": ["loss_type", "estimated_amount", "description"],
    },
}


async def _assess_fraud_indicators(loss_type: str, estimated_amount: str, description: str) -> Dict[str, Any]:
    risk_factors = []
    risk_level = "low"

    amount = 0.0
    if estimated_amount:
        try:
            amount = float(estimated_amount.replace("$", "").replace(",", "").strip())
        except (ValueError, AttributeError):
            pass

    if amount > 50_000:
        risk_factors.append(f"High claim amount (${amount:,.0f} exceeds $50k SIU threshold)")
        risk_level = "high"

    if loss_type == "liability":
        risk_factors.append("Liability claims carry elevated fraud exposure")
        if risk_level != "high":
            risk_level = "medium"

    red_flag_terms = ["attorney", "lawyer", "whiplash", "pain and suffering", "settlement"]
    desc_lower = (description or "").lower()
    matched = [t for t in red_flag_terms if t in desc_lower]
    if matched:
        risk_factors.append(f"Fraud-correlated language detected: {', '.join(matched)}")
        if risk_level == "low":
            risk_level = "medium"

    if not risk_factors:
        risk_factors.append("No automated fraud indicators triggered")

    path_map = {"low": "straight-through", "medium": "manual-review", "high": "siu"}
    return {
        "risk_level": risk_level,
        "risk_factors": risk_factors,
        "recommended_path": path_map[risk_level],
    }


# ── Generic Claude tool-use loop, shared by subagents and the coordinator ──

ToolImpl = Callable[..., Awaitable[Any]]


async def _run_tool_loop(
    *,
    agent_name: str,
    system_prompt: str,
    tools: List[Dict[str, Any]],
    tool_impls: Dict[str, ToolImpl],
    user_message: str,
    trace: List[Dict[str, Any]],
    tool_sources: Optional[Dict[str, str]] = None,
    max_turns: int = 6,
) -> str:
    tool_sources = tool_sources or {}
    messages: List[Dict[str, Any]] = [{"role": "user", "content": user_message}]

    for _ in range(max_turns):
        response = await _client.messages.create(
            model=_MODEL,
            max_tokens=1500,
            system=system_prompt,
            tools=tools,
            messages=messages,
        )

        if response.stop_reason != "tool_use":
            return "".join(block.text for block in response.content if block.type == "text")

        messages.append({"role": "assistant", "content": response.content})

        tool_results = []
        for block in response.content:
            if block.type != "tool_use":
                continue

            try:
                output = await tool_impls[block.name](**block.input)
            except Exception as e:
                output = {"error": str(e)}

            trace.append({
                "agent": agent_name,
                "type": "tool_call",
                "tool": block.name,
                "input": block.input,
                "output": output,
                "source": tool_sources.get(block.name, "internal"),
            })

            tool_results.append({
                "type": "tool_result",
                "tool_use_id": block.id,
                "content": json.dumps(output),
            })

        messages.append({"role": "user", "content": tool_results})

    return "Analysis incomplete — subagent exceeded its maximum number of tool-use turns."


# ── Fraud Risk subagent ──────────────────────────────────────────────────

_FRAUD_SUBAGENT_PROMPT = """You are a fraud-risk analyst subagent for a P&C claims system.
Given a claim ID:
1. Call get_claim_details to retrieve the claim.
2. Call assess_fraud_indicators with its loss_type, estimated_amount, and description.
3. Return a concise 2-4 sentence summary of the fraud risk level and the key factors driving it."""


async def _run_fraud_subagent(claim_id: str, trace: List[Dict[str, Any]]) -> str:
    result = await _run_tool_loop(
        agent_name="Fraud Risk Subagent",
        system_prompt=_FRAUD_SUBAGENT_PROMPT,
        tools=[_GET_CLAIM_DETAILS_SCHEMA, _ASSESS_FRAUD_SCHEMA],
        tool_impls={
            "get_claim_details": _get_claim_details,
            "assess_fraud_indicators": _assess_fraud_indicators,
        },
        user_message=f"Assess fraud risk for claim {claim_id}.",
        trace=trace,
    )
    trace.append({"agent": "Fraud Risk Subagent", "type": "subagent_result", "summary": result})
    return result


# ── Loss Verification subagent — calls the standalone weather MCP server ──

_WEATHER_SUBAGENT_PROMPT = """You are a loss-verification subagent for a P&C claims system.
Given a claim ID:
1. Call get_claim_details to retrieve the claim's location and date_of_loss.
2. Call geocode_location with a general locality extracted from the claim's location
   (city and state — not the full street address).
3. Call get_historical_weather with the resulting coordinates and the date_of_loss.
4. Compare the observed weather conditions to the claimant's description and loss_type.
   Return a concise 2-4 sentence summary noting whether the weather record supports or
   contradicts a weather-related loss claim (e.g. storm, hurricane, flood, wind, hail).
   If the loss type isn't weather-related, say so briefly and skip the comparison."""


async def _run_weather_subagent(claim_id: str, trace: List[Dict[str, Any]]) -> str:
    async with streamablehttp_client(_WEATHER_MCP_URL) as (read, write, _):
        async with ClientSession(read, write) as session:
            await session.initialize()
            mcp_tools = await session.list_tools()

            tools = [_GET_CLAIM_DETAILS_SCHEMA] + [
                {"name": t.name, "description": t.description or "", "input_schema": t.inputSchema}
                for t in mcp_tools.tools
            ]

            def _make_mcp_tool_impl(tool_name: str) -> ToolImpl:
                async def _impl(**kwargs: Any) -> Any:
                    result = await session.call_tool(tool_name, kwargs)
                    text = "".join(c.text for c in result.content if c.type == "text")
                    try:
                        return json.loads(text)
                    except json.JSONDecodeError:
                        return {"raw": text}

                return _impl

            tool_impls: Dict[str, ToolImpl] = {"get_claim_details": _get_claim_details}
            tool_sources: Dict[str, str] = {}
            for t in mcp_tools.tools:
                tool_impls[t.name] = _make_mcp_tool_impl(t.name)
                tool_sources[t.name] = "mcp"

            result = await _run_tool_loop(
                agent_name="Loss Verification Subagent",
                system_prompt=_WEATHER_SUBAGENT_PROMPT,
                tools=tools,
                tool_impls=tool_impls,
                user_message=f"Verify the reported loss conditions for claim {claim_id}.",
                trace=trace,
                tool_sources=tool_sources,
            )

    trace.append({"agent": "Loss Verification Subagent", "type": "subagent_result", "summary": result})
    return result


# ── Coordinator ──────────────────────────────────────────────────────────

_COORDINATOR_PROMPT = """You are an expert P&C (Property & Casualty) Claims Analyst AI for Claim Flow,
coordinating two specialist subagents to help an adjuster make a fast, well-informed decision.

Given a claim ID:
1. Call call_fraud_risk_subagent to get a fraud/risk assessment.
2. Call call_weather_verification_subagent to check whether the claimed conditions match
   the historical weather record for the loss date and location.
3. Synthesize both findings into a single adjuster recommendation.

Your response must use these exact headings:

**Triage Decision**
State the recommended handling path (Straight-Through Processing, Manual Review, or SIU Referral)
and a one-sentence rationale. If the two subagents disagree, or if the weather record
contradicts the claimant's account, favor Manual Review or SIU Referral and say why.

**Risk Assessment**
Summarize the fraud subagent's findings — risk level and flags.

**Weather Verification**
Summarize the loss-verification subagent's findings.

**Suggested Next Steps**
3-5 numbered, concrete, actionable items for the adjuster.

**Missing Information**
List anything needed to complete the claim, or state "None — package is complete."

Be concise and professional. This is read by an adjuster who needs to act quickly."""

_COORDINATOR_TOOLS = [
    {
        "name": "call_fraud_risk_subagent",
        "description": "Delegate to the fraud-risk subagent, which retrieves the claim and runs a rules-based fraud check.",
        "input_schema": {
            "type": "object",
            "properties": {"claim_id": {"type": "string"}},
            "required": ["claim_id"],
        },
    },
    {
        "name": "call_weather_verification_subagent",
        "description": "Delegate to the loss-verification subagent, which cross-references the claim's date/location against historical weather data via an external MCP server.",
        "input_schema": {
            "type": "object",
            "properties": {"claim_id": {"type": "string"}},
            "required": ["claim_id"],
        },
    },
]


async def _run_coordinator(claim_id: str, trace: List[Dict[str, Any]]) -> str:
    async def _call_fraud(claim_id: str) -> Dict[str, Any]:
        return {"result": await _run_fraud_subagent(claim_id, trace)}

    async def _call_weather(claim_id: str) -> Dict[str, Any]:
        return {"result": await _run_weather_subagent(claim_id, trace)}

    return await _run_tool_loop(
        agent_name="Coordinator",
        system_prompt=_COORDINATOR_PROMPT,
        tools=_COORDINATOR_TOOLS,
        tool_impls={
            "call_fraud_risk_subagent": _call_fraud,
            "call_weather_verification_subagent": _call_weather,
        },
        user_message=f"Analyze claim {claim_id} and provide a complete adjuster recommendation.",
        trace=trace,
    )


async def analyze_claim(claim_id: str) -> tuple[str, List[Dict[str, Any]]]:
    trace: List[Dict[str, Any]] = []
    analysis = await _run_coordinator(claim_id, trace)
    return analysis, trace
