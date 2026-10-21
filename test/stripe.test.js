import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toForm, verifyWebhook, signPayload, createStripe } from '../src/stripe.js';
import { createApp } from '../src/app.js';

const secret = 'whsec_test_secret';

test('toForm codifică obiectele imbricate ca Stripe', () => {
  const f = toForm({ mode: 'payment', line_items: [{ quantity: 1, price_data: { currency: 'ron' } }] });
  assert.equal(f.get('line_items[0][quantity]'), '1');
  assert.equal(f.get('line_items[0][price_data][currency]'), 'ron');
});

test('webhook: acceptă semnătura validă', () => {
  const payload = JSON.stringify({ type: 'checkout.session.completed' });
  assert.equal(verifyWebhook(payload, signPayload(payload, secret), secret).type, 'checkout.session.completed');
});

test('webhook: respinge payload modificat, secret greșit și semnături vechi', () => {
  const payload = '{"a":1}';
  const header = signPayload(payload, secret);
  assert.throws(() => verifyWebhook('{"a":2}', header, secret), /invalidă/);
  assert.throws(() => verifyWebhook(payload, header, 'whsec_altul'), /invalidă/);
  const old = signPayload(payload, secret, Math.floor(Date.now() / 1000) - 3600);
  assert.throws(() => verifyWebhook(payload, old, secret), /expirată/);
  assert.throws(() => verifyWebhook(payload, undefined, secret), /Lipsește/);
});

test('client Stripe: trimite cheia, idempotency key și parametrii', async () => {
  let seen;
  const stripe = createStripe('sk_test_x', { fetchImpl: async (url, opts) => { seen = { url, opts }; return { ok: true, json: async () => ({ id: 'cs_1', url: 'https://checkout.stripe.com/x' }) }; } });
  await stripe.createCheckoutSession({ mode: 'payment' });
  assert.equal(seen.url, 'https://api.stripe.com/v1/checkout/sessions');
  assert.equal(seen.opts.headers.authorization, 'Bearer sk_test_x');
  assert.ok(seen.opts.headers['idempotency-key']);
  assert.equal(seen.opts.body, 'mode=payment');
});

test('flux complet: checkout → webhook → comandă plătită', async () => {
  const orders = new Map();
  let params;
  const stripe = { createCheckoutSession: async p => { params = p; return { id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' }; } };
  const server = createApp({ stripe, webhookSecret: secret, baseUrl: 'http://localhost', orders, log: () => {} }).listen(0);
  const base = `http://localhost:${server.address().port}`;
  try {
    const bad = await fetch(`${base}/api/checkout`, { method: 'POST', body: JSON.stringify({ productId: 'nu-exista' }) });
    assert.equal(bad.status, 422);

    const res = await fetch(`${base}/api/checkout`, { method: 'POST', body: JSON.stringify({ productId: 'magazin-online', amount: 1 }) });
    assert.equal((await res.json()).url, 'https://checkout.stripe.com/c/pay/cs_test_1');
    assert.equal(params.line_items[0].price_data.unit_amount, 500000, 'prețul vine de pe server, nu din cerere');
    assert.equal(orders.get('cs_test_1').status, 'pending');

    const forged = await fetch(`${base}/webhook`, { method: 'POST', headers: { 'stripe-signature': 't=1,v1=abc' }, body: '{}' });
    assert.equal(forged.status, 400);

    const event = JSON.stringify({ type: 'checkout.session.completed', data: { object: { id: 'cs_test_1', payment_status: 'paid', customer_details: { email: 'client@exemplu.ro' } } } });
    const ok = await fetch(`${base}/webhook`, { method: 'POST', headers: { 'stripe-signature': signPayload(event, secret) }, body: event });
    assert.equal(ok.status, 200);
    assert.equal(orders.get('cs_test_1').status, 'paid');
    assert.match(await (await fetch(`${base}/success?session_id=cs_test_1`)).text(), /confirmată/);
  } finally {
    server.close();
  }
});
