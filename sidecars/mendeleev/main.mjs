import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Response, SidecarApp } from 'sidecar_sdk';
import { analyzeTrajectory } from './analyzer.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CATALOG_TTL_MS = 10 * 60 * 1000;
const QUOTA_TTL_MS = 60 * 1000;

const pricingData = existsSync(join(HERE, 'pricing.json'))
  ? JSON.parse(readFileSync(join(HERE, 'pricing.json'), 'utf8'))
  : { pricing: {}, placeholders: {} };

let modelCatalog = {};
let catalogFetchedAt = 0;
let cachedUserStatus = null;
let quotaFetchedAt = 0;

function lsRequest(method, body) {
  const addr = (process.env.ANTIGRAVITY_LS_ADDRESS || '').trim();
  const csrf = (process.env.ANTIGRAVITY_CSRF_TOKEN || '').trim();
  if (!addr || !csrf) return Promise.reject(new Error('no language server address'));

  const base = new URL(addr.startsWith('http') ? addr : `http://${addr}`);
  const data = JSON.stringify(body);
  const transport = base.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const req = transport.request(
      {
        hostname: base.hostname,
        port: base.port,
        path: `/exa.language_server_pb.LanguageServerService/${method}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Connect-Protocol-Version': '1',
          'x-codeium-csrf-token': csrf,
          'Content-Length': Buffer.byteLength(data),
        },
        timeout: 6000,
        rejectUnauthorized: false,
      },
      (res) => {
        let text = '';
        res.on('data', (chunk) => {
          text += chunk;
        });
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`${method}: HTTP ${res.statusCode}`));
            return;
          }
          try {
            resolve(JSON.parse(text));
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error(`${method}: timeout`)));
    req.on('error', reject);
    req.end(data);
  });
}

async function refreshCatalog() {
  if (Date.now() - catalogFetchedAt < CATALOG_TTL_MS && Object.keys(modelCatalog).length > 0) {
    return;
  }
  catalogFetchedAt = Date.now();
  try {
    const resp = await lsRequest('GetAvailableModels', {
      metadata: { ideName: 'antigravity', extensionName: 'antigravity' },
    });
    const models = resp?.response?.models || resp?.models || {};
    const next = {};
    for (const [id, m] of Object.entries(models)) {
      const maxTokens = Number(m?.maxTokens) || 0;
      if (maxTokens > 0) next[id] = { maxTokens, displayName: m.displayName || '' };
    }
    if (Object.keys(next).length > 0) modelCatalog = next;
  } catch (err) {
    console.error('[mendeleev] model catalog unavailable:', err.message);
  }
}

async function refreshUserStatus() {
  if (Date.now() - quotaFetchedAt < QUOTA_TTL_MS && cachedUserStatus) {
    return cachedUserStatus;
  }
  quotaFetchedAt = Date.now();
  try {
    cachedUserStatus = await lsRequest('GetUserStatus', {});
  } catch (err) {
    console.error('[mendeleev] user status unavailable:', err.message);
  }
  return cachedUserStatus;
}

function workspacePath(uri) {
  if (!uri || !uri.startsWith('file:')) return '';
  let p = decodeURIComponent(uri.replace(/^file:\/\//, ''));
  if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
  return p;
}

function fmtTok(n) {
  if (n >= 1e6) {
    const v = n / 1e6;
    return Number.isInteger(v) ? `${v}M` : `${v.toFixed(1)}M`;
  }
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

function buildTextReport(r) {
  const lines = [];
  const lim = r.limitTokens ? `${fmtTok(r.limitTokens)} tokens (${r.usedPct.toFixed(1)}%)` : 'Unknown';
  lines.push(`${r.model} · ${fmtTok(r.usedTokens)} / ${lim}`);
  const t = r.telemetry;
  const perf = [
    t.cacheHitRate !== null ? `Cache ${t.cacheHitRate}%` : null,
    t.avgTps !== null ? `Avg ${t.avgTps} t/s` : null,
    t.latestTtftSec !== null ? `TTFT ${t.latestTtftSec}s` : null,
    t.totalCostUsd !== null ? `Est. $${t.totalCostUsd.toFixed(4)}` : null,
  ].filter(Boolean);
  if (perf.length) lines.push(perf.join(' · '));
  lines.push('');
  lines.push(r.heading);
  for (const c of r.categories) {
    lines.push(`- ${c.name}: ${fmtTok(c.tokens)} (${c.pct.toFixed(1)}%)`);
  }
  lines.push(`- Free space: ${fmtTok(r.freeTokens)}`);
  if (r.quotas?.pools?.length) {
    lines.push('');
    lines.push('Quotas:');
    for (const p of r.quotas.pools) {
      lines.push(`- ${p.family}: ${p.remainingPct}%`);
    }
  }
  return lines.join('\n');
}

async function getReport(conversationId, workspaceUri) {
  if (!UUID_RE.test(conversationId || '')) {
    return { error: 'no-conversation' };
  }

  await Promise.all([refreshCatalog(), refreshUserStatus()]);

  let trajResp;
  try {
    trajResp = await lsRequest('GetCascadeTrajectory', { cascadeId: conversationId });
  } catch (err) {
    return { error: 'trajectory-unavailable', message: err.message };
  }

  const trajectory = trajResp?.trajectory;
  if (!trajectory || !Array.isArray(trajectory.steps) || trajectory.steps.length === 0) {
    return { error: 'no-data' };
  }

  const workspace = workspacePath(workspaceUri);
  const result = analyzeTrajectory({
    trajectory,
    catalog: modelCatalog,
    pricingData,
    userStatus: cachedUserStatus,
    workspace,
  });

  return {
    ...result,
    text: buildTextReport(result),
    updatedAt: new Date().toISOString(),
  };
}

const app = new SidecarApp();

app.page('/', () =>
  new Response(readFileSync(join(HERE, 'index.html'), 'utf8'), { contentType: 'text/html' })
);

app.api(
  '/api/report',
  async (data) => {
    try {
      return await getReport(data.conversationId, data.workspace);
    } catch (err) {
      return { error: 'failed', message: err.message };
    }
  },
  'GET'
);

app.run();
refreshCatalog();
refreshUserStatus();
