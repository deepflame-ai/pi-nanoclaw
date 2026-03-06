import fs from 'fs';
import path from 'path';

import { describe, expect, it } from 'vitest';

describe('pi replacement audit', () => {
  it('container agent-runner package removes Claude Agent SDK dependency', () => {
    const pkgPath = path.join(
      process.cwd(),
      'container',
      'agent-runner',
      'package.json',
    );
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as {
      dependencies?: Record<string, string>;
    };

    expect(
      pkg.dependencies?.['@anthropic-ai/claude-agent-sdk'],
    ).toBeUndefined();
    expect(pkg.dependencies?.['@mariozechner/pi-coding-agent']).toBeDefined();
  });

  it('container dockerfile does not install Claude Code CLI', () => {
    const dockerfilePath = path.join(process.cwd(), 'container', 'Dockerfile');
    const dockerfile = fs.readFileSync(dockerfilePath, 'utf-8');

    expect(dockerfile).not.toContain('@anthropic-ai/claude-code');
  });

  it('agent runner source imports pi sdk, not claude agent sdk', () => {
    const runnerPath = path.join(
      process.cwd(),
      'container',
      'agent-runner',
      'src',
      'index.ts',
    );
    const src = fs.readFileSync(runnerPath, 'utf-8');

    expect(src).toContain('@mariozechner/pi-coding-agent');
    expect(src).not.toContain('@anthropic-ai/claude-agent-sdk');
    expect(src).not.toContain('mcp__nanoclaw__');
  });

  it('host mounts pi agent home instead of claude home', () => {
    const runnerPath = path.join(process.cwd(), 'src', 'container-runner.ts');
    const src = fs.readFileSync(runnerPath, 'utf-8');

    expect(src).toContain("containerPath: '/home/node/.pi/agent'");
    expect(src).not.toContain("containerPath: '/home/node/.claude'");
  });

  it('readSecrets no longer forwards Claude Code oauth token', () => {
    const runnerPath = path.join(process.cwd(), 'src', 'container-runner.ts');
    const src = fs.readFileSync(runnerPath, 'utf-8');

    expect(src).not.toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(src).toContain("'ANTHROPIC_API_KEY'");
  });

  it('documents e2e replacement specification', () => {
    const specPath = path.join(
      process.cwd(),
      'docs',
      'PI_REPLACEMENT_E2E_SPEC.md',
    );
    const spec = fs.readFileSync(specPath, 'utf-8');

    expect(spec).toContain('E2E-00');
    expect(spec).toContain('E2E-10');
    expect(spec).toContain('Migration Success Criteria');
  });
});
