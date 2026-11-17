// Title validation shared by create, edit, and CI checking.
import { matchesTicket } from '../../config/sections/title.ts';
import type { IssueDetail } from '../../core/errors.ts';
import { componentList, suggestComponent } from './components.ts';
import type { CreateRuleContext, PartialRulesInput } from './rules.ts';

export const TITLE_MAX_CODE_POINTS = 72;
const issue = (path: string, code: string, message: string): IssueDetail => ({ path, code, message });

// ── title ────────────────────────────────────────────────────────────────
// 02 §2.1's format is `^(types)(\(([a-z0-9][a-z0-9-]*)\))?(!)?: \S.*$`. The title is parsed loosely first,
// so that a defect gets its own code (multi_scope, whitespace) instead of a generic title.format.
const TITLE_LOOSE = /^([^\s():!]+)(?:\(([^()]*)\))?(!)?: (\S.*)$/;
const SCOPE = /^[a-z0-9][a-z0-9-]*$/;

export function titleRules(input: PartialRulesInput, ctx: CreateRuleContext): IssueDetail[] {
  const out: IssueDetail[] = [];
  const { title } = input;
  if (title === undefined) return out;
  const { types, scopeRequired } = ctx.config.title;
  const norm = title.trim().replace(/\s+/g, ' ');
  const m = TITLE_LOOSE.exec(norm);
  const ticket = ctx.config.title.format === 'ticket' ? ctx.config.title.ticket : undefined;
  const formatIssue = (why: string) =>
    issue('title', 'title.format', `${why}; expected 'type(scope): summary' with type one of ${types.join(', ')}`);

  if (ctx.config.title.format === 'ticket') {
    const match = /^([^\s:]+): (\S.*)$/.exec(norm);
    if (!ticket || !match || !matchesTicket(match[1] ?? '', ticket.pattern)) {
      out.push(
        issue(
          'title',
          'title.format',
          `expected a ticket key matching ${ticket?.pattern ?? 'the configured pattern'}, then ': summary'`,
        ),
      );
    }
  } else if (!m) {
    out.push(formatIssue(`'${norm}' is not a conventional-commit title`));
  } else {
    const [, type = '', scope] = m;
    let formatOk = true;
    if (!types.includes(type)) {
      formatOk = false;
      out.push(formatIssue(`type '${type}' is not allowed`));
    } else if (scope?.includes(',')) {
      formatOk = false;
      const parts = scope.split(',').map((s) => s.trim());
      if (parts.every((p) => SCOPE.test(p))) {
        out.push(
          issue(
            'title',
            'title.multi_scope',
            `scope '${scope}' names several components; use one scope and list the rest in components`,
          ),
        );
      } else out.push(formatIssue(`scope '${scope}' is not a lowercase token`));
    } else if (scope !== undefined && !SCOPE.test(scope)) {
      formatOk = false;
      out.push(formatIssue(scope === '' ? 'empty scope ()' : `scope '${scope}' is not a lowercase token`));
    }

    if (formatOk) {
      if (scope === undefined) {
        if (scopeRequired) {
          out.push(issue('title', 'title.scope_missing', 'this repo requires a scope: type(component): summary'));
        }
      } else if (!Object.hasOwn(ctx.config.components, scope)) {
        const d = issue(
          'title',
          'title.scope_not_component',
          `scope '${scope}' is not a component in .github/ghx.json; the scope must be a component name (${componentList(ctx.config.components)}), or drop the scope`,
        );
        const s = suggestComponent(scope, ctx.config.components)[0];
        if (s !== undefined) d.suggestion = s;
        out.push(d);
      } else if (input.components !== undefined && !input.components.includes(scope)) {
        out.push(issue('title', 'title.scope_not_declared', `scope '${scope}' must also be listed in components`));
      }
      if (type === 'revert' && input.refs?.reverts === undefined) {
        out.push(
          issue('title', 'title.revert_needs_ref', "a revert title needs refs.reverts (the PR it reverts, '#N')"),
        );
      }
    }
  }

  const codePoints = [...title].length;
  if (codePoints > TITLE_MAX_CODE_POINTS) {
    out.push(
      issue(
        'title',
        'title.too_long',
        `${codePoints} code points; at most ${TITLE_MAX_CODE_POINTS}. Shorten the summary`,
      ),
    );
  }
  if (/\s\(#\d+\)$/.test(norm)) {
    out.push(issue('title', 'title.pr_suffix', "remove the ' (#N)' suffix; GitHub adds the PR number on merge"));
  }
  if (title !== norm) {
    out.push(issue('title', 'title.whitespace', 'remove leading, trailing or repeated whitespace'));
  }
  if (norm.endsWith('.')) {
    out.push(issue('title', 'title.trailing_period', 'remove the trailing period'));
  }
  return out;
}
