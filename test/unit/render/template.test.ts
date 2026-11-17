// PR body templates (08 §2, §3): the grammar, every validation code, config load, and a custom template
// end to end (render, data placement, drift).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parseConfigText } from '../../../src/config/load.ts';
import { DEFAULT_FOOTER } from '../../../src/config/sections/render.ts';
import { isGhxError } from '../../../src/core/errors.ts';
import { readPrBlock } from '../../../src/meta/schemas.ts';
import type { PrCreateInput } from '../../../src/pr/create/schema.ts';
import { readBody, renderDataList, renderPrBody, toPrBlock } from '../../../src/render/pr-body.ts';
import {
  BUILTIN_TEMPLATES,
  layoutOf,
  renderTemplate,
  templateIssues,
  templateText,
} from '../../../src/render/template.ts';

const codes = (text: string, declared: readonly string[] = []) =>
  templateIssues(text, declared).map((i) => i.code.replace('render.prBody.', ''));

describe('templateText and layout', () => {
  test('a string and its lines are the same template; CRLF is normalised; mode picks a built-in', () => {
    const lines = ['## Notes', '', '{{description}}', '', '{{trailer}}'];
    assert.equal(templateText({ prBody: lines }), templateText({ prBody: lines.join('\r\n') }));
    assert.equal(templateText({ mode: 'details' }), BUILTIN_TEMPLATES.details);
    assert.equal(templateText({}), BUILTIN_TEMPLATES.trailer);
    assert.equal(templateText({ mode: 'details', prBody: 'x' }), 'x');
    assert.match(layoutOf(BUILTIN_TEMPLATES.trailer), /^[0-9a-f]{8}$/);
    assert.notEqual(layoutOf(BUILTIN_TEMPLATES.trailer), layoutOf(BUILTIN_TEMPLATES.details));
  });
});

describe('renderTemplate', () => {
  test('an empty paragraph is dropped; a partly empty one keeps its filled text', () => {
    const t = 'Intro.\n\n{{riskNote}}\n\nRisk {{risk}}{{riskNote}}.';
    assert.equal(renderTemplate(t, { risk: 'low' }), 'Intro.\n\nRisk low.');
  });

  test('a section whose placeholders are all empty goes with its heading; a literal-only one stays', () => {
    const t = '## A\n\n{{description}}\n\n## B\nLead-in text.\n\n{{data}}\n\n## C\n\nAlways here.';
    assert.equal(renderTemplate(t, { description: 'D' }), '## A\n\nD\n\n## C\n\nAlways here.');
    assert.equal(
      renderTemplate(t, { description: 'D', data: '- k: `v`' }),
      '## A\n\nD\n\n## B\n\nLead-in text.\n\n- k: `v`\n\n## C\n\nAlways here.',
    );
  });

  test('subsections: a parent with one filled subsection stays, its empty sibling goes', () => {
    const t = '## Parent\n\n### One\n\n{{risk}}\n\n### Two\n\n{{riskNote}}\n\n## Next\n\n{{trailer}}';
    assert.equal(renderTemplate(t, { risk: 'low', trailer: 'T' }), '## Parent\n\n### One\n\nlow\n\n## Next\n\nT');
    assert.equal(renderTemplate(t, { trailer: 'T' }), '## Next\n\nT');
  });

  test('values are never scanned again: a description containing {{trailer}} stays literal', () => {
    assert.equal(
      renderTemplate('{{description}}\n\n{{trailer}}', { description: 'see {{trailer}}', trailer: 'T' }),
      'see {{trailer}}\n\nT',
    );
  });
});

describe('templateIssues', () => {
  test('the built-in templates are valid', () => {
    assert.deepEqual(codes(BUILTIN_TEMPLATES.trailer), []);
    assert.deepEqual(codes(BUILTIN_TEMPLATES.details), []);
  });

  test('one code per problem', () => {
    const ok = '{{description}}\n\n{{trailer}}';
    assert.deepEqual(codes(`${ok}\n\n{{descripton}}`), ['unknown_placeholder']);
    assert.equal(templateIssues(`${ok}\n\n{{risknote}}`, [])[0]?.suggestion, 'riskNote');
    assert.deepEqual(codes(`${ok}\n\n{{data.ticket}}`), ['undeclared_data_key']);
    assert.deepEqual(codes(`${ok}\n\n{{data.ticket}}`, ['ticket']), []);
    assert.equal(templateIssues(`${ok}\n\n{{data.tikcet}}`, ['ticket'])[0]?.suggestion, 'data.ticket');
    assert.deepEqual(codes('{{trailer}}'), ['missing_required']);
    assert.deepEqual(codes(`${ok}\n\n{{risk}} and {{risk}}`), ['repeated']);
    assert.deepEqual(codes('Summary: {{description}}\n\n{{trailer}}'), ['not_alone']);
    assert.deepEqual(codes(`${ok}\n\n<!-- note -->`), ['html_comment']);
    assert.deepEqual(codes(`${ok}\n\nRisk: low · Components: app`), ['trailer_like']);
    assert.deepEqual(codes(`${ok}\n\n{{risk`), ['unterminated']);
    assert.deepEqual(codes(`## {{risk}}\n\n${ok}`), ['in_heading']);
    assert.deepEqual(codes(`${ok}\n\n${'x'.repeat(4000)}`), ['too_long']);
  });
});

describe('config', () => {
  const load = (render: unknown, data?: unknown) =>
    parseConfigText(JSON.stringify({ version: 1, components: { app: {} }, render, ...(data ? { data } : {}) }), {
      kind: 'default',
    });
  const issueCodes = (f: () => unknown) => {
    try {
      f();
    } catch (e) {
      assert.ok(isGhxError(e, 'CONFIG_INVALID'));
      return ((e.details?.issues ?? []) as { code: string }[]).map((i) => i.code);
    }
    assert.fail('expected CONFIG_INVALID');
  };

  test('a valid template loads; problems are CONFIG_INVALID with their codes', () => {
    const c = load(
      { prBody: ['## What', '', '{{description}}', '', '{{trailer}}', '', 'Ticket: {{data.ticket}}'] },
      {
        fields: { ticket: { type: 'string' } },
      },
    );
    assert.equal(templateText(c.render).startsWith('## What'), true);
    assert.deepEqual(
      issueCodes(() => load({ prBody: '{{description}}' })),
      ['render.prBody.missing_required'],
    );
    assert.deepEqual(
      issueCodes(() => load({ prBody: '{{description}}\n\n{{trailer}}\n\n{{data.k}}' })),
      ['render.prBody.undeclared_data_key'],
    );
    assert.deepEqual(
      issueCodes(() => load({ mode: 'details', prBody: '{{description}}\n\n{{trailer}}' })),
      ['render.prBody.conflicts_mode'],
    );
  });
});

describe('a custom template end to end', () => {
  const input: PrCreateInput = {
    title: 'feat(app): show a retry banner',
    description: 'Requests retried after a failure show a banner.',
    testing: [{ kind: 'unit', command: 'pnpm test', result: 'pass' }],
    risk: 'medium',
    riskNote: 'Every client sees the banner.',
    components: ['app'],
    revertPolicy: 'revert-safe',
    base: 'main',
    head: 'feat/x',
    data: { ticket: 'ENG-9', rollout: 'canary', extra: 'agent fact' },
  };
  const render = {
    mode: 'trailer' as const,
    footer: DEFAULT_FOOTER,
    declared: ['ticket', 'rollout'],
    prBody: [
      '## Why',
      '',
      '{{description}}',
      '',
      'Ticket: {{data.ticket}}',
      '',
      '## Risk',
      '',
      '{{riskNote}}',
      '',
      '{{trailer}}',
      '',
      '## Facts',
      '',
      '{{data}}',
    ],
  };
  const body = renderPrBody(toPrBlock(input, { id: 'p_k3m9qa', gen: 'ghx/0.1.0' }), render);

  test('placed data keys stay out of {{data}}; declared keys list first', () => {
    const visible = body.slice(0, body.indexOf('\n\n<!-- ghx:v1 '));
    assert.equal(
      visible,
      [
        '## Why',
        input.description,
        'Ticket: `ENG-9`',
        '## Risk',
        'Every client sees the banner.',
        'Risk: medium · Components: app · Revert: revert-safe · Tests: 1/1 pass (unit)',
        '## Facts',
        '- rollout: `canary`\n- extra: `agent fact`',
        DEFAULT_FOOTER,
      ].join('\n\n'),
    );
    assert.equal(renderDataList({ b: 1, a: 2, z: 3 }, ['z']), '- z: `3`\n- a: `2`\n- b: `1`');
  });

  test('the block records the layout; drift reads clean, and a template change is layout drift', () => {
    const read = readPrBlock(body);
    assert.equal(read.status, 'ok');
    if (read.status !== 'ok') return;
    assert.equal(read.block.layout, layoutOf(templateText(render)));
    assert.deepEqual(readBody(body, read.block, render).drift, []);
    assert.deepEqual(readBody(body, read.block, { ...render, prBody: undefined }).drift, ['layout']);
  });
});
