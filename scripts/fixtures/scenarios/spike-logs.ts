// gh/logs-api (03 §3.3): the job-logs responses, captured with the exact argv ghx's apiText sends.
// ok-200-azure: a completed failed job (redirect followed to Azure Blob, BOM body, no rate headers).
// gone-410: logs past retention. blob-404-in-progress: a job still running (found live when possible).
import { defineScenario } from '../scenario-api.ts';

const logs = (repo: string, job: number | string) => [
  'api',
  '--include',
  '-X',
  'GET',
  `repos/${repo}/actions/jobs/${job}/logs`,
];

export default defineScenario({
  name: 'spike-logs',
  description: 'job-logs API: 200 via Azure redirect, 404 blob for a running job, 410 expired',
  source: 'live:public',
  outDirs: ['logs-api'],
  record(ctx) {
    ctx.capture('logs-api', 'ok-200-azure', logs('cli/cli', 119137909038), {
      stdoutFile: true,
      note: 'cli/cli job 119137909038 (failed, completed)',
    });
    ctx.capture('logs-api', 'gone-410', logs('cli/cli', 73871539329), {
      note: 'cli/cli job from before 2026-05: past log retention',
    });
    let running: { repo: string; id: number } | undefined;
    for (const repo of ['vercel/next.js', 'nodejs/node']) {
      const runs = ctx.gh([
        'api',
        `repos/${repo}/actions/runs?status=in_progress&per_page=5`,
        '--jq',
        '.workflow_runs[].id',
      ]);
      for (const runId of runs.stdout.split('\n').filter(Boolean)) {
        const jobs = ctx.gh([
          'api',
          `repos/${repo}/actions/runs/${runId}/jobs?per_page=100`,
          '--jq',
          '.jobs[] | select(.status=="in_progress") | .id',
        ]);
        const id = Number(jobs.stdout.split('\n')[0]);
        if (id) {
          running = { repo, id };
          break;
        }
      }
      if (running) break;
    }
    const live = running
      ? ctx.capture('logs-api', 'blob-404-in-progress', logs(running.repo, running.id), {
          note: `${running.repo} job ${running.id}, in progress at record time`,
        })
      : undefined;
    // The job may finish between the lookup and the fetch; only a real blob 404 is kept.
    if (!live || !/^HTTP\/\S+ 404/.test(live.stdout)) {
      ctx.write('logs-api', 'blob-404-in-progress', {
        argv: logs('nodejs/node', 119888519187),
        exitCode: 1,
        stdout:
          'HTTP/1.1 404 The specified blob does not exist.\r\nContent-Type: application/xml\r\nServer: Windows-Azure-Blob/1.0\r\n\r\n﻿<?xml version="1.0" encoding="utf-8"?><Error><Code>BlobNotFound</Code><Message>The specified blob does not exist.\nRequestId:00000000-0000-0000-0000-000000000000</Message></Error>',
        stderr: 'gh: HTTP 404\n',
        meta: { source: 'synthetic', note: 'no in-progress job found at record time; shape from spike 03 §3.3' },
      });
    }
  },
});
