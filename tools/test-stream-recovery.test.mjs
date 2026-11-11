import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { relayWithStopRecovery, buildContinuationBody, extractReasoningText } from './lib/stream-recovery.mjs';

function makeMockRes() {
  const res = new PassThrough();
  const written = [];
  res.headersSent = false;
  res.statusCode = null;
  res.headers = null;
  res.writeHead = (status, headers) => {
    res.statusCode = status;
    res.headers = headers;
    res.headersSent = true;
  };
  const origWrite = res.write.bind(res);
  res.write = (chunk) => {
    written.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
    return origWrite(chunk);
  };
  const origEnd = res.end.bind(res);
  res.end = (chunk) => {
    if (chunk !== undefined) written.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
    return origEnd(chunk);
  };
  return { res, text: () => written.join('') };
}

function sseResponse(events, delayMs = 2) {
  const upRes = new EventEmitter();
  upRes.headers = { 'content-type': 'text/event-stream' };
  upRes.statusCode = 200;
  upRes.resume = () => {};
  const upReq = new EventEmitter();
  upReq.destroy = () => {};
  setTimeout(() => {
    for (const chunk of events) {
      upRes.emit('data', Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    upRes.emit('end');
  }, delayMs);
  return { upReq, upRes };
}

function parseSseChunks(raw) {
  return raw
    .split(/\r?\n\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((block) => block.replace(/^data:\s*/, ''));
}

test('extractReasoningText reads reasoning_content, reasoning, reasoning_text, and reasoning_details', () => {
  assert.equal(extractReasoningText({ reasoning_content: 'a' }), 'a');
  assert.equal(extractReasoningText({ reasoning: 'b' }), 'b');
  assert.equal(extractReasoningText({ reasoning_text: 'c' }), 'c');
  assert.equal(extractReasoningText({ reasoning_details: [{ type: 'text', text: 'd' }, { summary: 'e' }] }), 'de');
});

test('buildContinuationBody preserves tools and appends thinking context + prompt', () => {
  const orig = Buffer.from(JSON.stringify({
    model: 'deepseek-v4.1-flash',
    stream: true,
    tools: [{ type: 'function', function: { name: 'bash' } }],
    messages: [{ role: 'user', content: 'solve it' }],
  }));
  const next = JSON.parse(buildContinuationBody(orig, 'step 1 done', 1).toString('utf8'));
  assert.equal(next.model, 'deepseek-v4.1-flash');
  assert.equal(next.tools.length, 1);
  assert.equal(next.messages.length, 3);
  assert.equal(next.messages[1].role, 'assistant');
  assert.match(next.messages[1].content, /step 1 done/);
  assert.equal(next.messages[2].role, 'user');
});

test('normal text completion with finish_reason="stop" relays with zero continuation calls', async () => {
  const { upReq, upRes } = sseResponse([
    'data: {"id":"1","choices":[{"index":0,"delta":{"content":"Hallo Welt"}}]}\n\n',
    'data: {"id":"1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n',
  ]);
  const { res, text } = makeMockRes();
  let contCalls = 0;
  let releases = 0;
  await relayWithStopRecovery({
    upReq,
    upRes,
    inRes: res,
    headersOut: { 'content-type': 'text/event-stream' },
    origBody: Buffer.from(JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] })),
    requestAttempt: async () => { contCalls++; return sseResponse([]); },
    releaseOnce: () => { releases++; },
  });
  assert.equal(contCalls, 0);
  assert.equal(releases, 1);
  const events = parseSseChunks(text());
  assert.equal(events.at(-1), '[DONE]');
  assert.equal(JSON.parse(events[1]).choices[0].finish_reason, 'stop');
});

test('premature mid-thought stop automatically issues continuation and streams final tool/text answer', async () => {
  const emoji = Buffer.from('Prüfung 🚀 ', 'utf8');
  const firstHalf = emoji.subarray(0, 4);
  const secondHalf = emoji.subarray(4);
  const c1 = Buffer.concat([Buffer.from('data: {"id":"1","model":"m","choices":[{"index":0,"delta":{"reasoning_content":"'), firstHalf]);
  const c2 = Buffer.concat([secondHalf, Buffer.from('Denke nach..."}}]}\n\n')]);
  const { upReq, upRes } = sseResponse([
    c1,
    c2,
    'data: {"id":"1","model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n',
  ]);
  const { res, text } = makeMockRes();
  const attemptBodies = [];
  let releases = 0;

  await relayWithStopRecovery({
    upReq,
    upRes,
    inRes: res,
    headersOut: { 'content-type': 'text/event-stream' },
    origBody: Buffer.from(JSON.stringify({ model: 'm', stream: true, messages: [{ role: 'user', content: 'go' }] })),
    requestAttempt: async (nextBody) => {
      attemptBodies.push(JSON.parse(nextBody.toString('utf8')));
      return sseResponse([
        'data: {"id":"2","model":"m","choices":[{"index":0,"delta":{"content":"Fertige Antwort!"}}]}\n\n',
        'data: {"id":"2","model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n',
      ]);
    },
    releaseOnce: () => { releases++; },
  });

  assert.equal(attemptBodies.length, 1);
  assert.equal(releases, 1);
  assert.match(attemptBodies[0].messages[1].content, /Prüfung 🚀 Denke nach/);

  const events = parseSseChunks(text());
  assert.equal(events.filter((e) => e === '[DONE]').length, 1);
  assert.equal(events.at(-1), '[DONE]');
  const jsons = events.filter((e) => e !== '[DONE]').map((e) => JSON.parse(e));
  assert.equal(jsons[0].choices[0].delta.reasoning_content, 'Prüfung 🚀 Denke nach...');
  assert.equal(jsons[1].choices[0].delta.content, 'Fertige Antwort!');
  assert.equal(jsons[2].choices[0].finish_reason, 'stop');
});

test('exhausted mid-thought retries rewrite terminal stop to finish_reason="length" so client recovery triggers', async () => {
  const { upReq, upRes } = sseResponse([
    'data: {"id":"1","choices":[{"index":0,"delta":{"reasoning_content":"Part 1"}}]}\n\n',
    'data: {"id":"1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n',
  ]);
  const { res, text } = makeMockRes();
  let calls = 0;
  await relayWithStopRecovery({
    upReq,
    upRes,
    inRes: res,
    headersOut: { 'content-type': 'text/event-stream' },
    origBody: Buffer.from(JSON.stringify({ model: 'm', stream: true, messages: [{ role: 'user', content: 'go' }] })),
    maxContinuations: 2,
    requestAttempt: async () => {
      calls++;
      return sseResponse([
        `data: {"id":"${calls + 1}","choices":[{"index":0,"delta":{"reasoning_content":"Part ${calls + 1}"}}]}\n\n`,
        `data: {"id":"${calls + 1}","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n`,
        'data: [DONE]\n\n',
      ]);
    },
    releaseOnce: () => {},
  });
  assert.equal(calls, 2);
  const events = parseSseChunks(text());
  const finishChunk = JSON.parse(events.at(-2));
  assert.equal(finishChunk.choices[0].finish_reason, 'length');
  assert.equal(events.at(-1), '[DONE]');
});

test('continuation emitting tool_calls preserves tool_calls finish_reason cleanly', async () => {
  const { upReq, upRes } = sseResponse([
    'data: {"id":"1","choices":[{"index":0,"delta":{"reasoning_content":"need file read"}}]}\n\n',
    'data: {"id":"1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n',
  ]);
  const { res, text } = makeMockRes();
  await relayWithStopRecovery({
    upReq,
    upRes,
    inRes: res,
    headersOut: { 'content-type': 'text/event-stream' },
    origBody: Buffer.from(JSON.stringify({ model: 'm', stream: true, messages: [{ role: 'user', content: 'read' }] })),
    requestAttempt: async () => sseResponse([
      'data: {"id":"2","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"read","arguments":"{\\"path\\":\\"a\\"}"}}]}}]}\n\n',
      'data: {"id":"2","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      'data: [DONE]\n\n',
    ]),
    releaseOnce: () => {},
  });
  const events = parseSseChunks(text());
  const jsons = events.filter((e) => e !== '[DONE]').map((e) => JSON.parse(e));
  assert.equal(jsons[1].choices[0].delta.tool_calls[0].function.name, 'read');
  assert.equal(jsons[2].choices[0].finish_reason, 'tool_calls');
});

test('failed continuation upstream gracefully falls back to finish_reason="length" and releases once', async () => {
  const { upReq, upRes } = sseResponse([
    'data: {"id":"1","choices":[{"index":0,"delta":{"reasoning_content":"partial"}}]}\n\n',
    'data: {"id":"1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n',
  ]);
  const { res, text } = makeMockRes();
  let releases = 0;
  await relayWithStopRecovery({
    upReq,
    upRes,
    inRes: res,
    headersOut: { 'content-type': 'text/event-stream' },
    origBody: Buffer.from(JSON.stringify({ model: 'm', stream: true, messages: [{ role: 'user', content: 'go' }] })),
    requestAttempt: async () => {
      throw new Error('upstream 502');
    },
    releaseOnce: () => { releases++; },
  });
  assert.equal(releases, 1);
  const events = parseSseChunks(text());
  assert.equal(JSON.parse(events.at(-2)).choices[0].finish_reason, 'length');
  assert.equal(events.at(-1), '[DONE]');
});

test('aborted mid-frame SSE stream does not flush broken partial JSON tail', async () => {
  const upRes = new EventEmitter();
  upRes.headers = { 'content-type': 'text/event-stream' };
  upRes.statusCode = 200;
  const upReq = new EventEmitter();
  upReq.destroy = () => {};
  setTimeout(() => {
    upRes.emit('data', Buffer.from('data: {"id":"1","choices":[{"index":0,"delta":{"content":"ok"}}]}\n\n'));
    upRes.emit('data', Buffer.from('data: {"id":"1","choices":[{"delta":'));
    upRes.emit('aborted');
  }, 2);
  const { res, text } = makeMockRes();
  let releases = 0;
  await relayWithStopRecovery({
    upReq,
    upRes,
    inRes: res,
    headersOut: { 'content-type': 'text/event-stream' },
    origBody: Buffer.from(JSON.stringify({ model: 'm', stream: true, messages: [{ role: 'user', content: 'go' }] })),
    requestAttempt: async () => { throw new Error('unexpected retry'); },
    releaseOnce: () => { releases++; },
  });
  assert.equal(releases, 1);
  assert.doesNotMatch(text(), /\{"delta":\s*$/m);
  const events = parseSseChunks(text());
  assert.equal(JSON.parse(events[0]).choices[0].delta.content, 'ok');
});

test('non-streaming JSON premature mid-thought stop also auto-continues', async () => {
  let reqCount = 0;
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      reqCount++;
      res.writeHead(200, { 'content-type': 'application/json' });
      if (reqCount === 1) {
        res.end(JSON.stringify({
          id: 'j1',
          choices: [{ index: 0, message: { role: 'assistant', reasoning_content: 'thinking JSON', content: '' }, finish_reason: 'stop' }],
        }));
      } else {
        res.end(JSON.stringify({
          id: 'j2',
          choices: [{ index: 0, message: { role: 'assistant', content: 'JSON answer' }, finish_reason: 'stop' }],
        }));
      }
    });
  });

  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const addr = upstream.address();

  const proxyServer = http.createServer((inReq, inRes) => {
    const chunks = [];
    inReq.on('data', (c) => chunks.push(c));
    inReq.on('end', () => {
      const origBody = Buffer.concat(chunks);
      const sendReq = (bodyBuf) => new Promise((resolve, reject) => {
        const uReq = http.request({
          hostname: '127.0.0.1',
          port: addr.port,
          method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': bodyBuf.length },
        }, (uRes) => resolve({ upReq: uReq, upRes: uRes }));
        uReq.on('error', reject);
        uReq.write(bodyBuf);
        uReq.end();
      });
      sendReq(origBody).then(({ upReq, upRes }) =>
        relayWithStopRecovery({
          upReq,
          upRes,
          inRes,
          headersOut: { 'content-type': 'application/json' },
          origBody,
          requestAttempt: (nextBody) => sendReq(nextBody),
          releaseOnce: () => {},
        }),
      );
    });
  });

  await new Promise((r) => proxyServer.listen(0, '127.0.0.1', r));
  const pAddr = proxyServer.address();
  try {
    const r = await fetch(`http://127.0.0.1:${pAddr.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', stream: false, messages: [{ role: 'user', content: 'hi' }] }),
    });
    const json = await r.json();
    assert.equal(reqCount, 2);
    assert.equal(json.choices[0].message.content, 'JSON answer');
  } finally {
    upstream.close();
    proxyServer.close();
  }
});
