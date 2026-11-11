// Decode structured Free-Pi errors without treating a rate limit as a balance.
export function upstreamCode(raw) {
  try { const body = JSON.parse(String(raw)); return body?.error?.code || body?.code || null; }
  catch { return null; }
}
const TEMPORARY_LIMIT_CODES = new Set(['hourly_ceiling', 'rolling_cap', 'queue_wait']);
export function isHourlyCeiling(raw) { return TEMPORARY_LIMIT_CODES.has(upstreamCode(raw)); }

// Prefer a server reset timestamp or retry delay; otherwise a one-hour
// conservative fallback is an estimate, never a known provider reset.
export function hourlyReset(raw, headers = {}, now = Date.now()) {
  let body={}; try { body=JSON.parse(String(raw)); } catch {}
  const data=body?.error && typeof body.error==='object' ? {...body,...body.error} : body;
  const until=typeof data.clears_at==='string' ? Date.parse(data.clears_at) : NaN;
  if(Number.isFinite(until) && until>now) return {until,source:'clears_at'};
  const seconds=Number(data.retry_after_seconds);
  if(Number.isFinite(seconds) && seconds>0) return {until:now+seconds*1000,source:'retry_after_seconds'};
  const header=headers['retry-after'];
  const n=Number(header);
  if(header!==undefined && Number.isFinite(n) && n>=0) return {until:now+n*1000,source:'retry-after'};
  const date=typeof header==='string'?Date.parse(header):NaN;
  if(Number.isFinite(date)&&date>now)return {until:date,source:'retry-after'};
  return {until:now+3600000,source:'estimated'};
}
