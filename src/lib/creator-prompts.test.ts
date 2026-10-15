import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { CREATOR_PROMPTS, INPUT_SUPPORT_META, INPUT_SUPPORT_VALUES } from './creator-prompts.ts';

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

describe('inputSupport declaration', () => {
  const doc = fs.readFileSync('docs/RUNTIME-CONTRACT.md', 'utf8');
  const contract = doc.split('## Creator prompts')[0];
  const values = INPUT_SUPPORT_VALUES.map((v) => `'${v}'`);
  it('contract, Prompt A and Prompt B all name the meta tag and the three values', () => {
    for (const [where, text] of [['contract', contract], ...CREATOR_PROMPTS.map((p) => [`Prompt ${p.id}`, p.text])]) {
      assert.ok(text.includes(`name="${INPUT_SUPPORT_META}"`), `${where}: meta name`);
      assert.ok(text.includes('Meshgrounds?.declare?.({ inputSupport'), `${where}: declare() form`);
      assert.match(text, /(Preferred: [^\n]*declare[^\n]*alternative: [^\n]*meta|declare\?\.\(\{ inputSupport \}\) \(preferred\) or <meta)/, `${where}: declare preferred, meta alternative`);
      assert.doesNotMatch(text, /meshgrounds:inputSupport/, `${where}: old camelCase meta name`);
      for (const v of values) assert.ok(text.includes(v), `${where}: ${v}`);
    }
  });
  it('meta name matches IS-1 (#34) exactly', () => assert.equal(INPUT_SUPPORT_META, 'meshgrounds:input-support'));
  it('contract names the DB column and states mobile=touch, desktop=keyboard/mouse', () => {
    assert.match(contract, /`inputSupport`/);
    assert.match(contract, /`input_support`/);
    assert.match(contract, /touch controls on mobile/);
    assert.match(contract, /keyboard\/mouse on desktop/);
  });
  it('Prompt B checks the declaration', () => {
    const b = CREATOR_PROMPTS.find((p) => p.id === 'b')!.text;
    assert.match(b, /Input support declaration: .*WARN if missing/);
    const item15 = b.split('\n').find((line) => line.startsWith('15. Input support declaration:'))!;
    assert.ok(item15, 'Prompt B must contain item 15');
    assert.ok(item15.includes('WARN for any other value'));
    assert.ok(item15.includes("WARN if the declared platforms don't match"));
    assert.doesNotMatch(item15, /FAIL/);
  });
  it('contract says the CDN CSP is the outer limit and the contract may be stricter', () => {
    assert.match(contract, /CSP is the outer safety limit; this contract may be stricter/);
  });
});
