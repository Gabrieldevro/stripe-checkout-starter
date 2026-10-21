// Pornește serverul: STRIPE_SECRET_KEY=sk_test_... STRIPE_WEBHOOK_SECRET=whsec_... node --env-file=.env server.js
import { createApp } from './src/app.js';
import { createStripe } from './src/stripe.js';

const { STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, PORT = 4242, BASE_URL = `http://localhost:${PORT}` } = process.env;
if (!STRIPE_SECRET_KEY || !STRIPE_WEBHOOK_SECRET) {
  console.error('Setează STRIPE_SECRET_KEY și STRIPE_WEBHOOK_SECRET (vezi .env.example).');
  process.exit(1);
}
if (STRIPE_SECRET_KEY.startsWith('sk_live_') && BASE_URL.startsWith('http://')) {
  console.error('Cheie live pe HTTP — refuz pornirea. Folosește HTTPS în producție.');
  process.exit(1);
}

createApp({ stripe: createStripe(STRIPE_SECRET_KEY), webhookSecret: STRIPE_WEBHOOK_SECRET, baseUrl: BASE_URL })
  .listen(PORT, () => console.log(`Server pornit: ${BASE_URL}`));
