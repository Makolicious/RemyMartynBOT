#!/usr/bin/env node

/**
 * Register Shopify webhooks via the Admin API
 * Usage: SHOPIFY_ACCESS_TOKEN=xyz SHOPIFY_STORE_DOMAIN=fastpvlabels.myshopify.com node scripts/register-shopify-webhooks.js
 */

const https = require('https');

const STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL || 'https://remymartynbot.vercel.app/api/shopify-webhook';

if (!STORE_DOMAIN || !ACCESS_TOKEN) {
  console.error('Missing required env vars: SHOPIFY_STORE_DOMAIN, SHOPIFY_ACCESS_TOKEN');
  process.exit(1);
}

const topics = [
  'orders/create',
  'orders/paid',
  'orders/updated',
];

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

    const payload = JSON.stringify({
      query,
      variables,
    });

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
        try {
          const response = JSON.parse(data);
          if (response.data?.webhookSubscriptionCreate?.userErrors?.length > 0) {
            reject(new Error(`Webhook registration failed: ${JSON.stringify(response.data.webhookSubscriptionCreate.userErrors)}`));
          } else if (response.errors) {
            reject(new Error(`GraphQL error: ${JSON.stringify(response.errors)}`));
          } else {
            resolve(response);
          }
        } catch (e) {
          reject(new Error(`Failed to parse response: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function main() {
  console.log(`Registering webhooks for store: ${STORE_DOMAIN}`);
  console.log(`Webhook URL: ${WEBHOOK_URL}\n`);

  for (const topic of topics) {
    try {
      console.log(`Registering ${topic}...`);
      await registerWebhook(topic);
      console.log(`✓ ${topic} registered\n`);
    } catch (err) {
      console.error(`✗ Failed to register ${topic}: ${err.message}\n`);
    }
  }

  console.log('Done!');
}

main();
