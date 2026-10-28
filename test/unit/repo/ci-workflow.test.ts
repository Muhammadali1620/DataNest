import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { readJson, ROOT } from '../../helpers/repo';

interface Step {
  uses?: string;
  run?: string;
  if?: string;
  with?: Record<string, unknown>;
}

interface Job {
  'runs-on': string;
  'timeout-minutes'?: number;
  needs?: string[];
  strategy?: { matrix: { os: string[] } };
  steps: Step[];
}

interface Workflow {
  on: { push: { branches: string[]; tags: string[] }; pull_request: unknown };
  permissions: Record<string, string>;
  env: { NODE_VERSION: number };
  jobs: Record<string, Job>;
}

const workflow = parse(readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8')) as Workflow;
const jobs = Object.entries(workflow.jobs);
const { scripts, engines } = readJson('package.json') as {
  scripts: Record<string, string>;
  engines: { node: string };
};

function runs(job: Job): string[] {
  return job.steps.flatMap((step) => (step.run ? [step.run] : []));
}

const ALL_OS = ['ubuntu-latest', 'windows-latest', 'macos-latest'];

describe('.github/workflows/ci.yml (V0.11)', () => {
  it('runs on pushes to main, step tags and pull requests', () => {
    expect(workflow.on.push.branches).toEqual(['main']);
    expect(workflow.on.push.tags).toContain('V*');
    expect(workflow.on).toHaveProperty('pull_request');
  });

  it('gives jobs read-only access to the repository', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' });
  });

  it('uses the Node major version from engines', () => {
    expect(engines.node).toMatch(new RegExp(`^>=${workflow.env.NODE_VERSION}\\.`));
  });

  it.each(jobs)('installs %s dependencies with npm ci from the lockfile', (_name, job) => {
    const commands = runs(job);
    expect(commands).toContain('npm ci');
    expect(commands).not.toContain('npm install');
    const setupNode = job.steps.find((step) => step.uses?.startsWith('actions/setup-node@'));
    expect(setupNode?.with).toMatchObject({ cache: 'npm' });
  });

  it.each(jobs)('limits the run time of %s', (_name, job) => {
    expect(job['timeout-minutes']).toBeGreaterThan(0);
    expect(job['timeout-minutes']).toBeLessThanOrEqual(30);
  });

  it('pins every action to a release, never a branch', () => {
    const uses = jobs.flatMap(([, job]) => job.steps.flatMap((s) => (s.uses ? [s.uses] : [])));
    expect(uses.length).toBeGreaterThan(0);
    for (const action of uses) {
      expect(action).toMatch(/^actions\/[a-z-]+@v\d+$/);
    }
  });

  it('calls only npm scripts that exist', () => {
    const commands = jobs.flatMap(([, job]) => runs(job));
    for (const command of commands) {
      for (const match of command.matchAll(/npm run ([\w:-]+)/g)) {
        expect(Object.keys(scripts)).toContain(match[1]);
      }
    }
  });

  it('checks lint, types and known vulnerabilities', () => {
    const commands = runs(workflow.jobs.check ?? ({ steps: [] } as unknown as Job));
    expect(commands).toEqual(
      expect.arrayContaining(['npm run lint', 'npm run typecheck', 'npm audit --audit-level=high']),
    );
  });

  it('runs unit and e2e tests on Linux, Windows and macOS', () => {
    expect(workflow.jobs.unit?.strategy?.matrix.os).toEqual(ALL_OS);
    expect(workflow.jobs.e2e?.strategy?.matrix.os).toEqual(ALL_OS);
    expect(runs(workflow.jobs.unit ?? ({ steps: [] } as unknown as Job))).toContain(
      'npm run test:coverage',
    );
  });

  it('gives VS Code a virtual display on Linux', () => {
    const linux = workflow.jobs.e2e?.steps.find((s) => s.if === "runner.os == 'Linux'");
    expect(linux?.run).toMatch(/ xvfb-run -a npm run test:e2e$/);
  });

  it('repeats e2e failures as annotations, which can be read without a token', () => {
    const runs = (workflow.jobs.e2e?.steps ?? []).flatMap((s) => (s.run ? [s.run] : []));
    const e2e = runs.filter((run) => run.includes('npm run test:e2e'));
    expect(e2e).toHaveLength(2);
    for (const run of e2e) {
      expect(run.startsWith('node scripts/annotate-failures.mjs ')).toBe(true);
    }
  });

  it('runs integration tests against the compose databases and always stops them', () => {
    const steps = workflow.jobs.integration?.steps ?? [];
    const commands = steps.flatMap((s) => (s.run ? [s.run] : []));
    expect(commands.indexOf('npm run db:up')).toBeLessThan(
      commands.indexOf('npm run test:integration'),
    );
    expect(steps.find((s) => s.run === 'npm run db:down')?.if).toBe('always()');
  });

  it('packages the .vsix after checks pass and keeps it as an artifact', () => {
    const job = workflow.jobs.package;
    expect(job?.needs).toEqual(['check', 'unit']);
    expect(runs(job ?? ({ steps: [] } as unknown as Job))).toContain('npm run package');
    const upload = job?.steps.find((s) => s.uses?.startsWith('actions/upload-artifact@'));
    expect(upload?.with).toMatchObject({ path: '*.vsix', 'if-no-files-found': 'error' });
  });
});
