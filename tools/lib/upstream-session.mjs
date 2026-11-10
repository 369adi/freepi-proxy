import {createHash} from 'node:crypto';
// One stable provider session per account, not a new session per proxy process.
export function upstreamSessionId(account,installation) {
  if(!account?.id)throw Error('An account is required for the upstream session');
  const digest=createHash('sha256').update(String(installation).replaceAll('\\','/').toLowerCase()+':'+String(account.userId||account.id)).digest();
  digest[6]=(digest[6]&15)|0x50;digest[8]=(digest[8]&63)|0x80;
  const hex=digest.subarray(0,16).toString('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
