// Server HTTP fără framework: catalog, creare sesiune Stripe Checkout, webhook și pagini de rezultat.
import http from 'node:http';
import fs from 'node:fs';
import { verifyWebhook } from './stripe.js';

// Prețurile stau pe server — clientul trimite doar ID-ul produsului, niciodată suma.
export const products = {
  'site-prezentare': { name: 'Site de prezentare', amount: 250000, currency: 'ron' },
  'magazin-online': { name: 'Magazin online', amount: 500000, currency: 'ron' },
  'mentenanta-lunara': { name: 'Mentenanță lunară', amount: 30000, currency: 'ron', recurring: 'month' },
};

const readBody = req => new Promise((resolve, reject) => {
  const chunks = [];
  req.on('data', c => chunks.push(c)).on('end', () => resolve(Buffer.concat(chunks).toString('utf8'))).on('error', reject);
});
const send = (res, status, body, type = 'application/json') => {
  res.writeHead(status, { 'content-type': `${type}; charset=utf-8` });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};

export function createApp({ stripe, webhookSecret, baseUrl, orders = new Map(), log = console.log }) {
  async function handle(req, res) {
    const url = new URL(req.url, baseUrl);

    if (req.method === 'GET' && url.pathname === '/') {
      return send(res, 200, fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8'), 'text/html');
    }
    if (req.method === 'GET' && url.pathname === '/api/products') return send(res, 200, products);

    if (req.method === 'POST' && url.pathname === '/api/checkout') {
      let input;
      try { input = JSON.parse(await readBody(req) || '{}'); } catch { return send(res, 400, { error: 'JSON invalid' }); }
      const p = products[input.productId];
      if (!p) return send(res, 422, { error: 'Produs necunoscut' });
      const session = await stripe.createCheckoutSession({
        mode: p.recurring ? 'subscription' : 'payment',
        line_items: [{
          quantity: 1,
          price_data: { currency: p.currency, unit_amount: p.amount, product_data: { name: p.name }, ...(p.recurring ? { recurring: { interval: p.recurring } } : {}) },
        }],
        success_url: `${baseUrl}/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${baseUrl}/?anulat=1`,
        metadata: { productId: input.productId },
        ...(p.recurring ? {} : { invoice_creation: { enabled: true } }),
      });
      orders.set(session.id, { productId: input.productId, status: 'pending' });
      return send(res, 200, { url: session.url });
    }

    if (req.method === 'POST' && url.pathname === '/webhook') {
      const raw = await readBody(req); // corpul brut: semnătura se calculează pe bytes exacți
      let event;
      try { event = verifyWebhook(raw, req.headers['stripe-signature'], webhookSecret); } catch (err) { return send(res, 400, { error: err.message }); }

      const obj = event.data?.object || {};
      switch (event.type) {
        case 'checkout.session.completed':
        case 'checkout.session.async_payment_succeeded':
          if (obj.payment_status === 'paid' || obj.mode === 'subscription') {
            orders.set(obj.id, { ...(orders.get(obj.id) || {}), status: 'paid', email: obj.customer_details?.email });
            log(`✔ Comandă plătită: ${obj.id}`);
          }
          break;
        case 'checkout.session.async_payment_failed':
          orders.set(obj.id, { ...(orders.get(obj.id) || {}), status: 'failed' });
          break;
        case 'customer.subscription.deleted':
          log(`Abonament anulat: ${obj.id}`);
          break;
      }
      return send(res, 200, { received: true }); // 2xx rapid, altfel Stripe reîncearcă
    }

    if (req.method === 'GET' && url.pathname === '/success') {
      const id = url.searchParams.get('session_id') || '';
      const order = orders.get(id);
      const paid = order?.status === 'paid';
      return send(res, 200, `<!doctype html><meta charset="utf-8"><title>Plată</title><body style="font-family:system-ui;padding:3rem;text-align:center">
        <h1>${paid ? 'Plata a fost confirmată ✔' : 'Plata se procesează…'}</h1>
        <p>${paid ? 'Mulțumim! Ai primit factura pe email.' : 'Confirmarea vine prin webhook în câteva secunde. Reîmprospătează pagina.'}</p>
        <a href="/">Înapoi</a></body>`, 'text/html');
    }

    return send(res, 404, { error: 'Not found' });
  }

  return http.createServer((req, res) => handle(req, res).catch(err => {
    log(`Eroare: ${err.message}`);
    send(res, err.status && err.status < 500 ? 400 : 500, { error: 'Plata nu a putut fi inițiată' });
  }));
}
