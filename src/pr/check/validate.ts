import type { GhxConfig } from '../../config/schema.ts';
import { type IssueDetail, mapZodIssues } from '../../core/errors.ts';
import { PrBlock, readBlocks, readPrBlock } from '../../meta/schemas.ts';
import { readBody, renderOptions } from '../../render/pr-body.ts';
import { riskRank } from '../../schemas/pr.ts';
import { structureIssues } from '../create/check.ts';
import { partialRules } from '../create/rules.ts';
import { PrCreateInput } from '../create/schema.ts';
import { deriveImpact, touchedComponents } from '../impact/derive.ts';
import type { ImpactPr } from '../impact/read.ts';

/** Validate stored metadata without applying write-time normalization or auto-filling omissions. */
export function validatePr(pr: ImpactPr, files: readonly string[], config: GhxConfig): IssueDetail[] {
  const issues: IssueDetail[] = [];
  const blocks = readBlocks(pr.body ?? '');
  if (blocks.filter((entry) => entry.status === 'ok' && entry.block.t === 'pr').length > 1) {
    issues.push({
      path: 'body',
      code: 'block.duplicate',
      message: 'The PR body must contain exactly one ghx PR metadata block.',
    });
  }
  for (const entry of blocks) {
    if (entry.status === 'invalid') {
      issues.push({ path: 'body', code: 'block.invalid', message: entry.error });
    } else if (entry.status !== 'ok' || entry.block.t !== 'pr') {
      issues.push({
        path: 'body',
        code: 'block.unexpected',
        message: 'The PR body contains a ghx block that is not PR metadata.',
      });
    }
  }
  const reading = readPrBlock(pr.body ?? '');
  if (reading.status !== 'ok') {
    return issues.length
      ? issues
      : [
          {
            path: 'body',
            code: reading.status === 'invalid' ? 'block.invalid' : 'block.missing',
            message: reading.status === 'invalid' ? reading.error : 'The PR has no ghx metadata block.',
          },
        ];
  }
  const block = reading.block;
  const strict = PrBlock.safeParse(block);
  if (!strict.success) issues.push(...mapZodIssues(strict.error));
  const value = {
    ...Object.fromEntries(
      Object.keys(PrCreateInput.shape)
        .filter((key) => key in block)
        .map((key) => [key, block[key]]),
    ),
    base: pr.base.ref,
    head: pr.head.ref,
  };
  const required = Object.entries(PrCreateInput.shape)
    .filter(([, field]) => !field.isOptional())
    .map(([key]) => key);
  const structure = structureIssues(value, PrCreateInput, required);
  issues.push(...structure.issues, ...partialRules(structure.parsed, { config }, structure.testingAt));
  const impact = deriveImpact(files, config.components);
  const actual = [...impact.components, ...impact.alsoTouched];
  const declared = [...block.components, ...(block.alsoTouched ?? [])];
  for (const component of actual.filter((name) => !declared.includes(name))) {
    issues.push({
      path: 'components',
      code: 'components.undeclared_touched',
      message: `The PR changes ${component}, but it is absent from components and alsoTouched.`,
    });
  }
  const touched = touchedComponents(files, config.components);
  const expectedOverflow = new Set(actual.filter((name) => !block.components.includes(name)));
  const storedOverflow = block.alsoTouched ?? [];
  if (
    storedOverflow.some((name) => !touched.has(name) || block.components.includes(name)) ||
    storedOverflow.some((name) => !expectedOverflow.has(name)) ||
    (expectedOverflow.size > 0 && (block.components.length !== 5 || storedOverflow.length !== expectedOverflow.size))
  ) {
    issues.push({
      path: 'alsoTouched',
      code: 'components.also_touched_drift',
      message: 'alsoTouched must contain exactly the touched components beyond the five declared primary components.',
    });
  }
  if (impact.riskFloor !== null && riskRank(block.risk) < riskRank(impact.riskFloor)) {
    issues.push({
      path: 'risk',
      code: 'risk.below_component_floor',
      message: `Changed paths require risk '${impact.riskFloor}' or higher.`,
    });
  }
  const visible = readBody(pr.body ?? '', block, renderOptions(config), pr.title);
  for (const field of visible.drift) {
    issues.push({
      path: field === 'title' ? 'title' : 'body',
      code: `block.drift.${field}`,
      message: `The visible PR ${field} differs from its metadata or current rendering config.`,
    });
  }
  if (visible.appended !== null)
    issues.push({
      path: 'body',
      code: 'block.drift.appended',
      message: 'The PR contains appended text outside the structured body.',
    });
  const seen = new Set<string>();
  return issues.filter((item) => {
    const key = JSON.stringify([item.path, item.code, item.message]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
