// test/sessions.test.mjs — parseHandoff() and parseQuestion(): the protocol
// parsers that read Claude's final message. They are NOT exported, and
// importing sessions.js pulls the Agent SDK + data-reading modules, so we
// extract their REAL source text and run them in isolation. No billing risk.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { loadPrivateFns, APP_DIR } from './helpers.mjs';

const { parseHandoff, parseQuestion } = loadPrivateFns(
  path.join(APP_DIR, 'lib', 'sessions.js'), ['parseHandoff', 'parseQuestion']);

describe('parseHandoff', () => {
  test('parses a plain ```handoff fenced JSON block', () => {
    const txt = 'Done.\n\n```handoff\n{"summary":"finished","files":["a.py"]}\n```\n';
    assert.deepEqual(parseHandoff(txt), { summary: 'finished', files: ['a.py'] });
  });

  test('returns null when there is no handoff fence', () => {
    assert.equal(parseHandoff('just a normal message'), null);
    assert.equal(parseHandoff(''), null);
    assert.equal(parseHandoff(null), null);
  });

  test('handles handoff JSON that itself contains ``` fences (the hard case)', () => {
    // The summary string contains a code fence; a lazy match to the first ```
    // would truncate the JSON. The parser tries closing fences from the last
    // one backwards and must recover the full object.
    const inner = JSON.stringify({
      summary: 'I added a snippet:\n```python\nprint(1)\n```\nand it works',
      files: ['x.py'],
    }, null, 2);
    const txt = `Here is my handoff.\n\n\`\`\`handoff\n${inner}\n\`\`\`\n`;
    const r = parseHandoff(txt);
    assert.ok(r, 'should recover the object');
    assert.match(r.summary, /print\(1\)/);
    assert.deepEqual(r.files, ['x.py']);
  });

  test('uses the LAST ```handoff opener when several exist', () => {
    const txt = [
      '```handoff', '{"summary":"old"}', '```',
      'then revised:',
      '```handoff', '{"summary":"new"}', '```',
    ].join('\n');
    assert.deepEqual(parseHandoff(txt), { summary: 'new' });
  });

  test('returns null when the fenced body is not valid JSON', () => {
    const txt = '```handoff\nnot json at all\n```';
    assert.equal(parseHandoff(txt), null);
  });

  test('returns null for a JSON primitive (not an object)', () => {
    assert.equal(parseHandoff('```handoff\n42\n```'), null);
  });

  test('returns null when the opener has no following newline', () => {
    assert.equal(parseHandoff('```handoff'), null);
  });

  test('tolerates indentation/whitespace on the closing fence line', () => {
    const txt = '```handoff\n{"summary":"ok"}\n   ```   \n';
    assert.deepEqual(parseHandoff(txt), { summary: 'ok' });
  });
});

describe('parseQuestion', () => {
  test('extracts the text after a QUESTION: line', () => {
    assert.equal(parseQuestion('blah\nQUESTION: which path?\nmore'), 'which path?');
  });

  test('trims surrounding whitespace', () => {
    assert.equal(parseQuestion('QUESTION:    spaced out   '), 'spaced out');
  });

  test('matches QUESTION: only at the start of a line', () => {
    assert.equal(parseQuestion('a NON-QUESTION: not this'), null);
  });

  test('returns the FIRST question when several lines match', () => {
    assert.equal(parseQuestion('QUESTION: first?\nQUESTION: second?'), 'first?');
  });

  test('returns null when there is no QUESTION line', () => {
    assert.equal(parseQuestion('no question here'), null);
    assert.equal(parseQuestion(''), null);
    assert.equal(parseQuestion(null), null);
  });

  test('handles an empty question body', () => {
    assert.equal(parseQuestion('QUESTION:'), '');
  });
});
