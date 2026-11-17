// `pr review` input and its offline rules (02 §7.2). The rules are a function, not a superRefine, so the
// schema still exports to JSON Schema; the handler runs both and reports every issue at once.
// `finding.path_not_in_pr` needs the PR's file list and is checked by the command.
import { z } from 'zod';
import type { IssueDetail } from '../../core/errors.ts';
import { Body, OneLine, RepoPath } from '../../schemas/common.ts';
import { DataKey } from '../../schemas/data.ts';
import { Evidence } from '../../schemas/evidence.ts';
import { Location, Severity, Side, Verdict } from '../../schemas/pr.ts';

export const FindingInput = z.strictObject({
  severity: Severity,
  path: RepoPath.optional(),
  line: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
  side: Side.default('RIGHT'),
  alsoAt: z.array(Location).max(10).default([]),
  title: OneLine(100),
  body: Body(2000, 30),
  suggestion: z.string().max(2000).optional(),
  source: DataKey.optional(),
  evidence: Evidence.optional(),
});

export const PrReviewInput = z.strictObject({
  verdict: Verdict,
  summary: Body(400, 3),
  scope: OneLine(200).optional(),
  findings: z.array(FindingInput).max(50).default([]),
});

export type FindingInput = z.infer<typeof FindingInput>;
export type PrReviewInput = z.infer<typeof PrReviewInput>;

export function reviewRules(r: PrReviewInput): IssueDetail[] {
  const issues: IssueDetail[] = [];
  if (r.verdict === 'approve') {
    r.findings.forEach((f, i) => {
      if (f.severity === 'high') {
        issues.push({
          path: `findings[${i}].severity`,
          code: 'review.approve_with_high',
          message: 'an approve cannot carry a high finding; use request-changes or lower the severity',
        });
      }
    });
  }
  if (r.verdict === 'request-changes' && r.findings.length === 0) {
    issues.push({
      path: 'findings',
      code: 'review.request_changes_without_findings',
      message: 'request-changes needs at least one finding',
    });
  }
  const seen = new Set<string>();
  r.findings.forEach((f, i) => {
    if ((f.path === undefined) !== (f.line === undefined)) {
      issues.push({
        path: `findings[${i}]`,
        code: 'finding.location',
        message: 'path and line must be provided together',
      });
    } else if (f.path === undefined) {
      if (f.evidence === undefined) {
        issues.push({
          path: `findings[${i}].evidence`,
          code: 'finding.evidence_required',
          message: 'a finding without a path and line requires evidence',
        });
      }
      if (f.endLine !== undefined || f.alsoAt.length > 0 || f.suggestion !== undefined || f.side !== 'RIGHT') {
        issues.push({
          path: `findings[${i}]`,
          code: 'finding.location_fields',
          message: 'endLine, side, alsoAt and suggestion require a path and line',
        });
      }
    }
    if (f.endLine !== undefined && f.line !== undefined && f.endLine < f.line) {
      issues.push({
        path: `findings[${i}].endLine`,
        code: 'finding.range',
        message: `endLine ${f.endLine} < line ${f.line}`,
      });
    }
    const key = JSON.stringify([f.path, f.line, f.title]);
    if (seen.has(key)) {
      issues.push({
        path: `findings[${i}]`,
        code: 'finding.duplicate',
        message: `repeats ${f.path !== undefined ? `${f.path}:${f.line}` : 'an unlocated finding'} "${f.title}"`,
      });
    }
    seen.add(key);
  });
  return issues;
}
