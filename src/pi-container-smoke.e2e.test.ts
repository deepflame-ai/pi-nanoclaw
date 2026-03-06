import { execSync, spawnSync } from 'child_process';

import { describe, expect, it } from 'vitest';

const runDockerE2E = process.env.RUN_DOCKER_E2E === '1';
const itIfDocker = runDockerE2E ? it : it.skip;

function hasDocker(): boolean {
  try {
    execSync('docker info >/dev/null 2>&1', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function hasImage(name: string): boolean {
  try {
    execSync(`docker image inspect ${name} >/dev/null 2>&1`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

describe('pi container smoke e2e', () => {
  itIfDocker(
    'runner emits marker-wrapped JSON output via container entrypoint',
    () => {
      if (!hasDocker()) {
        throw new Error('Docker is not available.');
      }
      if (!hasImage('nanoclaw-agent:latest')) {
        throw new Error(
          'Image nanoclaw-agent:latest not found. Build it via ./container/build.sh first.',
        );
      }

      const payload = JSON.stringify({
        prompt: 'What is 2+2?',
        groupFolder: 'test',
        chatJid: 'test@g.us',
        isMain: false,
      });

      const run = spawnSync(
        'docker',
        ['run', '-i', '--rm', 'nanoclaw-agent:latest'],
        {
          input: payload,
          encoding: 'utf-8',
        },
      );

      // Runner may return non-zero when no model/API key is configured.
      // We assert protocol compatibility regardless of success/error status.
      expect(run.status).not.toBeNull();
      const out = run.stdout || '';

      expect(out).toContain('---NANOCLAW_OUTPUT_START---');
      expect(out).toContain('---NANOCLAW_OUTPUT_END---');

      const start = out.indexOf('---NANOCLAW_OUTPUT_START---');
      const end = out.indexOf('---NANOCLAW_OUTPUT_END---', start);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeGreaterThan(start);

      const jsonText = out
        .slice(start + '---NANOCLAW_OUTPUT_START---'.length, end)
        .trim();
      const parsed = JSON.parse(jsonText) as {
        status: 'success' | 'error';
        result: string | null;
        error?: string;
      };

      expect(['success', 'error']).toContain(parsed.status);
      expect(parsed.result === null || typeof parsed.result === 'string').toBe(
        true,
      );

      // In environments without API keys, Pi emits a model-selection error.
      // That's acceptable for smoke test purposes as long as protocol is correct.
      if (parsed.status === 'error' && parsed.error) {
        expect(parsed.error.length).toBeGreaterThan(0);
      }
    },
    120000,
  );
});
