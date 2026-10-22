import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  botSummary,
  displayLogin,
  isBotAuthor,
  isBotItem,
  loginMatches,
  markerOf,
  markersIn,
} from '../../../src/feedback/bots.ts';
import { normalizeAssociation, trustOf } from '../../../src/feedback/trust.ts';
import { configWith } from './_fixture.ts';

const cfg = configWith({
  trust: { bots: ['ghx-runner[bot]'] },
  bots: { logins: ['Renovate'], markers: ['ci-duration-watch'] },
});

test('trust: OWNER, MEMBER and COLLABORATOR by default; trust.bots by login; unknown associations fail closed', () => {
  for (const a of ['OWNER', 'MEMBER', 'COLLABORATOR']) assert.deepEqual(trustOf('u', a, cfg.trust), { trusted: true });
  for (const a of ['CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'FIRST_TIMER', 'MANNEQUIN', 'NONE', 'SUPERUSER']) {
    assert.equal(trustOf('u', a, cfg.trust).trusted, false, a);
  }
  assert.equal(normalizeAssociation('SUPERUSER'), 'NONE');
  assert.deepEqual(trustOf('ghx-runner', 'NONE', cfg.trust), { trusted: true });
  assert.deepEqual(trustOf('other[bot]', 'NONE', cfg.trust), {
    trusted: false,
    reason: 'untrusted author other[bot] (NONE)',
  });
  const narrow = configWith({ trust: { associations: ['OWNER'] } });
  assert.equal(trustOf('u', 'MEMBER', narrow.trust).trusted, false);
});

test('displayLogin adds [bot] for GraphQL Bot actors and maps a deleted author to ghost', () => {
  assert.equal(displayLogin({ __typename: 'Bot', login: 'github-actions' }), 'github-actions[bot]');
  assert.equal(displayLogin({ __typename: 'Bot', login: 'x[bot]' }), 'x[bot]');
  assert.equal(displayLogin({ __typename: 'User', login: 'maria-dev' }), 'maria-dev');
  assert.equal(displayLogin(null), 'ghost');
  assert.ok(loginMatches('renovate[bot]', 'Renovate'));
  assert.ok(!loginMatches('renovator', 'renovate'));
});

test('bot detection by actor, suffix, bots.logins and bots.markers', () => {
  assert.ok(isBotAuthor({ __typename: 'Bot', login: 'copilot-pull-request-reviewer' }, cfg.bots));
  assert.ok(isBotAuthor({ login: 'dependabot[bot]' }, cfg.bots));
  assert.ok(isBotAuthor({ __typename: 'User', login: 'renovate' }, cfg.bots));
  assert.ok(!isBotAuthor({ __typename: 'User', login: 'maria-dev' }, cfg.bots));
  assert.ok(!isBotAuthor(null, cfg.bots));
  assert.ok(isBotItem({ login: 'maria-dev' }, '<!-- ci-duration-watch -->\nslow', cfg.bots));
  assert.ok(!isBotItem({ login: 'maria-dev' }, '<!-- todo -->\nslow', cfg.bots));
});

test('markers: ghx blocks are not markers; a configured marker is preferred', () => {
  const body = '<!-- other -->\n<!-- ci-duration-watch -->\n<!-- ghx:v1 {"t":"x"} -->';
  assert.deepEqual(markersIn(body), ['other', 'ci-duration-watch']);
  assert.equal(markerOf(body, cfg.bots), 'ci-duration-watch');
  assert.equal(markerOf('<!-- other -->', cfg.bots), 'other');
  assert.equal(markerOf('none', cfg.bots), null);
});

test('botSummary is the first visible line, at most 400 code points', () => {
  assert.equal(botSummary('<!-- m -->\n\n  ⚠️ Slow CI  \nmore'), '⚠️ Slow CI');
  assert.equal([...botSummary('😀'.repeat(500))].length, 400);
  assert.equal(botSummary('<!-- only a marker -->'), '');
});
