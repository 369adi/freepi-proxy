/**
 * Standalone runner for the freepi browser automation, mirroring exactly what
 * /freepi-add does inside DSH. Useful for debugging outside the harness.
 *
 *   node freepi-add.mjs            full flow, fully automatic
 *   node freepi-add.mjs --manual   print the code and wait for a human
 */
const mod = await import('file://C:/Users/liket/.dsh/plugins/freepi-accounts/lib/index.js');

const registered = new Map();
mod.apply({
  commands: {
    register(def) {
      registered.set(def.name, def);
      return () => registered.delete(def.name);
    },
  },
  effect(gen) {
    const it = gen();
    let step = it.next();
    while (!step.done) step = it.next();
  },
});

const add = registered.get('freepi-add');
const rawInput = process.argv.includes('--manual') ? '--manual' : '';

const started = Date.now();
try {
  const result = await add.handler({ rawInput, signal: new AbortController().signal });
  console.log('\n[' + result.kind + ']\n');
  console.log(result.text);
  console.log('\nfertig in ' + Math.round((Date.now() - started) / 1000) + 's');
  process.exit(result.kind === 'success' ? 0 : 1);
} catch (error) {
  console.error('\nFEHLER: ' + (error.message || error));
  if (error.code) console.error('code: ' + error.code);
  process.exit(1);
}
