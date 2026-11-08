// Transport cleanup independent of provider, credentials, or scheduling policy.
export function bindRequestLifecycle(upstream, downstream, release, timeoutMs = 120_000) {
  let released = false;
  const finish = () => {
    if (released) return;
    released = true;
    clearTimeout(headerTimer);
    downstream.removeListener('close', cancel);
    release();
  };
  const cancel = () => {
    if (!downstream.writableEnded) upstream.destroy();
    finish();
  };
  const headerTimer = setTimeout(() => {
    upstream.destroy(new Error('Upstream did not send response headers within ' + timeoutMs + ' ms'));
    finish();
  }, timeoutMs);
  headerTimer.unref?.();
  downstream.once('close', cancel);
  upstream.once('error', finish);
  upstream.once('close', finish);
  upstream.once('response', response => {
    clearTimeout(headerTimer);
    response.once('end', finish);
    response.once('aborted', () => { finish(); downstream.destroy(); });
    response.once('error', error => { finish(); downstream.destroy(error); });
  });
  upstream.setTimeout(timeoutMs, () => {
    upstream.destroy(new Error('Upstream stream was inactive for ' + timeoutMs + ' ms'));
    finish();
  });
  if (downstream.destroyed) cancel();
  return finish;
}
