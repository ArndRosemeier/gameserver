// Unit tests for client/cued.ts: `npm run test:cued` (node:test, no dependencies).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  CuedPassError,
  cuedPassFromHash,
  decodeCuedPass,
  hashWithoutCuedPass,
  isCuedPassExpired,
} from '../client/cued.ts';

/** Builds a pass exactly as cued does (HS256, compact JSON, base64url without padding). */
function makePass(claims: Record<string, unknown>, key = 'test-key', header: Record<string, unknown> = { alg: 'HS256', typ: 'JWT' }): string {
  const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64url');
  const head = b64(JSON.stringify(header));
  const body = b64(JSON.stringify(claims));
  const sig = createHmac('sha256', key).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

const CLAIMS = {
  iss: 'cued', aud: 'my-game', iat: 1000, exp: 1000 + 6 * 3600, sub: '7',
  name: 'Arnd Ü', kuerzel: 'A', hg: 'rgb(31, 58, 50)', schrift: 'rgb(124, 240, 208)', bild: '', raum: null,
  cued: 'https://cued.de/',
};

test('reads every claim, including non-ASCII names and a missing avatar', () => {
  const id = decodeCuedPass(makePass(CLAIMS));
  assert.equal(id.playerId, '7');
  assert.equal(id.name, 'Arnd Ü');
  assert.equal(id.initials, 'A');
  assert.deepEqual(id.circle, { background: 'rgb(31, 58, 50)', text: 'rgb(124, 240, 208)' });
  assert.equal(id.avatarUrl, null);
  assert.equal(id.game, 'my-game');
  assert.equal(id.room, null);
  assert.equal(id.portalUrl, 'https://cued.de/');
});

test('keeps an avatar URL and a room id', () => {
  const id = decodeCuedPass(makePass({ ...CLAIMS, bild: 'https://cued.de/gast/bild/x/', raum: 'r1' }));
  assert.equal(id.avatarUrl, 'https://cued.de/gast/bild/x/');
  assert.equal(id.room, 'r1');
});

test('fails loudly on malformed passes', () => {
  assert.throws(() => decodeCuedPass('not-a-jwt'), CuedPassError);
  assert.throws(() => decodeCuedPass('a.b.c'), CuedPassError);
  assert.throws(() => decodeCuedPass(makePass({ ...CLAIMS, iss: 'elsewhere' })), /issuer/);
  assert.throws(() => decodeCuedPass(makePass({ ...CLAIMS, name: '' })), /"name"/);
  assert.throws(() => decodeCuedPass(makePass({ ...CLAIMS, exp: 'soon' })), /"exp"/);
  assert.throws(() => decodeCuedPass(makePass(CLAIMS, 'k', { alg: 'none' })), /HS256/);
});

test('expires at exp, not one second later', () => {
  const id = decodeCuedPass(makePass(CLAIMS));
  assert.equal(isCuedPassExpired(id, CLAIMS.exp - 1), false);
  assert.equal(isCuedPassExpired(id, CLAIMS.exp), true);
});

test('finds the pass among other fragment keys and strips only it', () => {
  assert.equal(cuedPassFromHash(''), null);
  assert.equal(cuedPassFromHash('#detail=1'), null);
  assert.equal(cuedPassFromHash('#detail=1&cued=abc.def.ghi'), 'abc.def.ghi');
  assert.throws(() => cuedPassFromHash('#cued='), CuedPassError);
  assert.equal(hashWithoutCuedPass('#cued=abc.def.ghi'), '');
  assert.equal(hashWithoutCuedPass('#detail=1&cued=abc.def.ghi'), '#detail=1');
});
