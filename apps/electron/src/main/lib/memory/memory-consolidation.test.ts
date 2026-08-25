import { describe, expect, it, vi } from 'vitest'
import type { BatchOutput } from './memory-consolidation-service'
import type { MemoryEvidenceEntry } from './memory-evidence-sink'

// The pure fallback helper should not require better-sqlite3 just to test it.
vi.mock('./memory-layer-service', () => ({ getMemoryDir: () => '.' }))

const { addDeterministicNudgeCandidates } = await import('./memory-consolidation-service')

const emptyOutput: BatchOutput = {
  sessionKeyFacts: [],
  memoryCandidates: [],
  insights: [],
  contradictions: [],
}

function nudgeEvidence(
  id: string,
  targetLayer: 'L0' | 'L1' | 'L2' | 'L3',
  content: string,
): MemoryEvidenceEntry {
  return {
    id,
    createdAt: 1,
    mode: 'general',
    source: 'nudge',
    sessionId: 'session-1',
    nudgeCandidate: {
      id: `nudge-${id}`,
      type:
        targetLayer === 'L0'
          ? 'behavior_repeat'
          : targetLayer === 'L1'
            ? 'project_repeat'
            : targetLayer === 'L3'
              ? 'correction'
              : 'fact_repeat',
      targetLayer,
      pattern: content,
      evidence: [content],
      suggestedContent: content,
      userMessage: content,
    },
  }
}

describe('addDeterministicNudgeCandidates', () => {
  it('recovers local nudge candidates when the LLM returns none', () => {
    const output = addDeterministicNudgeCandidates(emptyOutput, [
      nudgeEvidence('e1', 'L0', '偏好简洁回答'),
    ])

    expect(output.memoryCandidates).toEqual([
      {
        targetLayer: 'L0',
        content: '偏好简洁回答',
        confidence: 0.86,
        evidenceIds: ['e1'],
      },
    ])
  })

  it('deduplicates the fallback against model output and repeated evidence', () => {
    const output = addDeterministicNudgeCandidates(
      {
        ...emptyOutput,
        memoryCandidates: [
          { targetLayer: 'L2', content: '使用 TypeScript', confidence: 0.9, evidenceIds: ['e0'] },
        ],
      },
      [
        nudgeEvidence('e1', 'L2', '使用 TypeScript'),
        nudgeEvidence('e2', 'L2', '使用 TypeScript'),
      ],
    )

    expect(output.memoryCandidates).toHaveLength(1)
  })

  it('drops path-slug junk from both model output and nudge fallback', () => {
    const output = addDeterministicNudgeCandidates(
      {
        ...emptyOutput,
        memoryCandidates: [
          {
            targetLayer: 'L1',
            content: 'F--TAgent-Desktop',
            confidence: 0.9,
            evidenceIds: ['e0'],
          },
          {
            targetLayer: 'L2',
            content: '使用 TypeScript',
            confidence: 0.9,
            evidenceIds: ['e1'],
          },
        ],
      },
      [nudgeEvidence('e2', 'L1', 'H--j3-statics')],
    )

    expect(output.memoryCandidates).toEqual([
      {
        targetLayer: 'L2',
        content: '使用 TypeScript',
        confidence: 0.9,
        evidenceIds: ['e1'],
      },
    ])
  })
})
