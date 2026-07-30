from datetime import datetime, timezone
from typing import Any, Dict, List

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from repository.main_entry_repository import MainEntryRepository
from services.claims_agent_service import analyze_claim

router = APIRouter(prefix="/agent", tags=["agent"])
_repo = MainEntryRepository()


class AnalysisResponse(BaseModel):
    claim_id: str
    analysis: str
    trace: List[Dict[str, Any]]
    analyzed_at: str
    cached: bool


@router.post("/analyze/{claim_id}", response_model=AnalysisResponse)
async def analyze_claim_route(claim_id: str, force: bool = Query(default=False)):
    """AI-powered claim analysis: a coordinator agent (direct Anthropic API)
    delegating to a fraud-risk subagent and a loss-verification subagent, the
    latter backed by an external weather MCP server.
    Pass ?force=true to bypass the cached result and re-run the agents."""
    claim = _repo.get_claim(claim_id)
    if claim is None:
        raise HTTPException(status_code=404, detail="Claim not found")

    if not force and claim.get("ai_analysis"):
        return AnalysisResponse(
            claim_id=claim_id,
            analysis=claim["ai_analysis"],
            trace=claim.get("ai_analysis_trace", []),
            analyzed_at=claim["ai_analysis_at"],
            cached=True,
        )

    try:
        analysis, trace = await analyze_claim(claim_id)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    analyzed_at = datetime.now(timezone.utc).isoformat()
    _repo.update_claim(
        claim_id,
        {"ai_analysis": analysis, "ai_analysis_trace": trace, "ai_analysis_at": analyzed_at},
    )

    return AnalysisResponse(
        claim_id=claim_id,
        analysis=analysis,
        trace=trace,
        analyzed_at=analyzed_at,
        cached=False,
    )
