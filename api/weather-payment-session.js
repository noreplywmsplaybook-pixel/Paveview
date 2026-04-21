const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

function normalizeEmail(raw) {
  return String(raw || '').trim().toLowerCase();
}

async function stripeGet(path) {
  const resp = await fetch(`https://api.stripe.com${path}`, {
    headers: { Authorization: `Bearer ${STRIPE_SECRET_KEY}` }
  });
  let payload = null;
  try {
    payload = await resp.json();
  } catch (e) {
    payload = null;
  }
  return { ok: resp.ok, status: resp.status, payload };
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'Method not allowed.' });
    return;
  }
  if (!STRIPE_SECRET_KEY) {
    sendJson(res, 500, { error: 'Missing STRIPE_SECRET_KEY environment variable.' });
    return;
  }
  const sessionId = String(req.query?.session_id || req.query?.stripe_session_id || '').trim();
  if (!sessionId) {
    sendJson(res, 400, { error: 'Missing session_id.' });
    return;
  }
  const detail = await stripeGet(`/v1/checkout/sessions/${encodeURIComponent(sessionId)}`);
  if (!detail.ok || !detail.payload) {
    sendJson(res, detail.status || 400, { error: detail.payload?.error?.message || 'Unable to load Stripe session.' });
    return;
  }
  const session = detail.payload;
  const paid = String(session.payment_status || '').toLowerCase() === 'paid' && String(session.status || '').toLowerCase() === 'complete';
  if (!paid) {
    sendJson(res, 402, { error: 'Payment is not complete yet.' });
    return;
  }
  const amount = Number(session.amount_total || 0);
  if (amount < 2000) {
    sendJson(res, 422, { error: 'Unexpected payment amount for Weather Planner.' });
    return;
  }
  const email = normalizeEmail(session?.customer_details?.email || session?.customer_email || '');
  if (!email) {
    sendJson(res, 422, { error: 'Stripe session did not include a customer email.' });
    return;
  }
  sendJson(res, 200, { ok: true, email });
};
