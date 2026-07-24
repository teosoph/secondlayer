import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getPromptSectionsForQueryType } from '../prompt-sections.js';

/**
 * CORE-97 — the prompt layer of the burden-of-proof fix. Query types that can
 * produce tax/administrative-dispute answers must instruct the model to state
 * ч. 2 ст. 77 КАС України when the answer concerns оскарження ППР.
 * (The deterministic backstop lives in required-norms.ts.)
 */
describe('CORE-97 tax-dispute prompt section', () => {
  const TAX_DISPUTE_TYPES = ['legal_consultation', 'practice_analysis', 'comparative_analysis', 'institutional_analysis', 'calculation'];

  for (const qt of TAX_DISPUTE_TYPES) {
    it(`includes the ст. 77 КАС instruction for ${qt}`, () => {
      const sections = getPromptSectionsForQueryType(qt as any);
      assert.match(sections, /ст\.\s*77\s+КАС/);
      assert.match(sections, /ППР|податков/i);
    });
  }

  it('does not include it for registry_lookup', () => {
    const sections = getPromptSectionsForQueryType('registry_lookup' as any);
    assert.doesNotMatch(sections, /ст\.\s*77\s+КАС/);
  });
});
