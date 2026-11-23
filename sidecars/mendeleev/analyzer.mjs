import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const FALLBACK_LIMITS = [
  ['MODEL_PLACEHOLDER_M52', 1048576], // Gemini 4 Hydrogen
  ['MODEL_PLACEHOLDER_M42', 1048576], // Gemini 4 Carbon
  ['MODEL_PLACEHOLDER_M41', 1048576], // Gemini 4 Argon
  ['MODEL_PLACEHOLDER_M31', 1048576], // Gemini 3.8
  ['MODEL_PLACEHOLDER_M40', 1000000], // Claude 5.5
  ['MODEL_PLACEHOLDER_M368', 1000000],
  ['MODEL_PLACEHOLDER_M26', 250000], // Claude 4.6
  ['MODEL_PLACEHOLDER_M35', 250000],
  ['MODEL_OPENAI_GPT_OSS', 131072],
];

const GROUP_KEY_MAP = {
  TOKEN_TYPE_SYSTEM_PROMPT: 'system_prompt',
  TOKEN_TYPE_TOOLS: 'system_tools',
  TOKEN_TYPE_RULES: 'rules',
  TOKEN_TYPE_MCP_TOOLS: 'mcp_tools',
  TOKEN_TYPE_SKILLS: 'skills',
  TOKEN_TYPE_SUBAGENTS: 'subagents',
  TOKEN_TYPE_WORKFLOWS: 'workflows',
  TOKEN_TYPE_PLUGINS: 'plugins',
  TOKEN_TYPE_FLOWS: 'legacy_workflows',
};

const CATEGORY_ORDER = [
  { key: 'user', name: 'User messages' },
  { key: 'agent', name: 'Agent responses' },
  { key: 'tool', name: 'Tool calls' },
  { key: 'system_messages', name: 'System messages' },
  { key: 'system_prompt', name: 'System prompt' },
  { key: 'system_tools', name: 'System tools' },
  { key: 'system_overhead', name: 'System overhead' },
  { key: 'rules', name: 'Rules' },
  { key: 'skills', name: 'Skills' },
  { key: 'subagents', name: 'Subagents' },
  { key: 'legacy_workflows', name: 'Legacy workflows' },
  { key: 'workflows', name: 'Workflows' },
  { key: 'plugins', name: 'Plugins' },
  { key: 'mcp_tools', name: 'MCP tools' },
];

const ALWAYS_SHOWN_CATEGORIES = new Set(['user', 'agent', 'tool']);

export function parseDurationSec(val) {
  if (typeof val === 'number' && Number.isFinite(val)) return val >= 0 ? val : null;
  if (typeof val !== 'string') return null;
  const m = val.trim().match(/^(-?\d+(?:\.\d+)?)s$/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function parseIsoMs(val) {
  if (!val) return null;
  const ms = Date.parse(val);
  return Number.isFinite(ms) ? ms : null;
}

export function shortenPath(uri) {
  if (!uri) return '';
  let p = String(uri);
  if (p.startsWith('file:')) {
    try {
      p = decodeURIComponent(new URL(p).pathname);
    } catch {
      p = p.replace(/^file:\/\//, '');
    }
    if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
  }
  p = p.replace(/\\/g, '/');
  const home = homedir().replace(/\\/g, '/');
  if (home && p.startsWith(home)) return '~' + p.slice(home.length);
  return p;
}

function stepCategory(stepType = '') {
  if (stepType === 'CORTEX_STEP_TYPE_USER_INPUT') return 'user';
  if (stepType === 'CORTEX_STEP_TYPE_PLANNER_RESPONSE') return 'agent';
  if (stepType === 'CORTEX_STEP_TYPE_CHECKPOINT') return 'checkpoint';
  if (
    stepType === 'CORTEX_STEP_TYPE_SYSTEM_MESSAGE' ||
    stepType === 'CORTEX_STEP_TYPE_FINISH' ||
    stepType === 'CORTEX_STEP_TYPE_UNSPECIFIED'
  ) {
    return 'system_messages';
  }
  return 'tool';
}

function chatChildCategory(name = '') {
  const upper = String(name).toUpperCase();
  if (upper.includes('USER_INPUT')) return 'user';
  if (upper.includes('PLANNER_RESPONSE')) return 'agent';
  if (upper.includes('SYSTEM_MESSAGE') || upper.includes('FINISH')) return 'system_messages';
  return 'tool';
}

function estimateStepTokens(step) {
  const outTok = Number(step?.metadata?.modelUsage?.outputTokens || 0);
  if (outTok > 0) return outTok;
  const tcOut = Number(step?.metadata?.toolCallOutputTokens || 0);
  if (tcOut > 0) return tcOut;
  const text =
    step?.userInput?.userResponse ||
    step?.plannerResponse?.response ||
    step?.metadata?.toolCall?.argumentsJson ||
    '';
  if (!text) return 0;
  return Math.max(1, Math.trunc(Buffer.byteLength(text, 'utf8') / 4));
}

function resolveModelInfo(modelId, displayNameHint, catalog = {}, pricingData = {}) {
  const catEntry = catalog[modelId] || {};
  const phEntry = pricingData?.placeholders?.[modelId] || {};
  const displayName = displayNameHint || catEntry.displayName || phEntry.label || modelId || 'Unknown Model';

  let limitTokens = Number(catEntry.maxTokens) || 0;
  if (!limitTokens && modelId) {
    const matched = FALLBACK_LIMITS.find(([prefix]) => modelId.startsWith(prefix));
    if (matched) limitTokens = matched[1];
  }
  if (!limitTokens) {
    if (/gemini/i.test(displayName)) limitTokens = 1048576;
    else if (/claude.*5\.5/i.test(displayName)) limitTokens = 1000000;
    else if (/claude/i.test(displayName)) limitTokens = 250000;
    else if (/gpt/i.test(displayName)) limitTokens = 131072;
  }

  return { modelId, displayName, limitTokens };
}

function resolvePriceRule(modelId, pricingData = {}, atMs = Date.now()) {
  const pricing = pricingData?.pricing || {};
  const ph = pricingData?.placeholders?.[modelId];
  const canonical = ph?.modelId || modelId || '';
  const lower = canonical.toLowerCase();

  let rule = pricing[lower];
  if (!rule) {
    const key = Object.keys(pricing).find((k) => lower.includes(k) || k.includes(lower));
    if (key) rule = pricing[key];
  }
  if (!rule) return null;

  if (Array.isArray(rule.phases)) {
    const phase = rule.phases.find((p) => {
      const fromOk = !p.from || atMs >= Date.parse(p.from);
      const untilOk = !p.until || atMs < Date.parse(p.until);
      return fromOk && untilOk;
    });
    if (phase) return phase;
  }
  return rule;
}

function extractFiles(steps, workspace) {
  const knowledge = [];
  const artifacts = [];
  const skills = [];
  const seenK = new Set();
  const seenA = new Set();
  const seenS = new Set();

  for (const step of steps) {
    const tok = estimateStepTokens(step);
    const ca = step?.codeAction;
    const uri = ca?.actionResult?.edit?.absoluteUri || ca?.edit?.absoluteUri;
    if (uri) {
      const short = shortenPath(uri);
      if (ca.isArtifactFile && !seenA.has(uri)) {
        seenA.add(uri);
        artifacts.push({ path: short, tokens: tok });
      }
      if (ca.isKnowledgeFile && !seenK.has(uri)) {
        seenK.add(uri);
        knowledge.push({ path: short, tokens: tok });
      }
    }

    let viewPath = step?.viewFile?.absolutePathUri || step?.viewFile?.path || '';
    if (!viewPath && step?.metadata?.toolCall) {
      const tc = step.metadata.toolCall;
      if (tc.name === 'view_file' || tc.name === 'read_file') {
        try {
          const args = JSON.parse(tc.argumentsJson || '{}');
          viewPath = args.AbsolutePath || args.Path || args.FilePath || '';
        } catch { /* ignore malformed json */ }
      }
    }
    if (viewPath && viewPath.replace(/\\/g, '/').endsWith('/SKILL.md')) {
      const short = shortenPath(viewPath);
      if (!seenS.has(short)) {
        seenS.add(short);
        skills.push({ path: short, tokens: tok });
      }
    }
  }

  const systemFiles = [];
  if (workspace) {
    for (const rel of ['.agents/rules', '.agents/skills', '.agents/workflows', '.gemini']) {
      const full = join(workspace, rel);
      if (existsSync(full)) {
        systemFiles.push({ path: `${shortenPath(full)}/`, tokens: 0 });
      }
    }
  }

  return { knowledge, artifacts, skills, systemFiles };
}

function extractTelemetry(steps, genMetas, pricingData) {
  let totalInput = 0;
  let totalCacheRead = 0;
  let totalOutput = 0;
  let totalThinking = 0;
  let totalResponse = 0;
  let totalCostUsd = 0;
  let savedCostUsd = 0;
  let hasPricedSteps = false;

  let tpsOutputSum = 0;
  let tpsDurationSum = 0;
  let latestE2eTps = null;
  let decodeOutputSum = 0;
  let decodeDurationSum = 0;
  let latestDecodeTps = null;
  let latestStepTokens = null;

  const ttftSamples = [];
  for (const gm of genMetas) {
    const cm = gm?.chatModel;
    const ttft = parseDurationSec(cm?.timeToFirstToken);
    if (ttft !== null) ttftSamples.push(ttft);

    const streamSec = parseDurationSec(cm?.streamingDuration);
    const outTok = Number(cm?.usage?.outputTokens || 0);
    // Filter out sub-0.5s buffered tool-call bursts that distort decode TPS
    if (streamSec !== null && streamSec >= 0.5 && outTok >= 30) {
      latestDecodeTps = outTok / streamSec;
      decodeOutputSum += outTok;
      decodeDurationSum += streamSec;
    }
  }

  // Prefer step-level modelUsage when present, fallback to generatorMetadata usage
  const usageRecords = [];
  for (const step of steps) {
    const u = step?.metadata?.modelUsage;
    if (!u) continue;
    const input = Number(u.inputTokens || 0);
    const cacheRead = Number(u.cacheReadTokens || 0);
    const output = Number(u.outputTokens || 0);
    const thinking = Number(u.thinkingOutputTokens || 0);
    const response = Number(u.responseOutputTokens || Math.max(0, output - thinking));
    const modelId = u.model || step?.metadata?.generatorModel || '';
    const startMs = parseIsoMs(step?.metadata?.createdAt);
    const endMs = parseIsoMs(step?.metadata?.finishedGeneratingAt || step?.metadata?.completedAt);
    const isCheckpoint = step?.type === 'CORTEX_STEP_TYPE_CHECKPOINT';
    const isCanceled = step?.status === 'CORTEX_STEP_STATUS_CANCELED';

    usageRecords.push({
      modelId,
      input,
      cacheRead,
      output,
      thinking,
      response,
      startMs,
      endMs,
      isCheckpoint,
      isCanceled,
      isPlanner: step?.type === 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
    });
  }

  if (usageRecords.length === 0) {
    for (const gm of genMetas) {
      const u = gm?.chatModel?.usage;
      if (!u) continue;
      const input = Number(u.inputTokens || 0);
      const cacheRead = Number(u.cacheReadTokens || 0);
      const output = Number(u.outputTokens || 0);
      const thinking = Number(u.thinkingOutputTokens || 0);
      const response = Number(u.responseOutputTokens || Math.max(0, output - thinking));
      usageRecords.push({
        modelId: u.model || gm?.chatModel?.model || '',
        input,
        cacheRead,
        output,
        thinking,
        response,
        startMs: null,
        endMs: null,
        isCheckpoint: false,
        isCanceled: false,
        isPlanner: true,
      });
    }
  }

  for (const rec of usageRecords) {
    totalInput += rec.input;
    totalCacheRead += rec.cacheRead;
    totalOutput += rec.output;
    totalThinking += rec.thinking;
    totalResponse += rec.response;
    latestStepTokens = { input: rec.input, cacheRead: rec.cacheRead, output: rec.output };

    const price = resolvePriceRule(rec.modelId, pricingData, rec.startMs || Date.now());
    if (price) {
      hasPricedSteps = true;
      totalCostUsd +=
        (rec.input * price.input + rec.cacheRead * price.cache + rec.output * price.output) / 1e6;
      savedCostUsd += (rec.cacheRead * Math.max(0, price.input - price.cache)) / 1e6;
    }

    if (rec.isPlanner && !rec.isCheckpoint && !rec.isCanceled && rec.startMs && rec.endMs) {
      const durSec = (rec.endMs - rec.startMs) / 1000;
      if (durSec >= 0.3 && rec.output >= 20) {
        latestE2eTps = rec.output / durSec;
        tpsOutputSum += rec.output;
        tpsDurationSum += durSec;
      }
    }
  }

  const totalInputAll = totalInput + totalCacheRead;
  const cacheHitRate = totalInputAll > 0 ? (totalCacheRead / totalInputAll) * 100 : null;
  const e2eAvgTps = tpsDurationSum > 0 ? tpsOutputSum / tpsDurationSum : null;
  const decodeAvgTps = decodeDurationSum > 0 ? decodeOutputSum / decodeDurationSum : null;
  const avgTps = decodeAvgTps ?? e2eAvgTps;
  const latestTps = latestDecodeTps ?? latestE2eTps;
  const latestTtftSec = ttftSamples.length ? ttftSamples[ttftSamples.length - 1] : null;
  const avgTtftSec = ttftSamples.length
    ? ttftSamples.reduce((a, b) => a + b, 0) / ttftSamples.length
    : null;

  return {
    callCount: usageRecords.length,
    totalInput,
    totalCacheRead,
    totalOutput,
    totalThinking,
    totalResponse,
    cacheHitRate: cacheHitRate !== null ? Number(cacheHitRate.toFixed(1)) : null,
    latestTps: latestTps !== null ? Number(latestTps.toFixed(1)) : null,
    avgTps: avgTps !== null ? Number(avgTps.toFixed(1)) : null,
    latestTtftSec: latestTtftSec !== null ? Number(latestTtftSec.toFixed(2)) : null,
    avgTtftSec: avgTtftSec !== null ? Number(avgTtftSec.toFixed(2)) : null,
    totalCostUsd: hasPricedSteps ? Number(totalCostUsd.toFixed(4)) : null,
    savedCostUsd: hasPricedSteps ? Number(savedCostUsd.toFixed(4)) : null,
    latestStepTokens,
  };
}

export function extractQuotaPools(userStatus, currentModelId) {
  const configs = userStatus?.userStatus?.cascadeModelConfigData?.clientModelConfigs || [];
  if (!configs.length) return { current: null, pools: [] };

  const planName = userStatus?.userStatus?.planStatus?.planInfo?.planName || '';
  const byKey = new Map();
  let current = null;

  for (const cfg of configs) {
    const modelId = cfg?.modelOrAlias?.model || '';
    const label = cfg?.label || modelId;
    const qi = cfg?.quotaInfo;
    if (!qi || qi.remainingFraction === undefined) continue;

    const remainingPct = Math.max(0, Math.min(100, Number((qi.remainingFraction * 100).toFixed(1))));
    const entry = {
      modelId,
      label,
      remainingPct,
      resetTime: qi.resetTime || null,
    };

    if (modelId === currentModelId) current = entry;

    // Group similar quota pools (same resetTime + remainingPct + family prefix)
    const family = /claude/i.test(label)
      ? 'Claude'
      : /gpt/i.test(label)
        ? 'GPT'
        : /carbon/i.test(label)
          ? 'Gemini 4 Carbon'
          : /argon/i.test(label)
            ? 'Gemini 4 Argon'
            : /hydrogen/i.test(label)
              ? 'Gemini 4 Hydrogen'
              : /gemini/i.test(label)
                ? 'Gemini'
                : label;

    const poolKey = `${family}|${qi.resetTime || ''}|${remainingPct}`;
    if (!byKey.has(poolKey)) {
      byKey.set(poolKey, {
        family,
        remainingPct,
        resetTime: qi.resetTime || null,
        isCurrent: modelId === currentModelId,
      });
    } else if (modelId === currentModelId) {
      byKey.get(poolKey).isCurrent = true;
    }
  }

  return {
    planName,
    current,
    pools: Array.from(byKey.values()).slice(0, 6),
  };
}

export function analyzeTrajectory({
  trajectory,
  catalog = {},
  pricingData = {},
  userStatus = null,
  workspace = '',
}) {
  const steps = trajectory?.steps || [];
  const genMetas = trajectory?.generatorMetadata || [];
  const lastGm = genMetas.length ? genMetas[genMetas.length - 1] : null;
  const chatModel = lastGm?.chatModel || null;

  // Determine active model
  let modelId = chatModel?.model || '';
  if (!modelId) {
    for (let i = steps.length - 1; i >= 0; i--) {
      const m = steps[i]?.metadata?.modelUsage?.model || steps[i]?.metadata?.generatorModel;
      if (m) {
        modelId = m;
        break;
      }
    }
  }

  const { displayName, limitTokens } = resolveModelInfo(
    modelId,
    chatModel?.modelDisplayName,
    catalog,
    pricingData
  );

  // Initialize context counters
  const stats = Object.fromEntries(CATEGORY_ORDER.map((c) => [c.key, 0]));
  stats.checkpoint = 0;

  const checkpoints = [];
  let lastCheckpointIdx = -1;
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s.type === 'CORTEX_STEP_TYPE_CHECKPOINT') {
      stats.checkpoint += estimateStepTokens(s);
      lastCheckpointIdx = i;
      const cp = s.checkpoint || {};
      checkpoints.push({
        index: Number(cp.checkpointIndex ?? checkpoints.length + 1),
        startStep: Number(cp.startStepIndex ?? 0),
        endStep: Number(cp.endStepIndex ?? 0),
        intent: cp.userIntent || '',
      });
    }
  }

  const ctxMeta = chatModel?.chatStartMetadata?.contextWindowMetadata || null;
  const groups = ctxMeta?.tokenBreakdown?.groups || [];
  const activeCheckpoint = Number(chatModel?.chatStartMetadata?.checkpointIndex ?? -1);
  const hasBreakdown = groups.length > 0;
  let heading = 'Token usage by category';
  let isEstimated = false;

  if (hasBreakdown) {
    let groupedSum = 0;
    for (const g of groups) {
      const num = Number(g.numTokens || 0);
      groupedSum += num;
      if (g.type === 'TOKEN_TYPE_CHAT_MESSAGES') {
        for (const child of g.children || []) {
          const cat = chatChildCategory(child.name);
          stats[cat] += Number(child.numTokens || 0);
        }
      } else {
        const key = GROUP_KEY_MAP[g.type];
        if (key) stats[key] += num;
        else stats.system_overhead += num;
      }
    }

    const estUsed = Number(ctxMeta?.estimatedTokensUsed || 0);
    if (estUsed > groupedSum) {
      stats.system_overhead += estUsed - groupedSum;
    }

    // Add tokens from steps produced after the latest generatorMetadata
    const coveredSet = new Set(lastGm?.stepIndices || []);
    const lastCovered = coveredSet.size ? Math.max(...coveredSet) : -1;
    if (lastCovered >= 0 && lastCovered < steps.length - 1) {
      for (let i = lastCovered + 1; i < steps.length; i++) {
        const s = steps[i];
        const cat = stepCategory(s.type);
        if (cat !== 'checkpoint') stats[cat] += estimateStepTokens(s);
      }
    }
  } else {
    isEstimated = true;
    heading =
      checkpoints.length > 0
        ? 'Estimated after compaction · updates next turn'
        : 'Estimated usage (awaiting generation)';
    const startAt = lastCheckpointIdx >= 0 ? lastCheckpointIdx + 1 : 0;
    for (let i = startAt; i < steps.length; i++) {
      const s = steps[i];
      const cat = stepCategory(s.type);
      if (cat !== 'checkpoint') stats[cat] += estimateStepTokens(s);
    }
  }

  const usedTokens = CATEGORY_ORDER.reduce((sum, c) => sum + stats[c.key], 0);
  const usedPct = limitTokens > 0 ? Math.min(100, Number(((usedTokens / limitTokens) * 100).toFixed(1))) : 0;
  const freeTokens = limitTokens > usedTokens ? limitTokens - usedTokens : 0;

  const systemSum = stats.system_prompt + stats.system_tools + stats.system_overhead + stats.system_messages;
  const customSum =
    stats.rules + stats.skills + stats.subagents + stats.legacy_workflows + stats.workflows + stats.plugins + stats.mcp_tools;

  const categories = CATEGORY_ORDER.filter(
    (c) => ALWAYS_SHOWN_CATEGORIES.has(c.key) || stats[c.key] > 0
  ).map((c) => ({
    key: c.key,
    name: c.name,
    tokens: stats[c.key],
    pct: limitTokens > 0 ? Number(((stats[c.key] / limitTokens) * 100).toFixed(1)) : 0,
  }));

  let checkpointView = null;
  if (checkpoints.length > 0) {
    const activeCp =
      checkpoints.find((c) => c.index === activeCheckpoint) || checkpoints[checkpoints.length - 1];
    checkpointView = {
      count: checkpoints.length,
      activeNumber: activeCp.index,
      activeText: `steps ${activeCp.startStep}–${activeCp.endStep}`,
      intent: activeCp.intent,
      historical: Math.max(0, checkpoints.length - 1),
    };
  }

  const files = extractFiles(steps, workspace);
  const telemetry = extractTelemetry(steps, genMetas, pricingData);
  const quotas = extractQuotaPools(userStatus, modelId);

  return {
    model: displayName,
    modelId,
    usedTokens,
    limitTokens,
    requestBudgetTokens: Number(ctxMeta?.maxContextTokens || 256000),
    usedPct,
    freeTokens,
    heading,
    isEstimated,
    checkpointBuffer: stats.checkpoint,
    gridSegments: [systemSum, stats.user, stats.agent, stats.tool, customSum],
    categories,
    checkpointView,
    files: {
      knowledge: files.knowledge,
      artifacts: files.artifacts,
      skills: files.skills,
      system: files.systemFiles,
    },
    telemetry,
    quotas,
  };
}
