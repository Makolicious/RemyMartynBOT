// ── Shopify Webhook Handler ────────────────────────────────────────────────────
// Listens for orders/create and orders/paid events
// Sends Telegram notifications to the boss via Remy

const crypto = require('crypto');
const { bot, BOSS_ID } = require('./lib/telegram');

// HMAC verification for Shopify webhooks
const verifyShopifyWebhook = (req, rawBody) => {
  const hmacHeader = req.headers['x-shopify-hmac-sha256'];
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;

  if (!hmacHeader || !secret) {
    console.log('[SHOPIFY] Missing HMAC header or secret');
    return false;
  }

  // rawBody should be the exact bytes Shopify sent
  const bodyString = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');

  const hash = crypto
    .createHmac('sha256', secret)
    .update(bodyString, 'utf8')
    .digest('base64');

  const isValid = hash === hmacHeader;
  if (!isValid) {
    console.log('[SHOPIFY] HMAC verification failed. Expected:', hmacHeader, 'Got:', hash);
  }
  return isValid;
};

// Read raw request body from stream (must run before any body parsing)
const readRawBody = (req) => new Promise((resolve, reject) => {
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  req.on('error', reject);
});

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(200).send('Shopify webhook endpoint ready');
  }

  // Read raw body BEFORE any parsing happens
  let rawBody;
  try {
    rawBody = await readRawBody(req);
  } catch (e) {
    console.error('[SHOPIFY] Failed to read raw body:', e);
    return res.status(400).send('Bad request');
  }

  console.log('[SHOPIFY] Received webhook. Topic:', req.headers['x-shopify-topic'], 'BodyLen:', rawBody.length);

  // Verify the webhook came from Shopify
  if (!verifyShopifyWebhook(req, rawBody)) {
    return res.status(401).send('Unauthorized');
  }

  const topic = req.headers['x-shopify-topic'];
  let body;
  try {
    body = JSON.parse(rawBody);
  } catch (e) {
    console.error('[SHOPIFY] Failed to parse JSON body');
    return res.status(400).send('Invalid JSON');
  }

  try {
    switch (topic) {
      case 'orders/create':
        return handleOrderCreate(body, res);
      case 'orders/paid':
        return handleOrderPaid(body, res);
      case 'orders/updated':
        return handleOrderUpdated(body, res);
      default:
        console.log(`[SHOPIFY] Ignored topic: ${topic}`);
        return res.status(200).send('OK');
    }
  } catch (err) {
    console.error('[SHOPIFY] Error:', err);
    return res.status(500).send('Internal error');
  }
};

async function handleOrderCreate(order, res) {
  const {
    id,
    order_number,
    customer,
    total_price,
    currency,
    line_items,
  } = order;

  const customerName = customer?.first_name || 'Guest';
  const items = Array.isArray(line_items) ? line_items : [];
  const itemCount = items.length;
  const itemNames = items.map(item => item.title).join(', ');

  const message = `📦 New Order #${order_number}\n\n` +
    `Customer: ${customerName}\n` +
    `Items: ${itemNames}\n` +
    `Total: ${currency} ${total_price}\n` +
    `Items count: ${itemCount}`;

  try {
    await bot.sendMessage(BOSS_ID, message);
    console.log(`[SHOPIFY] Sent order/create notification for #${order_number}`);
    return res.status(200).send('OK');
  } catch (err) {
    console.error('[SHOPIFY] Failed to send message:', err);
    return res.status(200).send('OK'); // Still return 200 to Shopify so it doesn't retry
  }
}

async function handleOrderPaid(order, res) {
  const {
    order_number,
    customer,
    total_price,
    currency,
    financial_status,
  } = order;

  const customerName = customer?.first_name || 'Guest';

  let paymentStatus = 'fully paid';
  if (financial_status === 'partially_paid') {
    paymentStatus = 'partially paid';
  }

  const message = `💳 Order #${order_number} ${paymentStatus.toUpperCase()}\n\n` +
    `Customer: ${customerName}\n` +
    `Amount: ${currency} ${total_price}`;

  try {
    await bot.sendMessage(BOSS_ID, message);
    console.log(`[SHOPIFY] Sent order/paid notification for #${order_number}`);
    return res.status(200).send('OK');
  } catch (err) {
    console.error('[SHOPIFY] Failed to send message:', err);
    return res.status(200).send('OK');
  }
}

async function handleOrderUpdated(order, res) {
  // Catch partial payment transitions
  const { order_number, customer, total_price, currency, financial_status } = order;

  if (financial_status === 'partially_paid') {
    const customerName = customer?.first_name || 'Guest';
    const message = `💰 Order #${order_number} - Partial Payment Received\n\n` +
      `Customer: ${customerName}\n` +
      `Amount: ${currency} ${total_price}`;

    try {
      await bot.sendMessage(BOSS_ID, message);
      console.log(`[SHOPIFY] Sent partial payment notification for #${order_number}`);
    } catch (err) {
      console.error('[SHOPIFY] Failed to send message:', err);
    }
  }

  return res.status(200).send('OK');
}

// Disable Vercel automatic body parsing — we need raw bytes for HMAC
module.exports.config = { api: { bodyParser: false } };
