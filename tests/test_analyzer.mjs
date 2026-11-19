import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { analyzeTrajectory, parseDurationSec } from '../sidecars/mendeleev/analyzer.mjs';

const pricingData = JSON.parse(
  readFileSync(new URL('../sidecars/mendeleev/pricing.json', import.meta.url), 'utf8')
);

test('parseDurationSec parses Go/proto duration strings', () => {
  assert.equal(parseDurationSec('1.25s'), 1.25);
  assert.equal(parseDurationSec('32.214793584s'), 32.214793584);
  assert.equal(parseDurationSec(null), null);
});

test('analyzeTrajectory computes context, cache hit rate, TPS, TTFT, cost, and quotas', () => {
  const trajectory = {
    steps: [
      {
        type: 'CORTEX_STEP_TYPE_USER_INPUT',
        status: 'CORTEX_STEP_STATUS_DONE',
        userInput: { userResponse: 'hello world' },
      },
      {
        type: 'CORTEX_STEP_TYPE_CHECKPOINT',
        status: 'CORTEX_STEP_STATUS_DONE',
        checkpoint: { checkpointIndex: 1, startStepIndex: 0, endStepIndex: 10, userIntent: 'init' },
      },
      {
        type: 'CORTEX_STEP_TYPE_VIEW_FILE',
        status: 'CORTEX_STEP_STATUS_DONE',
        viewFile: { absolutePathUri: 'file:///Users/demo/.gemini/skills/plugin/SKILL.md' },
        metadata: { toolCallOutputTokens: 400 },
      },
      {
        type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
        status: 'CORTEX_STEP_STATUS_DONE',
        metadata: {
          createdAt: '2026-11-19T12:00:00.000Z',
          finishedGeneratingAt: '2026-11-19T12:00:10.000Z',
          generatorModel: 'MODEL_PLACEHOLDER_M526',
          modelUsage: {
            model: 'MODEL_PLACEHOLDER_M526',
            inputTokens: '10000',
            cacheReadTokens: '90000',
            outputTokens: '500',
            thinkingOutputTokens: '100',
            responseOutputTokens: '400',
          },
        },
      },
    ],
    generatorMetadata: [
      {
        stepIndices: [0, 1, 2, 3],
        chatModel: {
          model: 'MODEL_PLACEHOLDER_M526',
          modelDisplayName: 'Gemini 4 Hydrogen (Medium)',
          timeToFirstToken: '1.5s',
          chatStartMetadata: {
            checkpointIndex: 1,
            contextWindowMetadata: {
              estimatedTokensUsed: 50000,
              maxContextTokens: 512000,
              tokenBreakdown: {
                groups: [
                  { name: 'System Prompt', type: 'TOKEN_TYPE_SYSTEM_PROMPT', numTokens: 5000 },
                  { name: 'Skills', type: 'TOKEN_TYPE_SKILLS', numTokens: 6000 },
                  {
                    name: 'Chat Messages',
                    type: 'TOKEN_TYPE_CHAT_MESSAGES',
                    numTokens: 39000,
                    children: [
                      { name: '0: USER_INPUT', numTokens: 1000 },
                      { name: '3: PLANNER_RESPONSE', numTokens: 18000 },
                      { name: '2: VIEW_FILE', numTokens: 20000 },
                    ],
                  },
                ],
              },
            },
          },
        },
      },
    ],
  };

  const userStatus = {
    userStatus: {
      planStatus: { planInfo: { planName: 'Pro' } },
      cascadeModelConfigData: {
        clientModelConfigs: [
          {
            label: 'Gemini 4 Hydrogen (Medium)',
            modelOrAlias: { model: 'MODEL_PLACEHOLDER_M526' },
            quotaInfo: { remainingFraction: 0.92, resetTime: '2026-11-19T18:00:00Z' },
          },
        ],
      },
    },
  };

  const report = analyzeTrajectory({
    trajectory,
    catalog: { MODEL_PLACEHOLDER_M526: { maxTokens: 1048576, displayName: 'Gemini 4 Hydrogen (Medium)' } },
    pricingData,
    userStatus,
  });

  assert.equal(report.model, 'Gemini 4 Hydrogen (Medium)');
  assert.equal(report.usedTokens, 50000);
  assert.equal(report.limitTokens, 1048576);
  assert.equal(report.telemetry.cacheHitRate, 90);
  assert.equal(report.telemetry.avgTps, 50);
  assert.equal(report.telemetry.latestTtftSec, 1.5);
  assert.ok(report.telemetry.totalCostUsd > 0);
  assert.equal(report.checkpointView.activeNumber, 1);
  assert.equal(report.files.skills.length, 1);
  assert.equal(report.quotas.pools.length, 1);
  assert.equal(report.quotas.pools[0].remainingPct, 92);
});
