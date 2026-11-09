// Report the vision flags the proxy advertises right now.
const res = await fetch('http://127.0.0.1:4000/v1/models', {
  headers: { authorization: 'Bearer freepi-proxy' },
});
const body = await res.json();
const vision = body.data.filter((m) => m.capabilities && m.capabilities.vision).map((m) => m.id);
const text = body.data.filter((m) => !(m.capabilities && m.capabilities.vision)).map((m) => m.id);
console.log('status ' + res.status + ', models ' + body.data.length);
console.log('\nvision (' + vision.length + '):\n  ' + vision.join('\n  '));
console.log('\ntext-only (' + text.length + '):\n  ' + text.join(', '));
