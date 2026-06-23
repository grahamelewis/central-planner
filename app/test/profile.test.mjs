// test/profile.test.mjs — parseProfileJson(): the fragile bit that turns a
// haiku reply into a stored profile, or rejects it. parseProfileJson is
// exported, but importing profile.js pulls the Agent SDK; we extract the REAL
// source of the function and run it in isolation (no SDK, no billing risk).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { loadPrivateFns, APP_DIR } from './helpers.mjs';

const { parseProfileJson } = loadPrivateFns(
  path.join(APP_DIR, 'lib', 'profile.js'), ['parseProfileJson']);

describe('parseProfileJson', () => {
  test('parses bare JSON with bio + 3 interests', () => {
    const r = parseProfileJson('{"bio":"I study evictions.","interests":["housing","law","data"]}');
    assert.deepEqual(r, { bio: 'I study evictions.', interests: ['housing', 'law', 'data'] });
  });

  test('extracts JSON from inside a ```json fenced block', () => {
    const txt = '```json\n{"bio":"X work.","interests":["a","b","c"]}\n```';
    const r = parseProfileJson(txt);
    assert.equal(r.bio, 'X work.');
    assert.deepEqual(r.interests, ['a', 'b', 'c']);
  });

  test('extracts JSON embedded in surrounding prose', () => {
    const txt = 'Sure! Here is the profile:\n{"bio":"Y.","interests":["p","q","r"]}\nHope that helps.';
    const r = parseProfileJson(txt);
    assert.equal(r.bio, 'Y.');
  });

  test('rejects fewer than 3 interests', () => {
    assert.equal(parseProfileJson('{"bio":"b","interests":["one","two"]}'), null);
  });

  test('accepts exactly 4 interests', () => {
    const r = parseProfileJson('{"bio":"b","interests":["a","b","c","d"]}');
    assert.equal(r.interests.length, 4);
  });

  test('caps interests at 4 (drops extras)', () => {
    const r = parseProfileJson('{"bio":"b","interests":["a","b","c","d","e","f"]}');
    assert.deepEqual(r.interests, ['a', 'b', 'c', 'd']);
  });

  test('filters out non-string and blank interests before the count check', () => {
    // after filtering: ["a","b","c"] -> valid
    const r = parseProfileJson('{"bio":"b","interests":["a",5,null,"  ","b","c"]}');
    assert.deepEqual(r.interests, ['a', 'b', 'c']);
  });

  test('rejects when non-string filtering leaves fewer than 3 interests', () => {
    assert.equal(parseProfileJson('{"bio":"b","interests":["a",5,null,"b"]}'), null);
  });

  test('rejects a missing/empty bio', () => {
    assert.equal(parseProfileJson('{"interests":["a","b","c"]}'), null);
    assert.equal(parseProfileJson('{"bio":"   ","interests":["a","b","c"]}'), null);
  });

  test('rejects a non-object / no JSON at all', () => {
    assert.equal(parseProfileJson('no json here'), null);
    assert.equal(parseProfileJson(''), null);
    assert.equal(parseProfileJson(null), null);
  });

  test('rejects malformed JSON', () => {
    assert.equal(parseProfileJson('{"bio":"b","interests":[}'), null);
  });

  test('trims and length-caps the bio (<=420 chars)', () => {
    const longBio = 'x'.repeat(500);
    const r = parseProfileJson(`{"bio":"  ${longBio}  ","interests":["a","b","c"]}`);
    assert.equal(r.bio.length, 420);
  });

  test('trims and length-caps each interest (<=48 chars)', () => {
    const longInterest = 'y'.repeat(80);
    const r = parseProfileJson(`{"bio":"b","interests":["  ${longInterest}  ","b","c"]}`);
    assert.equal(r.interests[0].length, 48);
  });
});
