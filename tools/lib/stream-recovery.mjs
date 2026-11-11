import { StringDecoder } from 'node:string_decoder';

const DEFAULT_MAX_CONTINUATIONS = 2;
const MAX_REASONING_CONTEXT_CHARS = 12_000;
const MAX_JSON_BUFFER_BYTES = 16 * 1024 * 1024;

/** Extract reasoning text emitted by OpenAI/OpenRouter/DeepSeek chunks or messages. */
export function extractReasoningText(part) {
  if (!part || typeof part !== 'object') return '';
  for (const field of ['reasoning_content', 'reasoning', 'reasoning_text']) {
    const val = part[field];
    if (typeof val === 'string' && val.length > 0) return val;
  }
  if (Array.isArray(part.reasoning_details)) {
    let joined = '';
    for (const item of part.reasoning_details) {
      if (typeof item === 'string') joined += item;
      else if (item && typeof item.text === 'string') joined += item.text;
      else if (item && typeof item.summary === 'string') joined += item.summary;
    }
    if (joined.length > 0) return joined;
  }
  return '';
}

/** Check whether a chat-completion choice delta/message has substantive text or tool output. */
function hasMeaningfulDelta(part) {
  if (!part || typeof part !== 'object') return false;
  if (typeof part.role === 'string' && part.role.length > 0) return true;
  if (typeof part.content === 'string' && part.content.length > 0) return true;
  if (extractReasoningText(part).length > 0) return true;
  if (Array.isArray(part.tool_calls) && part.tool_calls.length > 0) return true;
  return false;
}

/** Clone a parsed SSE chunk while clearing terminal finish_reason="stop". */
function stripStopFinishReason(chunkObj) {
  if (!chunkObj || typeof chunkObj !== 'object' || !Array.isArray(chunkObj.choices)) return null;
  let keptDelta = false;
  const choices = chunkObj.choices.map((ch) => {
    if (!ch || typeof ch !== 'object') return ch;
    const part = ch.delta || ch.message;
    if (hasMeaningfulDelta(part)) keptDelta = true;
    if (ch.finish_reason === 'stop') return { ...ch, finish_reason: null };
    return ch;
  });
  if (!keptDelta && !chunkObj.usage) return null;
  return { ...chunkObj, choices };
}

/** Build a continuation chat-completions request body preserving tools, model, and prior reasoning tail. */
export function buildContinuationBody(origBody, reasoningSoFar = '', _attempt = 1) {
  let parsed;
  try {
    parsed = typeof origBody === 'string' || Buffer.isBuffer(origBody)
      ? JSON.parse(origBody.toString('utf8'))
      : origBody && typeof origBody === 'object'
        ? { ...origBody }
        : null;
  } catch {
    return null;
  }
  if (!parsed || !Array.isArray(parsed.messages)) return null;

  const trimmed = String(reasoningSoFar || '').trim();
  const tail = trimmed.length > MAX_REASONING_CONTEXT_CHARS
    ? '[Earlier thinking truncated]\n' + trimmed.slice(-MAX_REASONING_CONTEXT_CHARS)
    : trimmed;

  const nextMessages = [...parsed.messages];
  if (tail) {
    nextMessages.push({
      role: 'assistant',
      content: '[Thinking progress before unexpected stop]\n' + tail,
    });
  }
  nextMessages.push({
    role: 'user',
    content: tail
      ? 'Your previous thinking stopped prematurely before emitting a tool call or final answer. Continue directly from your thinking above and immediately produce your tool call(s) or final answer without repeating earlier reasoning.'
      : 'Your previous response ended empty without output or tool calls. Continue immediately and provide the needed tool call(s) or answer.',
  });

  return Buffer.from(JSON.stringify({ ...parsed, messages: nextMessages }));
}

function drainSseEvents(state, chunkText, onEvent) {
  state.buffer += chunkText;
  const separator = /\r?\n\r?\n/;
  for (;;) {
    const match = separator.exec(state.buffer);
    if (!match) break;
    const rawEvent = state.buffer.slice(0, match.index);
    state.buffer = state.buffer.slice(match.index + match[0].length);
    if (rawEvent.length > 0) onEvent(rawEvent);
  }
}

function parseSseDataPayload(rawEvent) {
  const lines = rawEvent.split(/\r?\n/);
  const dataLines = [];
  for (const line of lines) {
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  return dataLines.length > 0 ? dataLines.join('\n') : null;
}

function writeOut(res, textOrBuf) {
  if (!res.destroyed && !res.writableEnded) {
    res.write(textOrBuf);
  }
}

function emitSynthesizedFinish({ inRes, heldStopChunk, lastChunkId, lastModel, finishReason }) {
  const chunk = heldStopChunk && Array.isArray(heldStopChunk.choices)
    ? {
        ...heldStopChunk,
        choices: heldStopChunk.choices.map((ch, idx) =>
          idx === 0 ? { ...ch, delta: {}, finish_reason: finishReason } : ch,
        ),
      }
    : {
        id: lastChunkId || 'freepi-recovery',
        object: 'chat.completion.chunk',
        model: lastModel || '',
        choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
      };
  writeOut(inRes, `data: ${JSON.stringify(chunk)}\n\n`);
}

async function consumeSseAttempt(upRes, state) {
  return new Promise((resolve) => {
    const decoder = new StringDecoder('utf8');
    const sse = { buffer: '' };
    let settled = false;
    let streamError = null;
    let sawAttemptData = false;
    let attemptStopOrDone = false;

    const handleEvent = (rawEvent) => {
      const payload = parseSseDataPayload(rawEvent);
      if (payload === null) {
        writeOut(state.inRes, rawEvent + '\n\n');
        return;
      }
      if (payload === '[DONE]') {
        attemptStopOrDone = true;
        return;
      }
      let obj;
      try {
        obj = JSON.parse(payload);
      } catch {
        writeOut(state.inRes, rawEvent + '\n\n');
        return;
      }
      sawAttemptData = true;
      if (obj?.id) state.lastChunkId = obj.id;
      if (obj?.model) state.lastModel = obj.model;

      const choice = Array.isArray(obj?.choices) ? obj.choices[0] : null;
      const part = choice?.delta || choice?.message;
      const reasoningPiece = extractReasoningText(part);
      if (reasoningPiece) {
        state.sawReasoning = true;
        state.reasoningBuf += reasoningPiece;
      }
      if (typeof choice?.text === 'string' && choice.text.length > 0) {
        state.contentBuf += choice.text;
        if (state.contentBuf.trim().length > 0) state.sawContent = true;
      }
      if (typeof part?.content === 'string' && part.content.length > 0) {
        state.contentBuf += part.content;
        if (state.contentBuf.trim().length > 0) state.sawContent = true;
      }
      if (Array.isArray(part?.tool_calls) && part.tool_calls.length > 0) {
        state.sawToolCalls = true;
      }

      const finishReason = choice?.finish_reason;
      if (finishReason) {
        const prematureStop = finishReason === 'stop' && !state.sawContent && !state.sawToolCalls;
        if (prematureStop) {
          attemptStopOrDone = true;
          state.heldStopChunk = obj;
          const partial = stripStopFinishReason(obj);
          if (partial) writeOut(state.inRes, `data: ${JSON.stringify(partial)}\n\n`);
          return;
        }
        state.finalFinishEmitted = true;
        attemptStopOrDone = true;
        writeOut(state.inRes, rawEvent + '\n\n');
        return;
      }

      writeOut(state.inRes, rawEvent + '\n\n');
    };

    const done = () => {
      if (settled) return;
      settled = true;
      const tail = decoder.end();
      drainSseEvents(sse, tail, handleEvent);
      if (!streamError && sse.buffer.trim()) handleEvent(sse.buffer.trim());
      resolve({ streamError, sawAttemptData, attemptStopOrDone });
    };

    upRes.on('data', (chunk) => {
      if (state.clientClosed || state.inRes.destroyed) return;
      const str = typeof chunk === 'string' ? chunk : decoder.write(chunk);
      drainSseEvents(sse, str, handleEvent);
    });
    upRes.on('end', done);
    upRes.on('aborted', () => {
      streamError = new Error('upstream stream aborted');
      done();
    });
    upRes.on('error', (err) => {
      streamError = err;
      done();
    });
  });
}

async function handleJsonRecovery({ firstRes, firstReq, inRes, headersOut, origBody, requestAttempt, releaseOnce, maxContinuations }) {
  let activeReq = firstReq;
  let activeRes = firstRes;
  let clientClosed = false;
  let combinedReasoning = '';
  let attempt = 0;
  let finalBuf = null;
  let lastParsed = null;

  const onClose = () => {
    clientClosed = true;
    try { activeReq?.destroy(); } catch {}
    releaseOnce();
  };
  inRes.once('close', onClose);

  try {
    for (;;) {
      const chunks = [];
      let total = 0;
      const buf = await new Promise((resolve, reject) => {
        activeRes.on('data', (c) => {
          total += c.length;
          if (total <= MAX_JSON_BUFFER_BYTES) chunks.push(c);
        });
        activeRes.on('end', () => resolve(Buffer.concat(chunks)));
        activeRes.on('error', reject);
        activeRes.on('aborted', () => reject(new Error('upstream aborted')));
      });
      finalBuf = buf;

      if (clientClosed) break;
      let parsed = null;
      if (total <= MAX_JSON_BUFFER_BYTES) {
        try { parsed = JSON.parse(buf.toString('utf8')); } catch {}
      }
      if (!parsed || !Array.isArray(parsed.choices) || !parsed.choices[0]) break;
      lastParsed = parsed;

      const choice = parsed.choices[0];
      const msg = choice.message || {};
      const reasoning = extractReasoningText(msg);
      if (reasoning) combinedReasoning += (combinedReasoning ? '\n' : '') + reasoning;

      const hasText = typeof msg.content === 'string' && msg.content.trim().length > 0;
      const hasTools = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;
      const prematureStop = choice.finish_reason === 'stop' && !hasText && !hasTools;

      if (!prematureStop) break;
      if (attempt >= maxContinuations) {
        if (combinedReasoning.trim()) {
          parsed.choices[0] = {
            ...choice,
            message: { ...msg, ...(msg.reasoning_content ? {} : { reasoning_content: combinedReasoning }) },
            finish_reason: 'length',
          };
          finalBuf = Buffer.from(JSON.stringify(parsed));
        }
        break;
      }

      const nextBody = buildContinuationBody(origBody, combinedReasoning, attempt + 1);
      if (!nextBody) break;

      attempt += 1;
      let nextAttempt;
      try {
        nextAttempt = await requestAttempt(nextBody, attempt);
      } catch {
        nextAttempt = null;
      }
      if (!nextAttempt || !nextAttempt.upRes || nextAttempt.upRes.statusCode !== 200 || clientClosed) {
        if (lastParsed && combinedReasoning.trim()) {
          lastParsed.choices[0] = { ...lastParsed.choices[0], finish_reason: 'length' };
          finalBuf = Buffer.from(JSON.stringify(lastParsed));
        }
        break;
      }
      activeReq = nextAttempt.upReq;
      activeRes = nextAttempt.upRes;
    }

    if (!clientClosed && !inRes.headersSent && finalBuf !== null) {
      inRes.writeHead(200, headersOut);
      inRes.end(finalBuf);
    } else if (!clientClosed && !inRes.writableEnded) {
      inRes.end();
    }
  } catch (err) {
    if (!clientClosed && !inRes.headersSent) {
      inRes.writeHead(502, { 'content-type': 'application/json' });
      inRes.end(JSON.stringify({ error: { message: 'upstream: ' + err.message, type: 'proxy_error' } }));
    } else if (!clientClosed && !inRes.destroyed) {
      inRes.destroy(err);
    }
  } finally {
    inRes.off('close', onClose);
    releaseOnce();
  }
}

/**
 * Relay a 200 chat-completions response while automatically recovering premature
 * mid-thought `finish_reason: "stop"` (or unexpected end with reasoning-only output).
 */
export async function relayWithStopRecovery({
  upReq,
  upRes,
  inRes,
  headersOut,
  origBody,
  requestAttempt,
  releaseOnce,
  maxContinuations = DEFAULT_MAX_CONTINUATIONS,
  onRecoveryAttempt = null,
}) {
  if (inRes.destroyed) {
    try { upReq?.destroy(); } catch {}
    releaseOnce();
    return;
  }
  const contentType = String(upRes.headers['content-type'] || '').toLowerCase();
  const isEventStream = contentType.includes('text/event-stream');
  const isJson = contentType.includes('application/json');

  if (!isEventStream && !isJson) {
    inRes.writeHead(upRes.statusCode, headersOut);
    upRes.pipe(inRes);
    upRes.on('end', releaseOnce);
    upRes.on('error', releaseOnce);
    upRes.on('aborted', releaseOnce);
    return;
  }

  if (isJson && typeof requestAttempt === 'function') {
    await handleJsonRecovery({
      firstRes: upRes,
      firstReq: upReq,
      inRes,
      headersOut,
      origBody,
      requestAttempt,
      releaseOnce,
      maxContinuations,
    });
    return;
  }

  if (!isEventStream) {
    inRes.writeHead(upRes.statusCode, headersOut);
    upRes.pipe(inRes);
    upRes.on('end', releaseOnce);
    upRes.on('error', releaseOnce);
    upRes.on('aborted', releaseOnce);
    return;
  }

  inRes.writeHead(upRes.statusCode, headersOut);

  const state = {
    inRes,
    clientClosed: false,
    sawReasoning: false,
    sawContent: false,
    sawToolCalls: false,
    reasoningBuf: '',
    contentBuf: '',
    heldStopChunk: null,
    finalFinishEmitted: false,
    lastChunkId: null,
    lastModel: null,
  };

  let activeReq = upReq;
  const onClientClose = () => {
    state.clientClosed = true;
    try { activeReq?.destroy(); } catch {}
    releaseOnce();
  };
  inRes.once('close', onClientClose);

  try {
    let activeRes = upRes;
    for (let attempt = 0; attempt <= maxContinuations; attempt += 1) {
      await consumeSseAttempt(activeRes, state);
      if (state.clientClosed || state.inRes.destroyed || state.finalFinishEmitted) break;
      if (state.sawContent || state.sawToolCalls) break;

      const premature = state.sawReasoning || Boolean(state.heldStopChunk);
      if (!premature || attempt >= maxContinuations || typeof requestAttempt !== 'function') break;

      const nextBody = buildContinuationBody(origBody, state.reasoningBuf, attempt + 1);
      if (!nextBody) break;

      if (typeof onRecoveryAttempt === 'function') {
        onRecoveryAttempt({ attempt: attempt + 1, reasoningChars: state.reasoningBuf.length });
      }

      let nextAttempt;
      try {
        nextAttempt = await requestAttempt(nextBody, attempt + 1);
      } catch {
        nextAttempt = null;
      }
      if (!nextAttempt || !nextAttempt.upRes || nextAttempt.upRes.statusCode !== 200) {
        try { nextAttempt?.upRes?.resume(); } catch {}
        break;
      }
      const nextCt = String(nextAttempt.upRes.headers['content-type'] || '').toLowerCase();
      if (!nextCt.includes('text/event-stream')) {
        try { nextAttempt.upRes.resume(); } catch {}
        break;
      }

      state.heldStopChunk = null;
      activeReq = nextAttempt.upReq;
      activeRes = nextAttempt.upRes;
    }

    if (!state.clientClosed && !inRes.destroyed && !inRes.writableEnded) {
      if (!state.finalFinishEmitted) {
        const reason = state.sawReasoning && !state.sawContent && !state.sawToolCalls ? 'length' : 'stop';
        emitSynthesizedFinish({
          inRes,
          heldStopChunk: state.heldStopChunk,
          lastChunkId: state.lastChunkId,
          lastModel: state.lastModel,
          finishReason: reason,
        });
      }
      writeOut(inRes, 'data: [DONE]\n\n');
      inRes.end();
    }
  } finally {
    inRes.off('close', onClientClose);
    releaseOnce();
  }
}
