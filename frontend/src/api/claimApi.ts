import { getIdToken } from '../auth/cognito'

const API = import.meta.env.VITE_API_URL

export interface ClaimIntake {
  loss_type: string
  date_of_loss: string
  time_of_loss?: string
  location: string
  description: string
  name: string
  email: string
  phone?: string
  other_parties?: string
  damage_description: string
  estimated_amount?: string
  vehicle_info?: string
  doc_names: string[]
}

export interface Claim {
  ClaimId: string
  loss_type: string
  date_of_loss: string
  name: string
  email?: string
  phone?: string
  location?: string
  description?: string
  damage_description?: string
  estimated_amount?: string
  vehicle_info?: string
  triage: 'straight-through' | 'manual-review' | 'siu'
  status: 'new' | 'in-progress' | 'flagged' | 'closed'
  reported_at: string
}

export async function submitClaim(data: ClaimIntake): Promise<Claim> {
  const res = await fetch(`${API}/public/claims`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  if (!res.ok) throw new Error('Failed to submit claim')
  return res.json()
}

export async function listClaims(): Promise<Claim[]> {
  const res = await fetch(`${API}/claims`, {
    headers: { Authorization: `Bearer ${getIdToken()}` },
  })
  if (!res.ok) throw new Error('Failed to load claims')
  return res.json()
}

export async function getClaim(claimId: string): Promise<Claim> {
  const res = await fetch(`${API}/claims/${encodeURIComponent(claimId)}`, {
    headers: { Authorization: `Bearer ${getIdToken()}` },
  })
  if (!res.ok) throw new Error('Failed to load claim')
  return res.json()
}

export interface TraceEvent {
  agent: string
  type: 'tool_call' | 'subagent_result'
  tool?: string
  input?: Record<string, unknown>
  output?: unknown
  source?: 'internal' | 'mcp'
  summary?: string
}

export interface AnalysisResult {
  analysis: string
  trace: TraceEvent[]
  analyzed_at: string
  cached: boolean
}

export async function analyzeClaim(claimId: string, force = false): Promise<AnalysisResult> {
  const url = `${API}/agent/analyze/${encodeURIComponent(claimId)}${force ? '?force=true' : ''}`
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${getIdToken()}` },
  })
  if (!res.ok) throw new Error('Agent analysis failed')
  return res.json()
}
