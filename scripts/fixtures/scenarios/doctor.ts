// gh/doctor-* (01 commit 14): the live `gh --version` and `gh pr checks --help`, plus auth-status
// variants built on the live `gh auth status --json hosts` shape (login aliased, states varied).
import { defineScenario, type RecordContext } from '../scenario-api.ts';

const AUTH = ['auth', 'status', '--json', 'hosts'];

function account(over: Record<string, unknown>) {
  return {
    state: 'success',
    active: true,
    host: 'github.com',
    login: 'viewer-user',
    tokenSource: 'keyring',
    scopes: 'gist, read:org, repo, workflow',
    gitProtocol: 'ssh',
    ...over,
  };
}

export default defineScenario({
  name: 'doctor',
  description: 'gh version, feature probes and auth states for ghx doctor',
  source: 'live:public',
  outDirs: ['doctor-ok', 'doctor-unauthenticated', 'doctor-bad-token', 'doctor-no-repo-scope', 'doctor-old'],
  record(ctx: RecordContext) {
    const synthetic = (note: string) => ({ source: 'synthetic', note });
    const auth = (dir: string, hosts: unknown, note: string) =>
      ctx.write(dir, '002-auth-status', {
        argv: AUTH,
        exitCode: 0,
        stdout: `${JSON.stringify({ hosts })}\n`,
        stderr: '',
        meta: synthetic(note),
      });
    for (const dir of ['doctor-ok', 'doctor-unauthenticated', 'doctor-bad-token', 'doctor-no-repo-scope']) {
      ctx.capture(dir, '001-version', ['--version']);
      ctx.capture(dir, '003-pr-checks-help', ['pr', 'checks', '--help']);
    }
    auth(
      'doctor-ok',
      { 'github.com': [account({})] },
      `gh auth status --json hosts shape (gh ${ctx.ghVersion}), login aliased`,
    );
    auth('doctor-unauthenticated', {}, 'no logged-in host');
    auth(
      'doctor-bad-token',
      {
        'github.com': [
          account({
            state: 'error',
            tokenSource: 'GH_TOKEN',
            scopes: undefined,
            gitProtocol: undefined,
            error: 'HTTP 401: Bad credentials (https://api.github.com/)',
          }),
        ],
      },
      'active account in error state',
    );
    auth(
      'doctor-no-repo-scope',
      { 'github.com': [account({ scopes: 'gist, read:org' })] },
      'token without the repo scope',
    );
    const help = ctx.gh(['pr', 'checks', '--help']).stdout;
    const noJson = help
      .split('\n')
      .filter(
        (l) =>
          !/--json|--jq|--template|JSON FIELDS|^\s+(bucket|completedAt|description|event|link|name|startedAt|state|workflow)$/.test(
            l,
          ),
      )
      .join('\n');
    ctx.write('doctor-old', '001-version', {
      argv: ['--version'],
      exitCode: 0,
      stdout: 'gh version 2.40.1 (2023-12-13)\nhttps://github.com/cli/cli/releases/tag/v2.40.1\n',
      stderr: '',
      meta: synthetic('a gh older than MIN_GH_VERSION'),
    });
    ctx.write('doctor-old', '002-auth-status', {
      argv: AUTH,
      exitCode: 1,
      stdout: '',
      stderr: 'unknown flag: --json\n\nUsage:  gh auth status [flags]\n',
      meta: synthetic('gh < 2.81.0 has no auth status --json'),
    });
    ctx.write('doctor-old', '003-pr-checks-help', {
      argv: ['pr', 'checks', '--help'],
      exitCode: 0,
      stdout: noJson,
      stderr: '',
      meta: synthetic('gh < 2.50.0: pr checks --help without --json'),
    });
  },
});
