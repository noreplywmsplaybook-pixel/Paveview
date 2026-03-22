const DEFAULT_SUPABASE_URL = 'https://rqgyqqyxlwjpbdkapvpz.supabase.co';
const LIFETIME_PRODUCT_KEY = 'takeoff';
const LIFETIME_AMOUNT_CENTS = 500000;

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
    headers: {
      Authorization: `Bearer ${stripeSecretKey}`
    }
  });
  let payload = null;
  try {
    payload = await resp.json();
  } catch (e) {
    payload = null;
  }
  return { ok: resp.ok, status: resp.status, payload };
}

function isStripeSessionPaid(session) {
  if (!session) return false;
  const paid = String(session.payment_status || '').toLowerCase() === 'paid';
  const complete = String(session.status || '').toLowerCase() === 'complete';
  const amount = Number(session.amount_total || 0);
  return paid && complete && amount > 0;
}

async function verifyPaidStripeSession({ stripeSecretKey, email, sessionId }) {
  if (!stripeSecretKey) {
    return { error: 'Missing STRIPE_SECRET_KEY environment variable.' };
  }
  const normalizedEmail = normalizeEmail(email);

  if (sessionId) {
    const byId = await stripeGet(`/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, stripeSecretKey);
    if (!byId.ok) {
      return { error: byId.payload?.error?.message || 'Unable to verify Stripe session.' };
    }
    const session = byId.payload || null;
    if (!isStripeSessionPaid(session)) {
      return { error: 'Stripe session is not paid yet.' };
    }
    const sessionEmail = normalizeEmail(session?.customer_details?.email || session?.customer_email || '');
    if (normalizedEmail && sessionEmail && sessionEmail !== normalizedEmail) {
      return { error: 'Stripe payment email does not match this account email.' };
    }
    return { session };
  }

  if (!normalizedEmail) {
    return { error: 'Email is required to verify Stripe payment.' };
  }

  const listRes = await stripeGet('/v1/checkout/sessions?limit=100', stripeSecretKey);
  if (!listRes.ok) {
    return { error: listRes.payload?.error?.message || 'Unable to load Stripe sessions.' };
  }
  const sessions = Array.isArray(listRes.payload?.data) ? listRes.payload.data : [];
  const matched = sessions.find((session) => {
    if (!isStripeSessionPaid(session)) return false;
    const sessionEmail = normalizeEmail(session?.customer_details?.email || session?.customer_email || '');
    return sessionEmail === normalizedEmail;
  });
  if (!matched) {
    return { error: 'No paid Stripe checkout found for this email yet.' };
  }
  return { session: matched };
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

async function insertLifetimePurchase({ userId, stripePaymentIntent, serviceRoleKey }) {
  const baseRecord = {
    user_id: userId,
    product: LIFETIME_PRODUCT_KEY,
    amount_paid: LIFETIME_AMOUNT_CENTS,
    status: 'active'
  };
  const withStripe = stripePaymentIntent ? { ...baseRecord, stripe_payment_intent: stripePaymentIntent } : baseRecord;
  let insert = await supabaseFetch('/rest/v1/purchases', {
    method: 'POST',
    serviceRoleKey,
    prefer: 'return=representation',
    body: [withStripe]
  });
  if (insert.ok) return insert;

  const msg = String(insert.payload?.message || '').toLowerCase();
  if (stripePaymentIntent && msg.includes('stripe_payment_intent')) {
    insert = await supabaseFetch('/rest/v1/purchases', {
      method: 'POST',
      serviceRoleKey,
      prefer: 'return=representation',
      body: [baseRecord]
    });
  }
  return insert;
}

async function handlePost(req, res, serviceRoleKey, stripeSecretKey) {
  let body = {};
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  } catch (e) {
    sendJson(res, 400, { error: 'Invalid JSON body.' });
    return;
  }

  const email = normalizeEmail(body.email);
  const password = String(body.password || '');
  const name = String(body.name || '').trim();
  const stripeSessionId = String(body.stripeSessionId || '').trim();

  if (!email || !password) {
    sendJson(res, 400, { error: 'Email and password are required.' });
    return;
  }
  if (password.length < 6) {
    sendJson(res, 400, { error: 'Password must be at least 6 characters.' });
    return;
  }

  const verified = await verifyPaidStripeSession({
    stripeSecretKey,
    email,
    sessionId: stripeSessionId
  });
  if (verified.error) {
    sendJson(res, 402, { error: verified.error });
    return;
  }

  const created = await createAuthUser({ email, password, name, serviceRoleKey });
  if (!created.ok) {
    const msg = created.payload?.msg || created.payload?.message || 'Failed to create account.';
    const alreadyExists = String(msg).toLowerCase().includes('already') || String(msg).toLowerCase().includes('exists');
    sendJson(res, alreadyExists ? 409 : (created.status || 500), {
      error: alreadyExists
        ? 'An account with this email already exists. Please sign in to upgrade or access your account.'
        : msg
    });
    return;
  }

  const user = created.payload?.user || created.payload || {};
  const userId = user.id;
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

  const stripePaymentIntent = String(verified.session?.payment_intent || '').trim() || null;
  const purchaseInsert = await insertLifetimePurchase({ userId, stripePaymentIntent, serviceRoleKey });
  if (!purchaseInsert.ok) {
    sendJson(res, purchaseInsert.status || 500, {
      error: purchaseInsert.payload?.message || 'Account created, but failed to activate lifetime access.'
    });
    return;
  }

  sendJson(res, 200, {
    ok: true,
    user: {
      id: userId,
      email,
      full_name: name || ''
    },
    product: LIFETIME_PRODUCT_KEY
  });
}

module.exports = async (req, res) => {
  const { serviceRoleKey, stripeSecretKey } = getEnv();
  if (!serviceRoleKey) {
    sendJson(res, 500, { error: 'Missing SUPABASE_SERVICE_ROLE_KEY environment variable.' });
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed.' });
    return;
  }
  await handlePost(req, res, serviceRoleKey, stripeSecretKey);
};
