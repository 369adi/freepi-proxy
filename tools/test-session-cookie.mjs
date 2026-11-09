// Prove that restart-dsh.mjs mints a cookie the live GUI accepts.
// Imports the real module instead of re-parsing source, so this test can never
// drift away from the code it checks.
//   node tools/test-session-cookie.mjs <port>
import { sessionCookie } from './restart-dsh.mjs';

const port = Number(process.argv[2]);
if (!Number.isFinite(port)) {
  console.log('usage: node tools/test-session-cookie.mjs <port>');
  process.exit(2);
}

const cookie = await sessionCookie(port);
if (cookie === undefined) {
  console.log('FAIL sessionCookie returned undefined; credential store unreadable');
  process.exit(1);
}
console.log(`minted: ${cookie.split('=')[0]} (${cookie.length} chars)`);

// Positive: the minted cookie must be accepted.
const accepted = await fetch(`http://127.0.0.1:${port}/`, {
  headers: { cookie },
  redirect: 'manual',
  signal: AbortSignal.timeout(4000),
});
console.log(`GET / with cookie -> ${accepted.status}`);
if (accepted.status === 401) {
  console.log('FAIL the server rejected the minted cookie');
  process.exit(1);
}

// Negative: no cookie at all must still be refused.
const bare = await fetch(`http://127.0.0.1:${port}/`, {
  redirect: 'manual',
  signal: AbortSignal.timeout(4000),
});
console.log(`GET / without cookie -> ${bare.status}`);
if (bare.status !== 401) {
  console.log('FAIL the server answers without authentication; the probe proves nothing');
  process.exit(1);
}

console.log('PASS sessionCookie produces an accepted session and the guard still holds');
