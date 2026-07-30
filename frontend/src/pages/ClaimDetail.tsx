import { useState, useEffect } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import Badge from '../components/ui/Badge'
import { ArrowLeft, AlertTriangle, CheckCircle, Info, Sparkles, Loader, ChevronDown, ChevronRight, Wrench, RefreshCw } from 'lucide-react'
import { analyzeClaim, getClaim, type Claim, type AnalysisResult, type TraceEvent } from '../api/claimApi'
import Markdown from 'react-markdown'

const TABS = ['Summary', 'Timeline', 'Policy / Coverage', 'Documents', 'Risk Flags'] as const
type Tab = typeof TABS[number]

// ── Helpers ────────────────────────────────────────────────────────────────

function triageBadge(triage: Claim['triage']) {
  if (triage === 'straight-through') return <Badge variant="success">Straight-Through</Badge>
  if (triage === 'siu')              return <Badge variant="danger">SIU Review</Badge>
  return <Badge variant="warning">Manual Review</Badge>
}

function statusBadge(status: Claim['status']) {
  if (status === 'new')         return <Badge variant="info">New</Badge>
  if (status === 'in-progress') return <Badge variant="warning">In Progress</Badge>
  if (status === 'flagged')     return <Badge variant="danger">Flagged</Badge>
  return <Badge variant="neutral">Closed</Badge>
}

const TIMELINE = [
  { ts: 'Jun 15, 2024  9:12 AM', actor: 'Claimant', event: 'FNOL submitted via online portal' },
  { ts: 'Jun 15, 2024  9:13 AM', actor: 'System',   event: 'Policy verified — active coverage confirmed' },
  { ts: 'Jun 15, 2024  9:13 AM', actor: 'Agent',    event: 'Triage assigned: Straight-Through' },
  { ts: 'Jun 15, 2024  9:14 AM', actor: 'Agent',    event: 'Claim package generated and routed to adjuster queue' },
  { ts: 'Jun 15, 2024 10:30 AM', actor: 'System',   event: 'Assigned to adjuster' },
]

const COVERAGES = [
  { name: 'Collision',                   limit: '$50,000',              deductible: '$500',  active: true },
  { name: 'Bodily Injury Liability',     limit: '$100,000 / $300,000',  deductible: '—',     active: true },
  { name: 'Property Damage Liability',   limit: '$100,000',             deductible: '—',     active: true },
  { name: 'Uninsured Motorist',          limit: '$50,000 / $100,000',   deductible: '$250',  active: true },
  { name: 'Comprehensive',               limit: '$50,000',              deductible: '$500',  active: true },
]

const DOCUMENTS = [
  { name: 'photos_front_damage.jpg',  type: 'Photo',        size: '2.4 MB', uploaded: 'Jun 15, 2024' },
  { name: 'police_report_240612.pdf', type: 'Police Report', size: '182 KB', uploaded: 'Jun 15, 2024' },
  { name: 'repair_estimate_shop.pdf', type: 'Estimate',     size: '310 KB', uploaded: 'Jun 15, 2024' },
]

const RISK_FLAGS = [
  {
    level: 'low' as const,
    label: 'Corroborating evidence present',
    detail: 'Police report and photos uploaded. Supports claimant account.',
  },
  {
    level: 'low' as const,
    label: 'No prior losses in 3 years',
    detail: 'Clean claims history on this policy.',
  },
  {
    level: 'medium' as const,
    label: 'Estimate from non-network vendor',
    detail: 'Repair estimate is from an out-of-network shop. Consider requiring a second estimate from a preferred provider.',
  },
]

// ── Shared styles ──────────────────────────────────────────────────────────

const card: React.CSSProperties = {
  background: 'var(--color-bg)',
  border: '1px solid var(--color-border)',
  borderRadius: 10,
  padding: 20,
  marginBottom: 16,
  boxShadow: 'var(--shadow-xs)',
}

const sectionHead: React.CSSProperties = {
  margin: '0 0 14px',
  fontSize: 13,
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '.05em',
  color: 'var(--color-text-muted)',
}

const dl: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '150px 1fr',
  gap: '8px 16px',
  margin: 0,
  fontSize: 14,
}

// ── AI Claims Analyst panel ────────────────────────────────────────────────

function agentLabel(agent: string) {
  if (agent === 'Coordinator') return <Badge variant="info">Coordinator</Badge>
  if (agent === 'Fraud Risk Subagent') return <Badge variant="warning">Fraud Risk Subagent</Badge>
  if (agent === 'Loss Verification Subagent') return <Badge variant="neutral">Loss Verification Subagent</Badge>
  return <Badge variant="neutral">{agent}</Badge>
}

function AgentTrace({ trace }: { trace: TraceEvent[] }) {
  const groups: { agent: string; events: TraceEvent[] }[] = []
  for (const event of trace) {
    const group = groups.find((g) => g.agent === event.agent)
    if (group) group.events.push(event)
    else groups.push({ agent: event.agent, events: [event] })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {groups.map((group, i) => (
        <div key={i}>
          <div style={{ marginBottom: 6 }}>{agentLabel(group.agent)}</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingLeft: 4 }}>
            {group.events.map((event, j) =>
              event.type === 'tool_call' ? (
                <div key={j} style={{ display: 'flex', alignItems: 'flex-start', gap: 6, fontSize: 12, color: 'var(--color-text-muted)' }}>
                  <Wrench size={12} style={{ marginTop: 2, flexShrink: 0 }} />
                  <span>
                    <code style={{ color: 'var(--color-text)' }}>{event.tool}</code>
                    {event.source === 'mcp' && (
                      <span style={{ marginLeft: 6 }}>
                        <Badge variant="success">MCP</Badge>
                      </span>
                    )}
                    {typeof event.input === 'object' && event.input && Object.keys(event.input).length > 0 && (
                      <span style={{ marginLeft: 6, fontFamily: 'monospace', fontSize: 11 }}>
                        ({Object.entries(event.input).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(', ')})
                      </span>
                    )}
                  </span>
                </div>
              ) : (
                <div key={j} style={{ fontSize: 12, color: 'var(--color-text-muted)', fontStyle: 'italic' }}>
                  "{event.summary}"
                </div>
              )
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

function AgentPanel({ claimId }: { claimId: string }) {
  const [status, setStatus] = useState<'idle' | 'loading' | 'done' | 'error'>('idle')
  const [result, setResult] = useState<AnalysisResult | null>(null)
  const [showTrace, setShowTrace] = useState(false)

  async function runAnalysis(force = false) {
    setStatus('loading')
    try {
      const data = await analyzeClaim(claimId, force)
      setResult(data)
      setStatus('done')
    } catch {
      setStatus('error')
    }
  }

  function formatDate(iso: string) {
    return new Date(iso).toLocaleString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit',
    })
  }

  const btnStyle: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 6,
    padding: '8px 16px', borderRadius: 6, border: 'none',
    background: 'var(--color-accent, #6366f1)', color: '#fff',
    fontSize: 13, fontWeight: 600, cursor: 'pointer', width: '100%',
    justifyContent: 'center',
  }

  const reanalyzeStyle: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 5,
    fontSize: 14, border: 'none', background: 'none',
    color: 'var(--color-accent)', cursor: 'pointer', padding: 0, fontWeight: 600,
  }

  const ReanalyzeButton = () => (
    <button onClick={() => runAnalysis(true)} style={reanalyzeStyle}>
      <RefreshCw size={14} />
      Re-analyze
    </button>
  )

  return (
    <div style={{ ...card, borderLeft: '3px solid var(--color-accent, #6366f1)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
        <Sparkles size={16} color="var(--color-accent, #6366f1)" />
        <h3 style={{ ...sectionHead, margin: 0 }}>AI Claims Analyst</h3>
        <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--color-text-muted)' }}>Claude · Multi-Agent</span>
      </div>

      {status === 'idle' && (
        <>
          <p style={{ margin: '0 0 14px', fontSize: 13, color: 'var(--color-text-muted)', lineHeight: 1.6 }}>
            Run an AI-powered analysis of this claim — fraud risk assessment, triage recommendation, and suggested next steps.
          </p>
          <button onClick={() => runAnalysis(false)} style={btnStyle}>
            <Sparkles size={13} />
            Analyze with AI
          </button>
        </>
      )}

      {status === 'loading' && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, padding: '24px 0', color: 'var(--color-text-muted)' }}>
          <Loader size={20} style={{ animation: 'spin 1s linear infinite' }} />
          <span style={{ fontSize: 13 }}>Analyzing claim with Claude…</span>
        </div>
      )}

      {status === 'error' && (
        <p style={{ margin: 0, fontSize: 13, color: '#ef4444' }}>
          Analysis failed. Check that the backend is running and ANTHROPIC_API_KEY / WEATHER_MCP_URL are configured.
        </p>
      )}

      {status === 'done' && result && (
        <>
          <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '10px 0', marginBottom: 12, borderTop: '1px solid var(--color-border)', borderBottom: '1px solid var(--color-border)' }}>
            <ReanalyzeButton />
          </div>

          <div style={{ fontSize: 13, lineHeight: 1.75, color: 'var(--color-text)' }} className="agent-output">
            <Markdown>{result.analysis}</Markdown>
          </div>

          {result.trace.length > 0 && (
            <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--color-border)' }}>
              <button
                onClick={() => setShowTrace((v) => !v)}
                style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, border: 'none', background: 'none', color: 'var(--color-text-muted)', cursor: 'pointer', padding: 0, fontWeight: 500 }}
              >
                {showTrace ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                Agent Trace ({result.trace.length} tool calls)
              </button>
              {showTrace && (
                <div style={{ marginTop: 12 }}>
                  <AgentTrace trace={result.trace} />
                </div>
              )}
            </div>
          )}

          <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--color-border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
              {result.cached ? 'Cached · ' : ''}{formatDate(result.analyzed_at)}
            </span>
            <ReanalyzeButton />
          </div>
        </>
      )}
    </div>
  )
}

// ── Tab: Summary ───────────────────────────────────────────────────────────

function SummaryTab({ claim }: { claim: Claim }) {
  const dt = (label: string) => (
    <dt style={{ color: 'var(--color-text-muted)', fontWeight: 500 }}>{label}</dt>
  )
  const dd = (val: string | undefined) => (
    <dd style={{ margin: 0 }}>{val || '—'}</dd>
  )

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 20, alignItems: 'start' }}>
      <div>
        <div style={card}>
          <h3 style={sectionHead}>Claimant</h3>
          <dl style={dl}>
            {dt('Name')}{dd(claim.name)}
            {dt('Email')}{dd(claim.email)}
            {dt('Phone')}{dd(claim.phone)}
          </dl>
        </div>

        <div style={card}>
          <h3 style={sectionHead}>Incident Details</h3>
          <dl style={{ ...dl, marginBottom: claim.description ? 14 : 0 }}>
            {dt('Date of Loss')}{dd(claim.date_of_loss)}
            {dt('Loss Type')}{dd(claim.loss_type)}
            {dt('Location')}{dd(claim.location)}
            {dt('Est. Amount')}{dd(claim.estimated_amount)}
          </dl>
          {claim.description && <>
            <div style={{ fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--color-text-muted)', marginBottom: 6 }}>Claimant Statement</div>
            <p style={{ margin: 0, fontSize: 14, lineHeight: 1.65, color: 'var(--color-text)', fontStyle: 'italic' }}>
              "{claim.description}"
            </p>
          </>}
          {claim.damage_description && <>
            <div style={{ fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--color-text-muted)', margin: '14px 0 6px' }}>Damage Description</div>
            <p style={{ margin: 0, fontSize: 14, lineHeight: 1.65, color: 'var(--color-text)' }}>
              {claim.damage_description}
            </p>
          </>}
        </div>
      </div>

      <AgentPanel claimId={claim.ClaimId} />
    </div>
  )
}

// ── Tab: Timeline ──────────────────────────────────────────────────────────

function TimelineTab() {
  return (
    <div style={{ maxWidth: 600 }}>
      {TIMELINE.map((item, i) => (
        <div key={i} style={{ display: 'flex', gap: 16, paddingBottom: 24 }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 10 }}>
            <div style={{ width: 10, height: 10, borderRadius: '50%', background: 'var(--color-accent, #6366f1)', flexShrink: 0, marginTop: 3 }} />
            {i < TIMELINE.length - 1 && <div style={{ width: 1, flex: 1, background: 'var(--color-border)', marginTop: 4 }} />}
          </div>
          <div>
            <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 3 }}>{item.event}</div>
            <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
              <span style={{ fontFamily: 'monospace' }}>{item.ts}</span>
              <span style={{ margin: '0 6px', opacity: .4 }}>·</span>
              {item.actor}
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

// ── Tab: Policy / Coverage ─────────────────────────────────────────────────

function PolicyTab() {
  return (
    <>
      <div style={card}>
        <h3 style={sectionHead}>Policy Overview</h3>
        <dl style={dl}>
          <dt style={{ color: 'var(--color-text-muted)', fontWeight: 500 }}>Policy #</dt>
          <dd style={{ margin: 0, fontFamily: 'monospace', fontSize: 13 }}>POL-2021-887634</dd>
          <dt style={{ color: 'var(--color-text-muted)', fontWeight: 500 }}>Policyholder</dt>
          <dd style={{ margin: 0 }}>Jane Smith</dd>
          <dt style={{ color: 'var(--color-text-muted)', fontWeight: 500 }}>Effective</dt>
          <dd style={{ margin: 0 }}>Jan 1, 2024 — Dec 31, 2024</dd>
          <dt style={{ color: 'var(--color-text-muted)', fontWeight: 500 }}>Status</dt>
          <dd style={{ margin: 0 }}><Badge variant="success">Active</Badge></dd>
          <dt style={{ color: 'var(--color-text-muted)', fontWeight: 500 }}>Insured Vehicle</dt>
          <dd style={{ margin: 0 }}>2021 Honda Accord — <span style={{ fontFamily: 'monospace', fontSize: 13 }}>1HGBH41JXMN109186</span></dd>
        </dl>
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Coverage</th>
              <th>Limit</th>
              <th>Deductible</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {COVERAGES.map(c => (
              <tr key={c.name}>
                <td style={{ fontWeight: 500 }}>{c.name}</td>
                <td className="td-muted">{c.limit}</td>
                <td className="td-muted">{c.deductible}</td>
                <td><Badge variant={c.active ? 'success' : 'neutral'}>{c.active ? 'Active' : 'Inactive'}</Badge></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

// ── Tab: Documents ─────────────────────────────────────────────────────────

function DocumentsTab() {
  return (
    <div>
      {DOCUMENTS.map(doc => (
        <div key={doc.name} style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '14px 0', borderBottom: '1px solid var(--color-border)' }}>
          <span style={{ fontSize: 26 }}>{doc.type === 'Photo' ? '🖼️' : '📄'}</span>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 14, fontWeight: 500 }}>{doc.name}</div>
            <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 2 }}>
              {doc.type} · {doc.size} · Uploaded {doc.uploaded}
            </div>
          </div>
          <button style={{ fontSize: 13, border: 'none', background: 'none', color: 'var(--color-accent)', cursor: 'pointer', padding: 0 }}>
            View
          </button>
        </div>
      ))}
    </div>
  )
}

// ── Tab: Risk Flags ────────────────────────────────────────────────────────

function RiskFlagsTab() {
  function icon(level: 'low' | 'medium' | 'high') {
    if (level === 'low')    return <CheckCircle size={16} color="#22c55e" />
    if (level === 'medium') return <Info size={16} color="#f59e0b" />
    return <AlertTriangle size={16} color="#ef4444" />
  }

  function borderColor(level: 'low' | 'medium' | 'high') {
    if (level === 'low')    return '#22c55e'
    if (level === 'medium') return '#f59e0b'
    return '#ef4444'
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 680 }}>
      {RISK_FLAGS.map((flag, i) => (
        <div key={i} style={{ padding: 16, borderRadius: 8, border: `1.5px solid ${borderColor(flag.level)}`, background: 'var(--color-surface)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            {icon(flag.level)}
            <span style={{ fontSize: 14, fontWeight: 600 }}>{flag.label}</span>
          </div>
          <p style={{ margin: 0, fontSize: 13, color: 'var(--color-text-muted)', paddingLeft: 24 }}>{flag.detail}</p>
        </div>
      ))}
    </div>
  )
}

// ── Main ───────────────────────────────────────────────────────────────────

export default function ClaimDetail() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const [tab, setTab] = useState<Tab>('Summary')
  const [claim, setClaim] = useState<Claim | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  useEffect(() => {
    if (!id) return
    setLoading(true)
    getClaim(id)
      .then(setClaim)
      .catch(() => setError(true))
      .finally(() => setLoading(false))
  }, [id])

  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 40, color: 'var(--color-text-muted)' }}>
      <Loader size={16} style={{ animation: 'spin 1s linear infinite' }} />
      Loading claim…
    </div>
  )

  if (error || !claim) return (
    <p style={{ padding: 40, color: '#ef4444' }}>Claim not found.</p>
  )

  return (
    <>
      <button
        onClick={() => navigate('/')}
        style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, border: 'none', background: 'none', cursor: 'pointer', color: 'var(--color-text-muted)', padding: '0 0 16px', marginBottom: 4 }}
      >
        <ArrowLeft size={14} />
        Back to queue
      </button>

      <div className="page-header" style={{ marginBottom: 20 }}>
        <div className="page-header-text">
          <h2 className="page-title" style={{ fontFamily: 'monospace' }}>{claim.ClaimId}</h2>
          <p className="page-subtitle">{claim.name} · {claim.loss_type} · {claim.date_of_loss}</p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {triageBadge(claim.triage)}
          {statusBadge(claim.status)}
        </div>
      </div>

      {/* Tab bar */}
      <div style={{ display: 'flex', borderBottom: '1px solid var(--color-border)', marginBottom: 24 }}>
        {TABS.map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              padding: '9px 18px', fontSize: 14, border: 'none', background: 'none', cursor: 'pointer',
              fontWeight: tab === t ? 600 : 400,
              color: tab === t ? 'var(--color-accent)' : 'var(--color-text-muted)',
              borderBottom: tab === t ? '2px solid var(--color-accent)' : '2px solid transparent',
              marginBottom: -1,
              whiteSpace: 'nowrap',
            }}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === 'Summary'           && <SummaryTab claim={claim} />}
      {tab === 'Timeline'          && <TimelineTab />}
      {tab === 'Policy / Coverage' && <PolicyTab />}
      {tab === 'Documents'         && <DocumentsTab />}
      {tab === 'Risk Flags'        && <RiskFlagsTab />}
    </>
  )
}
