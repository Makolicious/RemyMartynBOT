// ── Temporary Shopify Webhook Registration Endpoint ─────────────────────────
// Hit this once to register webhooks, then it can be deleted
// Usage: GET https://remymartynbot.vercel.app/api/shopify-setup?key=YOUR_BOSS_ID

const https = require('https');

const STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const WEBHOOK_URL = 'https://remymartynbot.vercel.app/api/shopify-webhook';

const topics = ['orders/create', 'orders/paid', 'orders/updated'];

async function registerWebhook(topic) {
  return new Promise((resolve, reject) => {
    const query = `mutation CreateWebhook($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) {
      webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
        userErrors { field message }
        webhookSubscription { id endpoint { __typename } }
      }
    }`;

    const variables = {
      topic,
      webhookSubscription: {
        callbackUrl: WEBHOOK_URL,
        format: 'JSON',
      },
    };

    const payload = JSON.stringify({ query, variables });

    const options = {
      hostname: STORE_DOMAIN,
      path: '/admin/api/2025-01/graphql.json',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': ACCESS_TOKEN,
        'Content-Length': Buffer.byteLength(payload),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        // Return raw response so we can debug
        resolve({ status: res.statusCode, body: data });
      });
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

module.exports = async (req, res) => {
  // Basic auth check — must provide correct key
  const key = req.query?.key || '';
  if (key !== process.env.MY_TELEGRAM_ID) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!STORE_DOMAIN || !ACCESS_TOKEN) {
    return res.status(400).json({ error: 'Missing SHOPIFY_STORE_DOMAIN or SHOPIFY_ACCESS_TOKEN env vars' });
  }

  const results = {};

  for (const topic of topics) {
    try {
      const r = await registerWebhook(topic);
      results[topic] = r;
    } catch (err) {
      results[topic] = `✗ ${err.message || JSON.stringify(err)}`;
    }
  }

  res.json({
    message: 'Webhook registration complete',
    results,
    note: 'This endpoint can now be deleted (api/shopify-setup.js)',
  });
};
