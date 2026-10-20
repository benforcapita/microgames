import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MAX_THUMB_BASE64, publishForm, replaceBlocker, updateFiles } from './api-games.ts';
import { THUMB_REQUIRED, validateGameUpload } from './server/upload.ts';

const HTML = '<html><body><canvas></canvas><script>1</script></body></html>';

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}

const thumbnail = { data: Buffer.from(png(320, 180)).toString('base64'), type: 'image/png' };
const noFork = async () => null;

describe('publishForm', () => {
  it('builds a form that passes the upload rules', async () => {
    const parsed = publishForm({
      title: 'Sky Loop',
      license: 'MIT',
      html: HTML,
      tagline: 'Loop the sky',
      tags: ['arcade', 'flying'],
      thumbnail,
      agreeToContentRules: true,
    });
    assert.ok('form' in parsed);
    const { errors, upload } = await validateGameUpload(parsed.form, noFork);
    assert.deepEqual(errors, []);
    assert.equal(upload?.title, 'Sky Loop');
    assert.equal(upload?.tagsRaw, 'arcade, flying');
    assert.equal(upload?.thumb.ext, 'png');
    assert.equal(new TextDecoder().decode(upload?.html), HTML);
  });

  it('leaves missing consent, html and thumbnail to the upload rules', async () => {
    const parsed = publishForm({ title: 'Sky Loop', license: 'MIT', agreeToContentRules: 'yes' });
    assert.ok('form' in parsed);
    const { errors } = await validateGameUpload(parsed.form, noFork);
    assert.ok(errors.includes('You must confirm the content rules.'));
    assert.ok(errors.includes('Attach your game as a single .html file.'));
    assert.ok(errors.includes(THUMB_REQUIRED));
  });

  it('rejects a non-object body and a malformed or oversized thumbnail', () => {
    assert.ok('error' in publishForm(null));
    assert.ok('error' in publishForm([]));
    assert.ok('error' in publishForm({ thumbnail: 'abc' }));
    assert.ok('error' in publishForm({ thumbnail: { data: 'x'.repeat(MAX_THUMB_BASE64 + 1), type: 'image/png' } }));
  });
});

describe('updateFiles', () => {
  it('returns the game file and optional thumbnail', async () => {
    const files = updateFiles({ html: HTML, thumbnail });
    assert.ok('game' in files);
    assert.equal(await files.game?.text(), HTML);
    assert.equal(files.game?.name, 'game.html');
    assert.equal(files.thumb?.type, 'image/png');
    const bare = updateFiles({});
    assert.ok('game' in bare && bare.game === null && bare.thumb === null);
  });
});

describe('replaceBlocker', () => {
  it('only lets unpublished games without uploaded assets take a new bundle', () => {
    assert.equal(replaceBlocker('pending', false), null);
    assert.equal(replaceBlocker('rejected', false), null);
    assert.match(replaceBlocker('proving', false) ?? '', /published/);
    assert.match(replaceBlocker('live', false) ?? '', /published/);
    assert.match(replaceBlocker('pending', true) ?? '', /asset/);
  });
});
