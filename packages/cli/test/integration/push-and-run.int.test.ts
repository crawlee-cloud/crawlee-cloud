/**
 * `crc push` + `crc list` + `crc call` end-to-end.
 *
 * Walks the canonical operator flow:
 *   1. login        → isolated config dir, real token
 *   2. push --no-build → registers actor on the platform without invoking
 *                        Docker (Docker daemon not required for the test)
 *   3. list --actors --json → confirms the new actor is queryable
 *   4. call --no-wait  → starts a run on the platform; we then verify via
 *                        a direct API call that the run row exists with
 *                        the right actorId.
 *
 * Each test uses a unique actor name so reruns don't collide; the actor is
 * cleaned up in `afterEach` to keep the dev DB tidy.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import {
  API_REACHABLE,
  TEST_API_URL,
  adminToken,
  deleteActorByName,
  makeIsolatedHome,
  readActiveProfile,
  runCli,
  seedActorProject,
} from './setup.js';

describe.skipIf(!API_REACHABLE)('crc push / list / call (e2e)', () => {
  let token: string;

  beforeAll(async () => {
    token = await adminToken();
  });

  let dispose: () => Promise<void>;
  let createdActorName: string | null = null;
  afterEach(async () => {
    if (createdActorName) {
      await deleteActorByName(createdActorName, token).catch(() => undefined);
      createdActorName = null;
    }
    if (dispose) await dispose();
  });

  it('push (no-build) registers a fresh actor with version + image on the platform', async () => {
    const { home, dispose: d } = await makeIsolatedHome();
    dispose = d;

    // Login first; push reads the persisted token.
    const loginRes = await runCli(['login', '--token', token, '--url', TEST_API_URL], { home });
    expect(loginRes.code).toBe(0);
    expect((await readActiveProfile(home))?.token).toBe(token);

    // Seed a minimal actor project under the isolated HOME so push has
    // a real actor.json + Dockerfile to read.
    const projectDir = path.join(home, 'my-test-actor');
    const actorName = `cli-e2e-push-${Date.now()}`;
    createdActorName = actorName;
    await seedActorProject(projectDir, actorName);

    const pushRes = await runCli(['push', '--no-build'], { home, cwd: projectDir });
    expect(pushRes.code).toBe(0);
    // Ora writes spinner success/fail to stderr when stdout is piped
    // (no TTY). Check the union so the test isn't sensitive to which
    // stream a particular log line landed on.
    expect(pushRes.stdout + pushRes.stderr).toMatch(/registered|updated|pushed successfully/i);

    // Verify the actor is queryable via the API. We hit the API directly
    // rather than parsing CLI output to assert ground truth.
    const me = await fetch(`${TEST_API_URL}/v2/acts/${actorName}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.status).toBe(200);
    const body = (await me.json()) as { data: { id: string; name: string } };
    expect(body.data.name).toBe(actorName);

    // The push should have written an actor_builds row (the "deploy event"
    // we added in the actor-versions wiring). Verify via /builds endpoint.
    const buildsRes = await fetch(`${TEST_API_URL}/v2/acts/${body.data.id}/builds`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(buildsRes.status).toBe(200);
    const builds = (await buildsRes.json()) as {
      data: {
        items: Array<{
          status: string;
          imageName: string | null;
          versionNumber: string | null;
          buildTag: string | null;
        }>;
      };
    };
    expect(builds.data.items).toHaveLength(1);
    expect(builds.data.items[0].status).toBe('SUCCEEDED');
    // seedActorProject wrote version "0.1" — the build row should reflect that.
    expect(builds.data.items[0].versionNumber).toBe('0.1');
    // First push of a version → it claims the "latest" tag.
    expect(builds.data.items[0].buildTag).toBe('latest');
    // image_name is the local convention used by the runner.
    expect(builds.data.items[0].imageName).toContain(actorName);
  });

  it('list --actors --json includes the newly pushed actor', async () => {
    const { home, dispose: d } = await makeIsolatedHome();
    dispose = d;

    await runCli(['login', '--token', token, '--url', TEST_API_URL], { home });

    const projectDir = path.join(home, 'list-test');
    const actorName = `cli-e2e-list-${Date.now()}`;
    createdActorName = actorName;
    await seedActorProject(projectDir, actorName);
    await runCli(['push', '--no-build'], { home, cwd: projectDir });

    const listRes = await runCli(['list', '--actors', '--json', '--limit', '50'], { home });
    expect(listRes.code).toBe(0);

    // The CLI prints `JSON.stringify(items, null, 2)` — a top-level array.
    // Locate the array boundary, parse, assert membership.
    const start = listRes.stdout.indexOf('[');
    const end = listRes.stdout.lastIndexOf(']');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const actors = JSON.parse(listRes.stdout.slice(start, end + 1)) as Array<{ name: string }>;
    expect(actors.some((a) => a.name === actorName)).toBe(true);
  });

  it('push forwards actor.json defaultRunOptions.timeoutSecs and memoryMbytes to the actor row', async () => {
    // Regression for the v0.9.7 → v0.9.8 story: the API fix that propagated
    // actor.default_run_options to runs was ineffective for CLI-pushed
    // actors because the CLI never sent timeoutSecs/memoryMbytes from
    // actor.json. After this fix, both fields land on the actor row and
    // the GET /v2/acts/:name response reflects them.
    const { home, dispose: d } = await makeIsolatedHome();
    dispose = d;

    await runCli(['login', '--token', token, '--url', TEST_API_URL], { home });

    const projectDir = path.join(home, 'defaults-test');
    const actorName = `cli-e2e-defaults-${Date.now()}`;
    createdActorName = actorName;
    await seedActorProject(projectDir, actorName, {
      defaultRunOptions: {
        timeoutSecs: 7200,
        memoryMbytes: 2048,
        build: 'beta',
      },
    });
    const pushRes = await runCli(['push', '--no-build'], { home, cwd: projectDir });
    expect(pushRes.code).toBe(0);

    const me = await fetch(`${TEST_API_URL}/v2/acts/${actorName}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(me.ok).toBe(true);
    const body = (await me.json()) as {
      data: {
        defaultRunOptions: {
          image?: string;
          timeoutSecs?: number;
          memoryMbytes?: number;
          build?: string;
        };
      };
    };
    expect(body.data.defaultRunOptions.timeoutSecs).toBe(7200);
    expect(body.data.defaultRunOptions.memoryMbytes).toBe(2048);
    expect(body.data.defaultRunOptions.build).toBe('beta');
    // image is still always asserted by push regardless of actor.json
    expect(typeof body.data.defaultRunOptions.image).toBe('string');
  });

  it('push without timeoutSecs in actor.json preserves a dashboard-set value', async () => {
    // The fix uses the existing actor's default_run_options as a baseline
    // so dashboard-only edits survive a push that doesn't declare them.
    const { home, dispose: d } = await makeIsolatedHome();
    dispose = d;

    await runCli(['login', '--token', token, '--url', TEST_API_URL], { home });

    const projectDir = path.join(home, 'baseline-test');
    const actorName = `cli-e2e-baseline-${Date.now()}`;
    createdActorName = actorName;

    // First push: actor.json has NO timeoutSecs.
    await seedActorProject(projectDir, actorName);
    let pushRes = await runCli(['push', '--no-build'], { home, cwd: projectDir });
    expect(pushRes.code).toBe(0);

    // Simulate a dashboard edit: PUT timeoutSecs onto the actor row.
    const actorRes = await fetch(`${TEST_API_URL}/v2/acts/${actorName}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const actorBody = (await actorRes.json()) as {
      data: { id: string; defaultRunOptions: Record<string, unknown> | null };
    };
    const dashboardEdit = await fetch(`${TEST_API_URL}/v2/acts/${actorBody.data.id}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        defaultRunOptions: { ...(actorBody.data.defaultRunOptions ?? {}), timeoutSecs: 5400 },
      }),
    });
    expect(dashboardEdit.ok).toBe(true);

    // Second push: actor.json STILL doesn't have timeoutSecs.
    pushRes = await runCli(['push', '--no-build'], { home, cwd: projectDir });
    expect(pushRes.code).toBe(0);

    // The dashboard-set 5400 must survive the second push.
    const meAfter = await fetch(`${TEST_API_URL}/v2/acts/${actorName}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const after = (await meAfter.json()) as {
      data: { defaultRunOptions: { timeoutSecs?: number } };
    };
    expect(after.data.defaultRunOptions.timeoutSecs).toBe(5400);
  });

  it('push without login fails cleanly with a helpful message', async () => {
    const { home, dispose: d } = await makeIsolatedHome();
    dispose = d;

    const projectDir = path.join(home, 'unauth');
    const actorName = `cli-e2e-unauth-${Date.now()}`;
    await seedActorProject(projectDir, actorName);

    const pushRes = await runCli(['push', '--no-build'], { home, cwd: projectDir });
    expect(pushRes.code).not.toBe(0);
    // The empty-token guard should kick in and print a hint pointing at
    // `crc login`. We don't pin the exact wording — just that there's
    // some user-actionable signal mentioning login.
    expect(pushRes.stdout + pushRes.stderr).toMatch(/login|token|authenticat/i);
  });
});
