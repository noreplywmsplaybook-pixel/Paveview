function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

async function geocode(query) {
  const q = encodeURIComponent(query);
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${q}&count=1&language=en&format=json`;
  const resp = await fetch(url);
  const payload = await resp.json().catch(() => ({}));
  const item = Array.isArray(payload.results) ? payload.results[0] : null;
  if (!item) return null;
  return {
    latitude: item.latitude,
    longitude: item.longitude,
    label: [item.name, item.admin1, item.country].filter(Boolean).join(', ')
  };
}

async function resolveLocation(address) {
  const direct = await geocode(address);
  if (direct) return direct;
  const base = String(address || '').trim();
  if (!base) return null;
  if (!base.includes(',')) {
    const us = await geocode(`${base}, United States`);
    if (us) return us;
  }
  const regional = await geocode(`${base}, VA`);
  if (regional) return regional;
  return null;
}

async function forecast(latitude, longitude) {
  const params = new URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude),
    timezone: 'auto',
    forecast_days: '16',
    current: 'temperature_2m,wind_speed_10m',
    hourly: [
      'temperature_2m',
      'dew_point_2m',
      'relative_humidity_2m',
      'precipitation',
      'precipitation_probability',
      'wind_speed_10m',
      'cloud_cover',
      'uv_index'
    ].join(',')
  });
  const url = `https://api.open-meteo.com/v1/forecast?${params.toString()}`;
  const resp = await fetch(url);
  if (!resp.ok) return null;
  return resp.json().catch(() => null);
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'Method not allowed.' });
    return;
  }
  const address = String(req.query?.address || '').trim();
  const lat = Number(req.query?.lat);
  const lon = Number(req.query?.lon);
  const defaultLocation = { latitude: 32.7767, longitude: -96.7970, label: 'Dallas, TX, United States' };
  const lynchburgLocation = { latitude: 37.4138, longitude: -79.1422, label: 'Lynchburg, VA, United States' };

  let resolved = null;
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    resolved = { latitude: lat, longitude: lon, label: 'Pinned coordinates' };
  } else if (address && String(address).toLowerCase().includes('lynchburg')) {
    resolved = lynchburgLocation;
  } else if (address) {
    resolved = await resolveLocation(address);
  }

  if (!resolved) {
    if (address) {
      sendJson(res, 400, { error: `Could not resolve location: ${address}` });
      return;
    }
    resolved = defaultLocation;
  }

  const data = await forecast(resolved.latitude, resolved.longitude);
  if (!data?.hourly?.time?.length) {
    sendJson(res, 502, { error: 'Unable to fetch forecast data.' });
    return;
  }

  sendJson(res, 200, {
    ok: true,
    location: resolved,
    timezone: data.timezone,
    current: data.current || null,
    hourly: data.hourly
  });
};
