// github-core-clone-01 entry: the lifecycle between this forge and the suite.
// The suite (env) runs beside this process: it waits for a register, drives the forge
// through its four surfaces, then says done. This file owns only that lifecycle;
// app.ts owns the forge itself.
//
//   1. MAKEFUN_ENV_URL names the env origin. Without it there is nothing to talk to.
//   2. Create the server and listen(0): the kernel picks a free port. Never bind 8080.
//   3. POST $MAKEFUN_ENV_URL/register {"port": N}. The env records the address the
//      request came from plus N as this forge's base URL. 200 is the normal answer;
//      409 means another entry already registered, which is not ours to fix.
//   4. GET $MAKEFUN_ENV_URL/done until the body is {"done": true}; the env answers
//      at once ({"done": false} while the suite runs), so this is a poll.
//   5. Close the server and exit 0.

import { createApp } from './app.ts';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (ENV_URL === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

const REQUEST_TIMEOUT_MS = 30000;
const RETRY_INITIAL_MS = 250;
const RETRY_MAX_MS = 2000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function retryDelay(attempt) {
  return Math.min(RETRY_MAX_MS, RETRY_INITIAL_MS * 2 ** Math.min(attempt, 8));
}

async function register(port) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        throw new Error(`register answered HTTP ${res.status}: ${await res.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
    }
    await sleep(retryDelay(attempt));
  }
}

async function waitForDone() {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.ok) {
        const body = await res.json();
        if (body.done === true) return;
      }
    } catch {
      // The env is not answering yet: it is not done, so poll again.
    }
    await sleep(retryDelay(attempt));
  }
}

async function main() {
  const server = createApp();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[entry] listening on port ${address.port}\n`);
  await register(address.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');
  await waitForDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await main();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
