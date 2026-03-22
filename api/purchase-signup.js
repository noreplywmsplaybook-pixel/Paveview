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
  const paymentMode = String(session.mode || '').toLowerCase() === 'payment';
  const paid = String(session.payment_status || '').toLowerCase() === 'paid';
  const complete = String(session.status || '').toLowerCase() === 'complete';
  const amount = Number(session.amount_total || 0);
  return paymentMode && paid && complete && amount > 0;
}

async function verifyPaidStripeSession({ stripeSecretKey, sessionId }) {
  if (!stripeSecretKey) {
    return { error: 'Missing STRIPE_SECRET_KEY environment variable.' };
  }

  if (!sessionId) {
    return { error: 'Missing Stripe checkout session id.' };
  }

  const byId = await stripeGet(`/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, stripeSecretKey);
  if (!byId.ok) {
    return { error: byId.payload?.error?.message || 'Unable to verify Stripe session.' };
  }
  const session = byId.payload || null;
  if (!isStripeSessionPaid(session)) {
    return { error: 'Stripe session is not paid yet.' };
  }
  const sessionEmail = normalizeEmail(session?.customer_details?.email || session?.customer_email || '');
  if (!sessionEmail) {
    return { error: 'Paid Stripe session is missing customer email.' };
  }
  return { session, sessionEmail };
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

async function findAuthUserByEmail(email, serviceRoleKey) {
  const target = normalizeEmail(email);
  if (!target) return null;
  const perPage = 200;
  for (let page = 1; page <= 10; page += 1) {
    const chunkRes = await supabaseFetch(`/auth/v1/admin/users?page=${page}&per_page=${perPage}`, { serviceRoleKey });
    if (!chunkRes.ok || !chunkRes.payload) break;
    const users = Array.isArray(chunkRes.payload.users) ? chunkRes.payload.users : [];
    const matched = users.find((u) => normalizeEmail(u.email) === target);
    if (matched) return matched;
    if (users.length < perPage) break;
  }
  return null;
}

async function findPurchaseByPaymentIntent(stripePaymentIntent, serviceRoleKey) {
  if (!stripePaymentIntent) return { claimed: false, error: '' };
  const existing = await supabaseFetch(
    `/rest/v1/purchases?select=id,user_id&stripe_payment_intent=eq.${encodeURIComponent(stripePaymentIntent)}&limit=1`,
    { serviceRoleKey }
  );
  if (!existing.ok) {
    return {
      claimed: false,
      error: existing.payload?.message || 'Unable to validate Stripe payment claim.'
    };
  }
  const rows = Array.isArray(existing.payload) ? existing.payload : [];
  return { claimed: rows.length > 0, error: '' };
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

  const submittedEmail = normalizeEmail(body.email);
  const password = String(body.password || '');
  const name = String(body.name || '').trim();
  const stripeSessionId = String(body.stripeSessionId || '').trim();

  if (!password) {
    sendJson(res, 400, { error: 'Password is required.' });
    return;
  }
  if (password.length < 6) {
    sendJson(res, 400, { error: 'Password must be at least 6 characters.' });
    return;
  }

  const verified = await verifyPaidStripeSession({
    stripeSecretKey,
    sessionId: stripeSessionId
  });
  if (verified.error) {
    sendJson(res, 402, { error: verified.error });
    return;
  }
  const verifiedEmail = normalizeEmail(verified.sessionEmail);
  if (submittedEmail && submittedEmail !== verifiedEmail) {
    sendJson(res, 400, { error: 'Email must match the Stripe checkout email for this purchase.' });
    return;
  }
  const stripePaymentIntent = String(verified.session?.payment_intent || '').trim() || '';
  if (!stripePaymentIntent) {
    sendJson(res, 402, {
      error: 'Stripe payment intent not found for this checkout session.'
    });
    return;
  }
  if (stripePaymentIntent) {
    const claimedCheck = await findPurchaseByPaymentIntent(stripePaymentIntent, serviceRoleKey);
    if (claimedCheck.error) {
      sendJson(res, 500, { error: claimedCheck.error });
      return;
    }
    if (claimedCheck.claimed) {
      sendJson(res, 409, { error: 'This Stripe checkout has already been claimed by an account.' });
      return;
    }
  }

  const existingAuthUser = await findAuthUserByEmail(verifiedEmail, serviceRoleKey);
  if (existingAuthUser?.id) {
    sendJson(res, 409, {
      error: 'An account for this purchased email already exists. Please sign in.'
    });
    return;
  }

  const created = await createAuthUser({ email: verifiedEmail, password, name, serviceRoleKey });
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
      email: verifiedEmail,
      full_name: name || null,
      updated_at: new Date().toISOString()
    }]
  });

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
      email: verifiedEmail,
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
