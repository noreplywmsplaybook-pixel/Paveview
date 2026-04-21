const DEFAULT_SUPABASE_URL = 'https://rqgyqqyxlwjpbdkapvpz.supabase.co';

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

function getRequestOrigin(req) {
  const fromEnv = String(process.env.PUBLIC_SITE_URL || '').trim().replace(/\/$/, '');
  if (fromEnv) return fromEnv;
  const vercel = String(process.env.VERCEL_URL || '').trim().replace(/\/$/, '');
  if (vercel) return vercel.startsWith('http') ? vercel : `https://${vercel}`;
  const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim() || 'https';
  const host = String(req.headers.host || '').split(',')[0].trim();
  if (host) return `${proto}://${host}`;
  return '';
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

async function stripePostForm(path, stripeSecretKey, fields) {
  const body = new URLSearchParams();
  Object.entries(fields).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') body.append(k, String(v));
  });
  const resp = await fetch(`https://api.stripe.com${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${stripeSecretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body
  });
  let payload = null;
  try {
    payload = await resp.json();
  } catch (e) {
    payload = null;
  }
  return { ok: resp.ok, status: resp.status, payload };
}

async function findStripeCustomerId(stripeSecretKey, email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return { error: 'Missing account email.' };
  const q = encodeURIComponent(normalized);
  const listRes = await stripeGet(`/v1/customers?email=${q}&limit=10`, stripeSecretKey);
  if (!listRes.ok) {
    return { error: listRes.payload?.error?.message || 'Unable to look up Stripe customer.' };
  }
  const rows = Array.isArray(listRes.payload?.data) ? listRes.payload.data : [];
  const exact = rows.find((c) => normalizeEmail(c?.email) === normalized);
  if (exact?.id) return { customerId: String(exact.id) };
  if (rows[0]?.id) return { customerId: String(rows[0].id) };
  return { error: 'No Stripe billing profile found for this email. Use the same email you used at checkout, or contact support.' };
}

async function handlePost(req, res, serviceRoleKey, stripeSecretKey) {
  if (!stripeSecretKey) {
    sendJson(res, 500, { error: 'Billing is not configured (missing STRIPE_SECRET_KEY).' });
    return;
  }

  const { url } = getEnv();
  const accessToken = parseBearerToken(req);
  const user = await fetchUserByAccessToken(accessToken, { url, serviceRoleKey });
  if (!user?.id) {
    sendJson(res, 401, { error: 'Unauthorized.' });
    return;
  }

  const email = normalizeEmail(user.email || '');
  if (!email) {
    sendJson(res, 400, { error: 'Your account has no email on file.' });
    return;
  }

  const origin = getRequestOrigin(req);
  if (!origin) {
    sendJson(res, 500, { error: 'Could not determine site URL for return link. Set PUBLIC_SITE_URL.' });
    return;
  }

  const returnUrl = `${origin}/dashboard.html`;

  const found = await findStripeCustomerId(stripeSecretKey, email);
  if (found.error) {
    sendJson(res, 404, { error: found.error });
    return;
  }

  const portal = await stripePostForm('/v1/billing_portal/sessions', stripeSecretKey, {
    customer: found.customerId,
    return_url: returnUrl
  });

  if (!portal.ok || !portal.payload?.url) {
    const msg = portal.payload?.error?.message || 'Unable to open billing portal.';
    sendJson(res, portal.status || 502, { error: msg });
    return;
  }

  sendJson(res, 200, { ok: true, url: String(portal.payload.url) });
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
