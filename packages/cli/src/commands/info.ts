/**
 * `crawlee-cloud info` command.
 *
 * The "where am I?" command. Prints the active profile, the API URL, the
 * authenticated user, and a quick reachability check on the server.
 *
 * Output is intentionally short — operators run this when context-switching
 * between environments and want a one-line "did that `profile use` actually
 * change what I think it changed?" answer. We avoid pulling in heavy data
 * (recent runs, build counts, etc.) so this command stays sub-100ms.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { getConfig, getActiveProfileName } from '../utils/config.js';

interface HealthResponse {
  status: string;
  version?: string;
}

interface MeResponse {
  data: {
    id?: string;
    email: string;
    role?: string;
  };
}

export const infoCommand = new Command('info')
  .description('Show the active profile, API URL, user, and server status')
  .option('-j, --json', 'Output as JSON (for piping into scripts)')
  .action(async (options: { json?: boolean }) => {
    const profile = await getActiveProfileName();
    const config = await getConfig();

    // Two parallel HEAD-ish calls so a slow server doesn't make us wait
    // for both serially. /health is unauthenticated; /v2/auth/me is
    // authenticated and tells us who the token belongs to.
    const start = Date.now();
    const [healthRes, meRes] = await Promise.allSettled([
      fetch(`${config.apiBaseUrl}/health`),
      config.token
        ? fetch(`${config.apiBaseUrl}/v2/auth/me`, {
            headers: { Authorization: `Bearer ${config.token}` },
          })
        : Promise.reject(new Error('no token')),
    ]);
    const latencyMs = Date.now() - start;

    let serverVersion: string | undefined;
    let serverReachable = false;
    if (healthRes.status === 'fulfilled' && healthRes.value.ok) {
      serverReachable = true;
      const health = (await healthRes.value.json()) as HealthResponse;
      serverVersion = health.version;
    }

    let user: { email: string; role?: string } | null = null;
    let authValid = false;
    if (meRes.status === 'fulfilled' && meRes.value.ok) {
      authValid = true;
      const body = (await meRes.value.json()) as MeResponse;
      user = { email: body.data.email, role: body.data.role };
    }

    const tokenPreview = config.token ? `${config.token.slice(0, 12)}...` : '(not set)';

    if (options.json) {
      // Stable, scriptable shape. We omit the full token — the preview is
      // enough for "is this the right token?" checks without leaking it
      // into shell history / log files.
      console.log(
        JSON.stringify(
          {
            profile,
            apiBaseUrl: config.apiBaseUrl,
            tokenPreview,
            serverReachable,
            serverVersion,
            authValid,
            user,
            latencyMs,
          },
          null,
          2
        )
      );
      // Both output formats share the same exit-code contract — an
      // unreachable server or invalid token must exit non-zero so
      // `crc info --json >/dev/null && crc push` works as a CI gate.
      // Doing the check here (instead of `return`-ing early) keeps
      // human + JSON in lockstep.
      if (!serverReachable || !authValid) process.exit(1);
      return;
    }

    // Human-readable output. The label column is right-padded to a fixed
    // width so values line up — operators scan this fast, alignment helps.
    const PAD = 11;
    const row = (k: string, v: string) => `  ${chalk.dim(k.padEnd(PAD))} ${v}`;

    console.log();
    console.log(row('Profile:', chalk.green(profile) + chalk.dim(' (active)')));
    console.log(row('API:', config.apiBaseUrl));
    console.log(
      row(
        'Server:',
        serverReachable
          ? chalk.green(`v${serverVersion ?? 'unknown'}`) + chalk.dim(`  reachable, ${latencyMs}ms`)
          : chalk.red('unreachable')
      )
    );
    console.log(
      row(
        'Auth:',
        authValid
          ? chalk.green('valid')
          : config.token
            ? chalk.red('invalid token')
            : chalk.yellow('no token (run `crc login`)')
      )
    );
    if (user) {
      console.log(row('User:', user.email + (user.role ? chalk.dim(`  (${user.role})`) : '')));
    }
    console.log(row('Token:', chalk.dim(tokenPreview)));
    console.log();

    // Exit non-zero if anything is wrong — useful in CI healthchecks
    // (`crc info >/dev/null && do-other-stuff`).
    if (!serverReachable || !authValid) {
      process.exit(1);
    }
  });
