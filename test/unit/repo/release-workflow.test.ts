import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { readJson, ROOT } from '../../helpers/repo';

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}

interface Workflow {
  on: {
    push: { tags: string[] };
    workflow_dispatch?: unknown;
  };
  permissions: Record<string, string>;
  jobs: Record<string, { steps: Step[] }>;
}

const workflow = parse(
  readFileSync(join(ROOT, '.github/workflows/release.yml'), 'utf8'),
) as Workflow;
const steps = Object.values(workflow.jobs).flatMap((job) => job.steps);
const runs = steps.flatMap((step) => (step.run === undefined ? [] : [step.run]));
const { scripts, version } = readJson('package.json') as {
  scripts: Record<string, string>;
  version: string;
};

describe('.github/workflows/release.yml (V1.28)', () => {
  it('fires on version tags only, not on the step tags', () => {
    expect(workflow.on.push.tags).toEqual(['v[0-9]+.[0-9]+.[0-9]+']);
    // `V1.3` marks a finished step and must never publish anything.
    for (const pattern of workflow.on.push.tags) {
      expect(pattern.startsWith('V')).toBe(false);
    }
  });

  it('can also be started by hand, defaulting to a dry run', () => {
    expect(workflow.on.workflow_dispatch).toBeDefined();
    const raw = readFileSync(join(ROOT, '.github/workflows/release.yml'), 'utf8');
    expect(raw).toContain('dry-run');
    expect(raw).toMatch(/dry-run[\s\S]*default: true/);
  });

  it('runs the same gate as CI before publishing anything', () => {
    for (const script of ['npm run lint', 'npm run typecheck', 'npm test', 'npm run test:e2e']) {
      expect(runs, `${script} is missing`).toContain(script);
    }
  });

  it('refuses to publish when the tag and package.json disagree', () => {
    expect(runs.some((run) => run.includes('does not match package.json version'))).toBe(true);
  });

  it('packages with the project script, so .vscodeignore applies', () => {
    expect(runs).toContain('npm run package');
    expect(scripts.package).toContain('--no-dependencies');
  });

  it('publishes to Open VSX with the token from secrets, never a literal', () => {
    const publish = steps.find((step) => step.name === 'Publish to Open VSX');
    expect(publish).toBeDefined();
    expect(publish?.env?.OPEN_VSX_TOKEN).toBe('${{ secrets.OPEN_VSX_TOKEN }}');
    expect(publish?.run).toContain('ovsx publish');
    // The token is read from the environment, so it never lands in the log.
    expect(publish?.run).toContain('"$OPEN_VSX_TOKEN"');
  });

  it('does not publish on a manual dry run', () => {
    const publish = steps.find((step) => step.name === 'Publish to Open VSX');
    expect(publish?.if).toContain('inputs.dry-run != true');
    expect(publish?.if).toContain("startsWith(github.ref, 'refs/tags/v')");
  });

  it('skips publishing a version that is already on Open VSX', () => {
    // Open VSX accepts a version once; a re-run of the workflow must stay green.
    const check = steps.find((step) => step.name?.startsWith('Check whether this version'));
    expect(check?.run).toContain('open-vsx.org/api/datanest/datanest/');
    const publish = steps.find((step) => step.name === 'Publish to Open VSX');
    expect(publish?.if).toContain("steps.published.outputs.already == 'false'");
  });

  it('keeps the .vsix as an artifact and on the GitHub release', () => {
    expect(steps.some((step) => step.uses?.startsWith('actions/upload-artifact'))).toBe(true);
    expect(steps.some((step) => step.uses?.startsWith('softprops/action-gh-release'))).toBe(true);
  });

  it('asks for no more permission than writing the release', () => {
    expect(workflow.permissions).toEqual({ contents: 'write' });
  });

  it('matches the version being released', () => {
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
