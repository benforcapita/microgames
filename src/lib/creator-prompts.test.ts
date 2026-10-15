import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { CREATOR_PROMPTS } from './creator-prompts.ts';

describe('creator prompts', () => {
  it('has exactly 2 prompts with ids a and b', () => {
    assert.equal(CREATOR_PROMPTS.length, 2);
    assert.deepEqual(
      CREATOR_PROMPTS.map((p) => p.id),
      ['a', 'b'],
    );
  });

  it('each prompt text appears verbatim inside docs/RUNTIME-CONTRACT.md', () => {
    const contractPath = path.resolve(process.cwd(), 'docs/RUNTIME-CONTRACT.md');
    const contractContent = fs.readFileSync(contractPath, 'utf-8');

    for (const prompt of CREATOR_PROMPTS) {
      assert.ok(
        contractContent.includes(prompt.text),
        `Prompt ${prompt.id} text must appear verbatim inside docs/RUNTIME-CONTRACT.md`,
      );
    }
  });

  it('each prompt contains "[paste your game code here]"', () => {
    for (const prompt of CREATOR_PROMPTS) {
      assert.ok(
        prompt.text.includes('[paste your game code here]'),
        `Prompt ${prompt.id} text must contain '[paste your game code here]'`,
      );
    }
  });
});
