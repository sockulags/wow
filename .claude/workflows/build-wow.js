export const meta = {
  name: 'build-wow',
  description: 'Deliver the units of intents/2026-11-wow-app/plan.md with at most three agents at a time',
  whenToUse: 'Run in the wow repository to build the app from its plan. args: {base?: "main", units?: ["U1"], done?: ["U1"], retries?: 1}',
  phases: [
    { title: 'Deliver', detail: 'one worker per unit in its own worktree and branch' },
    { title: 'Review', detail: 'independent reviewer runs the ground truth and reads the diff' },
    { title: 'Integrate', detail: 'serial merge into the base branch with aggregate checks' },
  ],
}

// Keep this list identical to the "## Units" section of intents/2026-11-wow-app/plan.md.
const UNITS = [
  { key: 'U1', title: 'Monorepo scaffold, contracts skeleton, CI', deps: [] },
  { key: 'U2', title: 'Server core: RPC, SQLite, events and projections, settings registry, secrets', deps: ['U1'] },
  { key: 'U3', title: 'Web shell: tokens, layout, routing, sidebar, palette, generated settings page', deps: ['U1'] },
  { key: 'U4', title: 'Outlook bridge and mock', deps: ['U1'] },
  { key: 'U5', title: 'Claude provider adapter', deps: ['U2'] },
  { key: 'U6', title: 'Codex provider adapter', deps: ['U2'] },
  { key: 'U7', title: 'Skills discovery and workflow engine', deps: ['U2'] },
  { key: 'U8', title: 'Chat view', deps: ['U3', 'U5', 'U6'] },
  { key: 'U9', title: 'Calendar views and Outlook sync', deps: ['U2', 'U3', 'U4'] },
  { key: 'U10', title: 'Workflow builder and run view', deps: ['U3', 'U7'] },
  { key: 'U11', title: 'Scheduler and triggers', deps: ['U7', 'U9'] },
  { key: 'U12', title: 'Backlog and tracker publishing', deps: ['U9', 'U10'] },
  { key: 'U13', title: 'Provider onboarding and settings coverage', deps: ['U8'] },
  { key: 'U14', title: 'Electron desktop: server lifecycle, tray, autostart, installer', deps: ['U2', 'U3'] },
  { key: 'U15', title: 'End-to-end tests and user guide', deps: ['U8', 'U11', 'U12', 'U13', 'U14'] },
  { key: 'U16', title: 'Windows smoke and release candidate', deps: ['U15'] },
]

// Order inside a ready set: lower index first, so U8/U9/U10 (the views) win over U14 (packaging).
const PRIORITY = ['U1', 'U2', 'U3', 'U4', 'U5', 'U6', 'U7', 'U8', 'U9', 'U10', 'U11', 'U14', 'U12', 'U13', 'U15', 'U16']

const MAX_AGENTS = 3
const BASE = (args && args.base) || 'main'
const RETRIES = args && typeof args.retries === 'number' ? args.retries : 1
const ONLY = args && Array.isArray(args.units) ? new Set(args.units) : null
const done = new Set((args && args.done) || [])
// Per-unit context for a rerun, e.g. an earlier reviewer's findings: {U7: "..."}
const NOTES = (args && args.notes) || {}
const PLAN = 'intents/2026-11-wow-app/plan.md'
const INTENT_ID = '2026-11-wow-app'

// ---- a counting semaphore so worker + reviewer + integrator never exceed MAX_AGENTS ----
let running = 0
const waiters = []
function acquire() {
  return new Promise((resolve) => {
    if (running < MAX_AGENTS) { running++; resolve() } else waiters.push(resolve)
  })
}
function release() {
  const next = waiters.shift()
  if (next) next(); else running--
}
async function withSlot(fn) {
  await acquire()
  try { return await fn() } finally { release() }
}

const WORKER_SCHEMA = {
  type: 'object',
  properties: {
    unit: { type: 'string' },
    branch: { type: 'string' },
    headSha: { type: 'string' },
    pushed: { type: 'boolean' },
    pullRequestUrl: { type: 'string' },
    checks: { type: 'array', items: { type: 'object', properties: { command: { type: 'string' }, passed: { type: 'boolean' }, note: { type: 'string' } }, required: ['command', 'passed'] } },
    changedFiles: { type: 'array', items: { type: 'string' } },
    uncertainties: { type: 'array', items: { type: 'string' } },
    blocked: { type: 'boolean' },
    blockedReason: { type: 'string' },
  },
  required: ['unit', 'branch', 'headSha', 'pushed', 'checks', 'changedFiles', 'uncertainties', 'blocked'],
}

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    pass: { type: 'boolean' },
    groundTruthPassed: { type: 'boolean' },
    findings: { type: 'array', items: { type: 'object', properties: { severity: { type: 'string', enum: ['blocking', 'should-fix', 'nit'] }, file: { type: 'string' }, summary: { type: 'string' }, fix: { type: 'string' } }, required: ['severity', 'summary'] } },
  },
  required: ['pass', 'groundTruthPassed', 'findings'],
}

const INTEGRATE_SCHEMA = {
  type: 'object',
  properties: {
    integrated: { type: 'boolean' },
    baseSha: { type: 'string' },
    aggregateChecks: { type: 'array', items: { type: 'object', properties: { command: { type: 'string' }, passed: { type: 'boolean' } }, required: ['command', 'passed'] } },
    conflictFiles: { type: 'array', items: { type: 'string' } },
    note: { type: 'string' },
  },
  required: ['integrated', 'aggregateChecks'],
}

function unitSlug(u) {
  return u.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 40)
}

function workerPrompt(u, attempt, previous, review) {
  const branch = `agent/${u.key.toLowerCase()}-${unitSlug(u)}`
  const retryBlock = previous
    ? `\n\nThis is attempt ${attempt}. The branch ${previous.branch} already exists on origin at ${previous.headSha}; check it out and continue from it. The reviewer found:\n${JSON.stringify(review && review.findings, null, 2)}\nResolve every blocking and should-fix finding, rerun the ground truth, push, and report again.`
    : ''
  const notesBlock = NOTES[u.key] ? `\n\nContext from an earlier run of this unit:\n${NOTES[u.key]}` : ''
  return `You are delivering unit ${u.key} "${u.title}" of ${PLAN} in the wow repository.

Read, in this order: CLAUDE.md, docs/architecture.md, intents/${INTENT_ID}/spec.md, and the "### ${u.key}" section of ${PLAN}. The unit's section is your contract: Outcome, Boundaries, Acceptance, Ground truth, Delivery target.

Rules:
- Start from origin/${BASE} (fetch it first). Create or reuse branch ${branch}. Work only inside the unit's boundaries; if something outside is needed to make the unit work, note it in "uncertainties" instead of doing it.
- Use the installed agent-os skill /deliver-work (or the plugin form /agent-os-dev:deliver-work) if it is available to you, otherwise follow the same discipline: diagnose before fixing, proportional tests, verify before done.
- Run the unit's ground truth and the repository checks from CLAUDE.md before you finish. Report each command with its real result; do not claim a check you did not run. If a check cannot run in this environment (for example Windows-only), say so in "checks" with passed=false and a note.
- Commit with clear messages. The final commit message and the pull request body carry the line "Intent-Unit: ${INTENT_ID}/${u.key}". Push the branch to origin with -u. Open a draft pull request against ${BASE} if the GitHub tools are available; otherwise leave pullRequestUrl empty.
- Never force-push, never touch ${BASE} directly, never edit another unit's packages beyond what compiling against them requires.
- If the unit cannot be delivered (missing dependency, undecidable product question), stop early, push what is safe, and return blocked=true with the reason.${retryBlock}

Return the structured result only.${notesBlock}`
}

function reviewPrompt(u, work) {
  return `You are the independent reviewer for unit ${u.key} "${u.title}" of ${PLAN} in the wow repository. You did not write the code.

Fetch origin and check out branch ${work.branch} at ${work.headSha} in your worktree. Read the "### ${u.key}" section of ${PLAN}, CLAUDE.md and docs/architecture.md.

Do, in order:
1. Run the unit's ground truth and the repository checks yourself. Record whether they pass. A check that cannot run here is not a failure, but say so.
2. Read the full diff against origin/${BASE}. Look for: work outside the unit's boundaries, constants that should be settings, provider-specific logic leaking out of its adapter, UI deriving state from its own clock, secrets or real-looking fixtures, tests with sleeps or polling, missing Intent-Unit line, claims in the pull request not backed by a command that ran.
3. Use /check-work (or /agent-os-dev:check-work) if available.

pass=true only when the ground truth passed and there is no blocking finding. Be concrete: file, what is wrong, how to fix. Do not fix anything yourself. Return the structured result only.`
}

function integratePrompt(u, work) {
  return `You are the integrator for the wow repository. Merge unit ${u.key} "${u.title}" into ${BASE}.

Steps:
1. git fetch origin. Check out ${BASE} at origin/${BASE} in the main checkout (not a worktree).
2. Merge branch ${work.branch} (head ${work.headSha}) with a merge commit whose message is "Integrate ${u.key}: ${u.title}" and includes the line "Intent-Unit: ${INTENT_ID}/${u.key}". If there are conflicts, resolve them only when the resolution is mechanical (lockfile, imports, adjacent additions); otherwise abort the merge and return integrated=false with conflictFiles.
3. Run the aggregate checks: pnpm install --frozen-lockfile, pnpm typecheck, pnpm lint, pnpm test, git diff --check, and pnpm e2e when the script exists. If a check fails because of the merge, fix it in a follow-up commit on ${BASE} only if the fix is small and obvious; otherwise return integrated=false with the failing output in note and leave ${BASE} untouched (reset to origin/${BASE}).
4. Push ${BASE} to origin (no force). If the unit has a pull request, it will show as merged; do not merge through GitHub.

Return the structured result only.`
}

async function deliver(u) {
  let attempt = 0
  let work = null
  let review = null
  while (attempt <= RETRIES) {
    attempt++
    work = await withSlot(() => agent(workerPrompt(u, attempt, work, review), {
      label: `deliver:${u.key}${attempt > 1 ? `#${attempt}` : ''}`,
      phase: 'Deliver',
      isolation: 'worktree',
      schema: WORKER_SCHEMA,
    }))
    if (!work) return { key: u.key, status: 'failed', note: 'worker returned nothing' }
    if (work.blocked) return { key: u.key, status: 'blocked', note: work.blockedReason, work }
    if (!work.pushed) return { key: u.key, status: 'failed', note: 'branch not pushed', work }

    review = await withSlot(() => agent(reviewPrompt(u, work), {
      label: `review:${u.key}`,
      phase: 'Review',
      isolation: 'worktree',
      schema: REVIEW_SCHEMA,
    }))
    if (!review) return { key: u.key, status: 'failed', note: 'reviewer returned nothing', work }
    if (review.pass) break
    log(`${u.key}: review found ${review.findings.length} finding(s); ${attempt <= RETRIES ? 'retrying' : 'out of retries'}`)
  }
  if (!review || !review.pass) return { key: u.key, status: 'review-failed', work, review }

  // Integration is serialized: only one merge into BASE at a time, and it still takes a slot.
  const result = integrateChain.then(() => withSlot(() => agent(integratePrompt(u, work), {
    label: `integrate:${u.key}`,
    phase: 'Integrate',
    schema: INTEGRATE_SCHEMA,
  })))
  integrateChain = result.catch(() => null)
  const integ = await result
  if (!integ || !integ.integrated) return { key: u.key, status: 'integration-failed', work, review, integ }
  return { key: u.key, status: 'integrated', work, review, integ }
}

let integrateChain = Promise.resolve()

const selected = UNITS.filter((u) => !done.has(u.key) && (!ONLY || ONLY.has(u.key)))
for (const u of selected) {
  for (const d of u.deps) {
    if (!done.has(d) && !selected.some((s) => s.key === d)) {
      log(`${u.key} depends on ${d}, which is neither done nor selected; pass it in args.done when it is already on ${BASE}`)
    }
  }
}

const pending = new Map(selected.map((u) => [u.key, u]))
const inflight = new Map()
const results = []

while (pending.size || inflight.size) {
  const ready = [...pending.values()]
    .filter((u) => u.deps.every((d) => done.has(d)))
    .sort((a, b) => PRIORITY.indexOf(a.key) - PRIORITY.indexOf(b.key))
  for (const u of ready) {
    pending.delete(u.key)
    log(`starting ${u.key} ${u.title}`)
    inflight.set(u.key, deliver(u))
  }
  if (!inflight.size) {
    log(`nothing can start: ${[...pending.keys()].join(', ')} wait on units that failed`)
    break
  }
  const finished = await Promise.race([...inflight.values()])
  inflight.delete(finished.key)
  results.push(finished)
  if (finished.status === 'integrated') {
    done.add(finished.key)
    log(`${finished.key} integrated into ${BASE}`)
  } else {
    log(`${finished.key} ${finished.status}${finished.note ? `: ${finished.note}` : ''}`)
  }
}

return {
  base: BASE,
  integrated: results.filter((r) => r.status === 'integrated').map((r) => r.key),
  notIntegrated: results.filter((r) => r.status !== 'integrated').map((r) => ({ key: r.key, status: r.status, note: r.note, branch: r.work && r.work.branch, findings: r.review && r.review.findings, integration: r.integ })),
  stillPending: [...pending.keys()],
}
