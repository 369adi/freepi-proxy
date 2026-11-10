// Diagnose the fetch itself, without any wrapper that could swallow errors.
const port = Number(process.argv[2] ?? 60443);
console.log('port', port);
try {
  const response = await fetch(`http://127.0.0.1:${port}/`, {
    signal: AbortSignal.timeout(2500),
    redirect: 'manual',
  });
  console.log('status', response.status, 'type', response.headers.get('content-type'));
  const text = await response.text();
  console.log('text length', text.length);
  console.log('regex hits', /dsh web|deepseek harness|dsh-auth/iu.test(text));
  console.log('text', JSON.stringify(text.slice(0, 200)));
} catch (error) {
  console.log('THREW:', error.name, error.message);
  console.log('cause:', error.cause?.code ?? error.cause);
}
