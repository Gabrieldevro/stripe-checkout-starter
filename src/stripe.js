// Client Stripe minimal (REST + fetch) și verificarea semnăturii webhook-urilor, fără SDK.
import crypto from 'node:crypto';

/** Stripe primește parametri form-encoded cu chei imbricate: line_items[0][price_data][currency]=ron */
export function toForm(obj, prefix = '', out = new URLSearchParams()) {
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (typeof value === 'object') toForm(value, name, out);
    else out.append(name, String(value));
  }
  return out;
}

export function createStripe(secretKey, { fetchImpl = fetch, apiBase = 'https://api.stripe.com/v1' } = {}) {
  async function request(method, path, params) {
    const res = await fetchImpl(apiBase + path, {
      method,
      headers: {
        authorization: `Bearer ${secretKey}`,
        'content-type': 'application/x-www-form-urlencoded',
        // Aceeași cerere repetată (ex. dublu-click) nu creează două sesiuni.
        ...(method === 'POST' ? { 'idempotency-key': crypto.randomUUID() } : {}),
      },
      body: params ? toForm(params).toString() : undefined,
    });
    const data = await res.json();
    if (!res.ok) throw Object.assign(new Error(data?.error?.message || `Stripe HTTP ${res.status}`), { status: res.status, data });
    return data;
  }
  return {
    createCheckoutSession: params => request('POST', '/checkout/sessions', params),
    retrieveCheckoutSession: id => request('GET', `/checkout/sessions/${encodeURIComponent(id)}`),
  };
}

/**
 * Verifică header-ul Stripe-Signature: t=timestamp,v1=hmac_sha256(secret, `${t}.${payload}`).
 * Respinge semnăturile false și pe cele mai vechi decât `tolerance` secunde (replay attack).
 */
export function verifyWebhook(payload, header, secret, { tolerance = 300, now = Math.floor(Date.now() / 1000) } = {}) {
  if (!header) throw new Error('Lipsește header-ul Stripe-Signature');
  const parts = Object.groupBy
    ? Object.groupBy(header.split(',').map(p => p.split('=')), ([k]) => k)
    : header.split(',').map(p => p.split('=')).reduce((acc, kv) => ((acc[kv[0]] ||= []).push(kv), acc), {});
  const timestamp = Number(parts.t?.[0]?.[1]);
  const signatures = (parts.v1 || []).map(([, v]) => v);
  if (!timestamp || signatures.length === 0) throw new Error('Header Stripe-Signature invalid');
  if (Math.abs(now - timestamp) > tolerance) throw new Error('Semnătură expirată');

  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${payload}`, 'utf8').digest('hex');
  const ok = signatures.some(sig => sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)));
  if (!ok) throw new Error('Semnătură invalidă');
  return JSON.parse(payload);
}

/** Utilitar pentru teste și dezvoltare locală: generează un header valid. */
export function signPayload(payload, secret, timestamp = Math.floor(Date.now() / 1000)) {
  const sig = crypto.createHmac('sha256', secret).update(`${timestamp}.${payload}`, 'utf8').digest('hex');
  return `t=${timestamp},v1=${sig}`;
}
