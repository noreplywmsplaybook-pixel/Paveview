const DEFAULT_SUPABASE_URL = 'https://rqgyqqyxlwjpbdkapvpz.supabase.co';
const TRIAL_PRODUCT_KEY = 'takeoff_trial_24h';
const TRIAL_DURATION_MS = 24 * 60 * 60 * 1000;

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

function getEnv() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || DEFAULT_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '';
  return { url, serviceRoleKey };
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

function isTrialPurchase(purchase) {
  const product = String(purchase?.product || '').toLowerCase();
  const hasExplicitFreeAmount = purchase?.amount_paid !== null && purchase?.amount_paid !== undefined && Number(purchase?.amount_paid) === 0;
  return product.includes('trial') || hasExplicitFreeAmount;
}

function toIsoDatePlusMs(ms) {
  return new Date(Date.now() + ms).toISOString();
}

async function createAuthUser({ email, password, fullName, serviceRoleKey }) {
  const createAuth = await supabaseFetch('/auth/v1/admin/users', {
    method: 'POST',
    serviceRoleKey,
    body: {
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: fullName || '' }
    }
  });
  if (!createAuth.ok) return createAuth;
  return createAuth;
}

async function handlePost(req, res, serviceRoleKey) {
  let body = {};
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  } catch (e) {
    sendJson(res, 400, { error: 'Invalid JSON body.' });
    return;
  }

  const email = normalizeEmail(body.email);
  const password = String(body.password || '');
  const fullName = String(body.name || '').trim();

  if (!email || !password) {
    sendJson(res, 400, { error: 'Email and password are required.' });
    return;
  }
  if (password.length < 6) {
    sendJson(res, 400, { error: 'Password must be at least 6 characters.' });
    return;
  }

  const created = await createAuthUser({ email, password, fullName, serviceRoleKey });
  if (!created.ok) {
    const upstreamMsg = created.payload?.msg || created.payload?.message || 'Failed to create auth user.';
    const alreadyExists = String(upstreamMsg).toLowerCase().includes('already') || String(upstreamMsg).toLowerCase().includes('exists');
    sendJson(res, alreadyExists ? 409 : (created.status || 500), {
      error: alreadyExists
        ? 'An account with this email already exists. Please sign in instead.'
        : upstreamMsg
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
      full_name: fullName || null,
      updated_at: new Date().toISOString()
    }]
  });

  const purchasesResp = await supabaseFetch(
    `/rest/v1/purchases?select=id,product,status,amount_paid,created_at&user_id=eq.${encodeURIComponent(userId)}&status=eq.active&order=created_at.desc`,
    { serviceRoleKey }
  );
  const activePurchases = Array.isArray(purchasesResp.payload) ? purchasesResp.payload : [];
  const activePaid = activePurchases.find((p) => !isTrialPurchase(p));

  if (activePaid) {
    sendJson(res, 200, {
      ok: true,
      alreadyPaid: true,
      user: { id: userId, email, full_name: fullName || '' }
    });
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

  const insertTrial = await supabaseFetch('/rest/v1/purchases', {
    method: 'POST',
    serviceRoleKey,
    body: [{
      user_id: userId,
      product: TRIAL_PRODUCT_KEY,
      amount_paid: 0,
      status: 'active'
    }]
  });
  if (!insertTrial.ok) {
    sendJson(res, insertTrial.status || 500, { error: insertTrial.payload?.message || 'Trial setup failed.' });
    return;
  }

  sendJson(res, 200, {
    ok: true,
    user: { id: userId, email, full_name: fullName || '' },
    trial: {
      product: TRIAL_PRODUCT_KEY,
      expires_at: toIsoDatePlusMs(TRIAL_DURATION_MS)
    }
  });
}

module.exports = async (req, res) => {
  const { serviceRoleKey } = getEnv();
  if (!serviceRoleKey) {
    sendJson(res, 500, { error: 'Missing SUPABASE_SERVICE_ROLE_KEY environment variable.' });
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed.' });
    return;
  }
  await handlePost(req, res, serviceRoleKey);
};
