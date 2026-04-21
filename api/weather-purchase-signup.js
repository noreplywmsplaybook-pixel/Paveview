const DEFAULT_SUPABASE_URL = 'https://rqgyqqyxlwjpbdkapvpz.supabase.co';
const WEATHER_PRODUCT_KEY = 'weather_calendar';
const WEATHER_AMOUNT_CENTS = 2000;

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

function getEnv() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || DEFAULT_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '';
  const stripeSecretKey = process.env.STRIPE_SECRET_KEY || '';
  return { url, serviceRoleKey, stripeSecretKey };
}

function normalizeEmail(raw) {
  return String(raw || '').trim().toLowerCase();
}

async function supabaseFetch(path, { method = 'GET', serviceRoleKey, body, prefer } = {}) {
  const { url } = getEnv();
  const headers = {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (prefer) headers.Prefer = prefer;
  const resp = await fetch(`${url}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let payload = null;
  try {
    payload = await resp.json();
  } catch (e) {
    payload = null;
  }
  return { ok: resp.ok, status: resp.status, payload };
}

async function stripeGet(path, stripeSecretKey) {
  const resp = await fetch(`https://api.stripe.com${path}`, {
    headers: { Authorization: `Bearer ${stripeSecretKey}` }
  });
  let payload = null;
  try {
    payload = await resp.json();
  } catch (e) {
    payload = null;
  }
  return { ok: resp.ok, status: resp.status, payload };
}

async function verifyWeatherSession(stripeSecretKey, sessionId) {
  const detail = await stripeGet(`/v1/checkout/sessions/${encodeURIComponent(sessionId)}?expand[]=line_items.data.price`, stripeSecretKey);
  if (!detail.ok || !detail.payload) return { error: detail.payload?.error?.message || 'Unable to verify Stripe session.' };
  const session = detail.payload;
  const paid = String(session.payment_status || '').toLowerCase() === 'paid' && String(session.status || '').toLowerCase() === 'complete';
  if (!paid) return { error: 'Payment is not complete yet.' };
  const amount = Number(session.amount_total || 0);
  if (amount < WEATHER_AMOUNT_CENTS) return { error: 'Unexpected payment amount for Weather Planner.' };
  const email = normalizeEmail(session?.customer_details?.email || session?.customer_email || '');
  if (!email) return { error: 'Stripe checkout email was missing.' };
  return {
    session,
    email,
    stripePaymentIntent: String(session.payment_intent || '').trim() || null
  };
}

async function createAuthUser({ email, password, name, serviceRoleKey }) {
  return supabaseFetch('/auth/v1/admin/users', {
    method: 'POST',
    serviceRoleKey,
    body: {
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: name || '' }
    }
  });
}

module.exports = async (req, res) => {
  const { serviceRoleKey, stripeSecretKey } = getEnv();
  if (!serviceRoleKey) {
    sendJson(res, 500, { error: 'Missing SUPABASE_SERVICE_ROLE_KEY environment variable.' });
    return;
  }
  if (!stripeSecretKey) {
    sendJson(res, 500, { error: 'Missing STRIPE_SECRET_KEY environment variable.' });
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed.' });
    return;
  }
  let body = {};
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  } catch (e) {
    sendJson(res, 400, { error: 'Invalid JSON body.' });
    return;
  }
  const stripeSessionId = String(body.stripeSessionId || '').trim();
  const password = String(body.password || '');
  const name = String(body.name || '').trim();
  if (!stripeSessionId) {
    sendJson(res, 400, { error: 'Missing Stripe session id.' });
    return;
  }
  if (password.length < 6) {
    sendJson(res, 400, { error: 'Password must be at least 6 characters.' });
    return;
  }
  const verified = await verifyWeatherSession(stripeSecretKey, stripeSessionId);
  if (verified.error) {
    sendJson(res, 402, { error: verified.error });
    return;
  }
  const email = verified.email;
  const created = await createAuthUser({ email, password, name, serviceRoleKey });
  if (!created.ok) {
    const msg = created.payload?.msg || created.payload?.message || 'Failed to create account.';
    const exists = String(msg).toLowerCase().includes('already') || String(msg).toLowerCase().includes('exists');
    sendJson(res, exists ? 409 : (created.status || 500), {
      error: exists ? 'An account with this email already exists. Please log in or reset password.' : msg
    });
    return;
  }
  const user = created.payload?.user || created.payload || {};
  const userId = String(user.id || '').trim();
  if (!userId) {
    sendJson(res, 500, { error: 'Auth user created without id.' });
    return;
  }
  await supabaseFetch('/rest/v1/profiles?on_conflict=id', {
    method: 'POST',
    serviceRoleKey,
    prefer: 'resolution=merge-duplicates',
    body: [{
      id: userId,
      email,
      full_name: name || null,
      updated_at: new Date().toISOString()
    }]
  });
  const basePurchase = {
    user_id: userId,
    product: WEATHER_PRODUCT_KEY,
    amount_paid: WEATHER_AMOUNT_CENTS,
    status: 'active'
  };
  const purchase = verified.stripePaymentIntent
    ? { ...basePurchase, stripe_payment_intent: verified.stripePaymentIntent }
    : basePurchase;
  const inserted = await supabaseFetch('/rest/v1/purchases', {
    method: 'POST',
    serviceRoleKey,
    prefer: 'return=representation',
    body: [purchase]
  });
  if (!inserted.ok) {
    sendJson(res, inserted.status || 500, { error: inserted.payload?.message || 'Account created, but failed to activate Weather access.' });
    return;
  }
  sendJson(res, 200, { ok: true, email });
};
