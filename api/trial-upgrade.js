const DEFAULT_SUPABASE_URL = 'https://rqgyqqyxlwjpbdkapvpz.supabase.co';
const TRIAL_PRODUCT_KEY = 'takeoff_trial_24h';
const LEGACY_LIFETIME_PRODUCT_KEY = 'takeoff';
const LEGACY_LIFETIME_AMOUNT_CENTS = 500000;
const PLAN_BY_AMOUNT_CENTS = {
  9999: { product: 'takeoff_tier1_monthly', amount_paid: 9999 },
  99900: { product: 'takeoff_tier1_annual', amount_paid: 99900 },
  19999: { product: 'takeoff_tier2_monthly', amount_paid: 19999 },
  199999: { product: 'takeoff_tier2_annual', amount_paid: 199999 },
  39999: { product: 'takeoff_tier3_monthly', amount_paid: 39999 },
  399999: { product: 'takeoff_tier3_annual', amount_paid: 399999 }
};

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

function parseBearerToken(req) {
  const authHeader = req.headers?.authorization || req.headers?.Authorization || '';
  if (!authHeader || typeof authHeader !== 'string') return '';
  if (!authHeader.toLowerCase().startsWith('bearer ')) return '';
  return authHeader.slice(7).trim();
}

async function fetchUserByAccessToken(accessToken, { url, serviceRoleKey }) {
  if (!accessToken) return null;
  const resp = await fetch(`${url}/auth/v1/user`, {
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${accessToken}`
    }
  });
  if (!resp.ok) return null;
  try {
    return await resp.json();
  } catch (e) {
    return null;
  }
}

async function fetchAuthUsersByEmail(email, serviceRoleKey) {
  const target = normalizeEmail(email);
  if (!target) return null;
  const perPage = 200;
  for (let page = 1; page <= 10; page += 1) {
    const chunkRes = await supabaseFetch(`/auth/v1/admin/users?page=${page}&per_page=${perPage}`, { serviceRoleKey });
    if (!chunkRes.ok || !chunkRes.payload) break;
    const users = Array.isArray(chunkRes.payload.users) ? chunkRes.payload.users : [];
    const matched = users.find((u) => normalizeEmail(u.email) === target);
    if (matched) {
      return {
        id: matched.id || null,
        email: normalizeEmail(matched.email),
        user_metadata: matched.user_metadata || {}
      };
    }
    if (users.length < perPage) break;
  }
  return null;
}

function isTrialPurchase(purchase) {
  const product = String(purchase?.product || '').toLowerCase();
  const hasExplicitFreeAmount = purchase?.amount_paid !== null && purchase?.amount_paid !== undefined && Number(purchase?.amount_paid) === 0;
  return product.includes('trial') || hasExplicitFreeAmount;
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
  return paid && complete;
}

async function getVerifiedPaidSession({ stripeSecretKey, sessionId, email }) {
  const normalizedEmail = normalizeEmail(email);
  if (!stripeSecretKey) return { error: 'Missing STRIPE_SECRET_KEY environment variable.' };

  if (sessionId) {
    const sessionRes = await stripeGet(`/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, stripeSecretKey);
    if (!sessionRes.ok) {
      return { error: sessionRes.payload?.error?.message || 'Unable to verify Stripe checkout session.' };
    }
    const session = sessionRes.payload || null;
    if (!isStripeSessionPaid(session)) {
      return { error: 'Stripe session is not paid yet.' };
    }
    const sessionEmail = normalizeEmail(session?.customer_details?.email || session?.customer_email || '');
    if (normalizedEmail && sessionEmail && sessionEmail !== normalizedEmail) {
      return { error: 'Paid Stripe session email does not match this account.' };
    }
    return { session };
  }

  if (!normalizedEmail) {
    return { error: 'Email is required to verify Stripe payment.' };
  }

  const listRes = await stripeGet('/v1/checkout/sessions?limit=100', stripeSecretKey);
  if (!listRes.ok) {
    return { error: listRes.payload?.error?.message || 'Unable to load Stripe sessions for verification.' };
  }
  const sessions = Array.isArray(listRes.payload?.data) ? listRes.payload.data : [];
  const matched = sessions.find((session) => {
    if (!isStripeSessionPaid(session)) return false;
    const sessionEmail = normalizeEmail(session?.customer_details?.email || session?.customer_email || '');
    if (sessionEmail !== normalizedEmail) return false;
    const amount = Number(session?.amount_total || 0);
    return amount > 0;
  });
  if (!matched) {
    return { error: 'No paid Stripe checkout found for this email yet.' };
  }
  return { session: matched };
}

function purchaseRecordFromSession(session) {
  const amount = Number(session?.amount_total || 0);
  const mapped = PLAN_BY_AMOUNT_CENTS[amount];
  if (mapped) return mapped;
  return {
    product: LEGACY_LIFETIME_PRODUCT_KEY,
    amount_paid: amount > 0 ? amount : LEGACY_LIFETIME_AMOUNT_CENTS
  };
}

async function insertPaidPurchase({ userId, stripePaymentIntent, serviceRoleKey, session }) {
  const resolved = purchaseRecordFromSession(session);
  const baseRecord = {
    user_id: userId,
    product: resolved.product,
    amount_paid: resolved.amount_paid,
    status: 'active'
  };

  const withStripeIntent = stripePaymentIntent
    ? { ...baseRecord, stripe_payment_intent: stripePaymentIntent }
    : baseRecord;

  let insert = await supabaseFetch('/rest/v1/purchases', {
    method: 'POST',
    serviceRoleKey,
    prefer: 'return=representation',
    body: [withStripeIntent]
  });
  if (insert.ok) return insert;

  const errMsg = String(insert.payload?.message || '').toLowerCase();
  if (stripePaymentIntent && errMsg.includes('stripe_payment_intent')) {
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

  const { url } = getEnv();
  const accessToken = parseBearerToken(req) || String(body.accessToken || '');
  const sessionUser = await fetchUserByAccessToken(accessToken, { url, serviceRoleKey });

  let userId = String(body.userId || sessionUser?.id || '').trim();
  let email = normalizeEmail(body.email || sessionUser?.email || '');

  if (!userId && email) {
    const profileLookup = await supabaseFetch(
      `/rest/v1/profiles?select=id,email&email=eq.${encodeURIComponent(email)}&limit=1`,
      { serviceRoleKey }
    );
    const profile = Array.isArray(profileLookup.payload) ? profileLookup.payload[0] : null;
    if (profile?.id) userId = String(profile.id);
  }

  if (!userId && email) {
    const authUser = await fetchAuthUsersByEmail(email, serviceRoleKey);
    if (authUser?.id) {
      userId = String(authUser.id);
      if (!email && authUser.email) email = normalizeEmail(authUser.email);
    }
  }

  if (!userId) {
    sendJson(res, 400, { error: 'Unable to identify the account to upgrade.' });
    return;
  }

  const purchasesResp = await supabaseFetch(
    `/rest/v1/purchases?select=id,product,status,amount_paid,created_at&user_id=eq.${encodeURIComponent(userId)}&status=eq.active&order=created_at.desc`,
    { serviceRoleKey }
  );
  const activePurchases = Array.isArray(purchasesResp.payload) ? purchasesResp.payload : [];
  const paidAlready = activePurchases.find((purchase) => !isTrialPurchase(purchase));
  if (paidAlready) {
    sendJson(res, 200, { ok: true, alreadyPaid: true, user_id: userId });
    return;
  }

  const verified = await getVerifiedPaidSession({
    stripeSecretKey,
    sessionId: String(body.stripeSessionId || ''),
    email
  });
  if (verified.error) {
    sendJson(res, 402, { error: verified.error });
    return;
  }

  await supabaseFetch(
    `/rest/v1/purchases?user_id=eq.${encodeURIComponent(userId)}&status=eq.active&product=eq.${encodeURIComponent(TRIAL_PRODUCT_KEY)}`,
    {
      method: 'PATCH',
      serviceRoleKey,
      body: { status: 'revoked' }
    }
  );

  const stripePaymentIntent = String(verified.session?.payment_intent || '').trim() || null;
  const insertPaid = await insertPaidPurchase({
    userId,
    stripePaymentIntent,
    serviceRoleKey,
    session: verified.session
  });
  if (!insertPaid.ok) {
    sendJson(res, insertPaid.status || 500, {
      error: insertPaid.payload?.message || 'Payment verified, but failed to activate paid lifetime access.'
    });
    return;
  }

  const insertedRecord = Array.isArray(insertPaid.payload) ? insertPaid.payload[0] : null;
  sendJson(res, 200, {
    ok: true,
    upgraded: true,
    user_id: userId,
    purchase_id: insertedRecord?.id || null,
    product: insertedRecord?.product || purchaseRecordFromSession(verified.session).product
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
