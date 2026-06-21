/**
 * Netlify Function: ga4.js v4
 * Full event inventory + rich dimension queries using all 35 registered custom dimensions.
 * Server-side cache (5-min TTL) to reduce GA4 API calls and avoid 429 rate limits.
 */

const GA4_PROPERTY_ID = '503373961';
const GA4_API_BASE = 'https://analyticsdata.googleapis.com/v1beta';
const TOKEN_URI = 'https://oauth2.googleapis.com/token';

// In-memory cache — survives across warm invocations of the same Netlify Function instance
const _cache = {};
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function base64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function getAccessToken(serviceAccount) {
  const crypto = require('crypto');
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({
    iss: serviceAccount.client_email,
    scope: 'https://www.googleapis.com/auth/analytics.readonly',
    aud: TOKEN_URI, iat: now, exp: now + 3600,
  }));
  const signingInput = `${header}.${payload}`;
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(signingInput);
  const sig = base64url(sign.sign(serviceAccount.private_key));
  const jwt = `${signingInput}.${sig}`;
  const res = await fetch(TOKEN_URI, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`Token error: ${JSON.stringify(data)}`);
  return data.access_token;
}

async function runReport(token, body, retries = 1) {
  const res = await fetch(`${GA4_API_BASE}/properties/${GA4_PROPERTY_ID}:runReport`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 429 && retries > 0) {
    await new Promise(r => setTimeout(r, 1500));
    return runReport(token, body, retries - 1);
  }
  if (!res.ok) { const err = await res.text(); throw new Error(`GA4 API error (${res.status}): ${err}`); }
  return res.json();
}

async function batchRunReports(token, bodies) {
  const res = await fetch(`${GA4_API_BASE}/properties/${GA4_PROPERTY_ID}:batchRunReports`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests: bodies }),
  });
  if (!res.ok) { const err = await res.text(); throw new Error(`GA4 batch API error (${res.status}): ${err}`); }
  return res.json();
}

function moduleFilter(module) {
  const mods = Array.isArray(module) ? module : [module];
  if (mods.length === 1) return { filter: { fieldName: 'customEvent:source_module', stringFilter: { value: mods[0] } } };
  return { orGroup: { expressions: mods.map(m => ({ filter: { fieldName: 'customEvent:source_module', stringFilter: { value: m } } })) } };
}

function clickFilter(module, screen) {
  const expressions = [{ filter: { fieldName: 'eventName', stringFilter: { value: 'click_event' } } }];
  if (module) {
    const mods = Array.isArray(module) ? module : [module];
    if (mods.length === 1) expressions.push({ filter: { fieldName: 'customEvent:source_module', stringFilter: { value: mods[0] } } });
    else expressions.push({ orGroup: { expressions: mods.map(m => ({ filter: { fieldName: 'customEvent:source_module', stringFilter: { value: m } } })) } });
  }
  if (screen) expressions.push({ filter: { fieldName: 'customEvent:source_screen', stringFilter: { value: screen } } });
  return expressions.length === 1 ? expressions[0] : { andGroup: { expressions } };
}

function buildReportBody(report, startDate, endDate) {
  const dateRange = [{ startDate, endDate }];
  const clickDims = [
    { name: 'customEvent:label' },
    { name: 'customEvent:value' },
    { name: 'customEvent:source_screen' },
    { name: 'customEvent:source_module' },
  ];

  const reports = {

    // ── Screen views ──────────────────────────────────────────────────
    screen_views: {
      dateRanges: dateRange,
      dimensions: [{ name: 'unifiedScreenName' }],
      metrics: [{ name: 'screenPageViews' }, { name: 'userEngagementDuration' }],
      dimensionFilter: {
        notExpression: { filter: { fieldName: 'unifiedScreenName', stringFilter: { value: '(not set)' } } }
      },
      orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
      limit: 50,
    },

    // ── Booking funnel with dept breakdown ────────────────────────────
    booking_funnel: {
      dateRanges: dateRange,
      dimensions: [
        { name: 'eventName' },
        { name: 'customEvent:source_module' },
      ],
      metrics: [{ name: 'eventCount' }],
      dimensionFilter: {
        orGroup: { expressions: [
          { filter: { fieldName: 'eventName', stringFilter: { value: 'booking_start' } } },
          { filter: { fieldName: 'eventName', stringFilter: { value: 'booking_complete' } } },
          { filter: { fieldName: 'eventName', stringFilter: { value: 'booking_abandoned' } } },
          { filter: { fieldName: 'eventName', stringFilter: { value: 'booking_view' } } },
        ]}
      },
      limit: 500,
    },

    // ── Abandonment by step — WHERE guests drop off ───────────────────
    abandon_by_step: {
      dateRanges: dateRange,
      dimensions: [
        { name: 'customEvent:source_module' },
        { name: 'customEvent:step' },
      ],
      metrics: [{ name: 'eventCount' }],
      dimensionFilter: {
        filter: { fieldName: 'eventName', stringFilter: { value: 'booking_abandoned' } }
      },
      orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
      limit: 200,
    },

    // ── Booking complete enriched — value, guests, time, category ─────
    booking_complete_detail: {
      dateRanges: dateRange,
      dimensions: [
        { name: 'customEvent:source_module' },
        { name: 'customEvent:category' },
        { name: 'customEvent:service' },
        { name: 'customEvent:guest_count' },
        { name: 'customEvent:time_taken' },
        { name: 'customEvent:total' },
      ],
      metrics: [{ name: 'eventCount' }],
      dimensionFilter: {
        filter: { fieldName: 'eventName', stringFilter: { value: 'booking_complete' } }
      },
      orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
      limit: 500,
    },

    // ── Revenue by dept (booking_complete total) ──────────────────────
    revenue_by_dept: {
      dateRanges: dateRange,
      dimensions: [
        { name: 'customEvent:source_module' },
        { name: 'customEvent:total' },
      ],
      metrics: [{ name: 'eventCount' }],
      dimensionFilter: {
        filter: { fieldName: 'eventName', stringFilter: { value: 'booking_complete' } }
      },
      orderBys: [{ dimension: { dimensionName: 'customEvent:source_module' } }],
      limit: 500,
    },

    // ── Top services booked ───────────────────────────────────────────
    top_services: {
      dateRanges: dateRange,
      dimensions: [
        { name: 'customEvent:source_module' },
        { name: 'customEvent:category' },
        { name: 'customEvent:service' },
      ],
      metrics: [{ name: 'eventCount' }],
      dimensionFilter: {
        filter: { fieldName: 'eventName', stringFilter: { value: 'booking_complete' } }
      },
      orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
      limit: 200,
    },

    // ── All click_events ──────────────────────────────────────────────
    click_events: {
      dateRanges: dateRange,
      dimensions: clickDims,
      metrics: [{ name: 'eventCount' }],
      dimensionFilter: { filter: { fieldName: 'eventName', stringFilter: { value: 'click_event' } } },
      orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
      limit: 500,
    },

    // ── Home ──────────────────────────────────────────────────────────
    home: {
      dateRanges: dateRange,
      dimensions: clickDims,
      metrics: [{ name: 'eventCount' }],
      dimensionFilter: clickFilter('home', null),
      orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
      limit: 100,
    },

    // ── IRD ───────────────────────────────────────────────────────────
    ird_menu: {
      dateRanges: dateRange,
      dimensions: clickDims,
      metrics: [{ name: 'eventCount' }],
      dimensionFilter: clickFilter('dining', null),
      orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
      limit: 200,
    },

    // ── Cart ──────────────────────────────────────────────────────────
    cart: {
      dateRanges: dateRange,
      dimensions: clickDims,
      metrics: [{ name: 'eventCount' }],
      dimensionFilter: clickFilter(null, 'cart'),
      orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
      limit: 100,
    },

    // ── Activity ──────────────────────────────────────────────────────
    activity: {
      dateRanges: dateRange,
      dimensions: clickDims,
      metrics: [{ name: 'eventCount' }],
      dimensionFilter: clickFilter('activity', null),
      orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
      limit: 100,
    },

    // ── SPA ───────────────────────────────────────────────────────────
    spa: {
      dateRanges: dateRange,
      dimensions: clickDims,
      metrics: [{ name: 'eventCount' }],
      dimensionFilter: {
        orGroup: { expressions: [
          { filter: { fieldName: 'customEvent:source_module', stringFilter: { value: 'spa' } } },
          { filter: { fieldName: 'customEvent:source_module', stringFilter: { value: 'bms_spa' } } },
        ]}
      },
      orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
      limit: 100,
    },

    // ── Restaurant ────────────────────────────────────────────────────
    restaurant: {
      dateRanges: dateRange,
      dimensions: clickDims,
      metrics: [{ name: 'eventCount' }],
      dimensionFilter: clickFilter('restaurant', null),
      orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
      limit: 100,
    },

    // ── Taxi ──────────────────────────────────────────────────────────
    taxi: {
      dateRanges: dateRange,
      dimensions: [
        { name: 'eventName' },
        { name: 'customEvent:label' },
        { name: 'customEvent:value' },
        { name: 'customEvent:vehicle' },
        { name: 'customEvent:step' },
      ],
      metrics: [{ name: 'eventCount' }],
      dimensionFilter: {
        orGroup: { expressions: [
          { filter: { fieldName: 'customEvent:source_module', stringFilter: { value: 'taxi' } } },
          { filter: { fieldName: 'eventName', stringFilter: { value: 'taxi_time_selected' } } },
          { filter: { fieldName: 'eventName', stringFilter: { value: 'taxi_vehicle_selected' } } },
        ]}
      },
      orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
      limit: 100,
    },

    // ── Housekeeping ──────────────────────────────────────────────────
    housekeeping: {
      dateRanges: dateRange,
      dimensions: [
        { name: 'eventName' },
        { name: 'customEvent:label' },
        { name: 'customEvent:value' },
        { name: 'customEvent:total' },
      ],
      metrics: [{ name: 'eventCount' }],
      dimensionFilter: {
        orGroup: { expressions: [
          { filter: { fieldName: 'customEvent:source_module', stringFilter: { value: 'housekeeping' } } },
          { filter: { fieldName: 'customEvent:source_module', stringFilter: { value: 'laundry' } } },
        ]}
      },
      orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
      limit: 100,
    },

    // ── Store ─────────────────────────────────────────────────────────
    store: {
      dateRanges: dateRange,
      dimensions: [
        { name: 'eventName' },
        { name: 'customEvent:label' },
        { name: 'customEvent:value' },
        { name: 'customEvent:total' },
        { name: 'customEvent:category' },
      ],
      metrics: [{ name: 'eventCount' }],
      dimensionFilter: {
        orGroup: { expressions: [
          { filter: { fieldName: 'customEvent:source_module', stringFilter: { value: 'store' } } },
          { filter: { fieldName: 'eventName', stringFilter: { value: 'store_item_added_to_cart' } } },
        ]}
      },
      orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
      limit: 100,
    },

    // ── Chat ──────────────────────────────────────────────────────────
    chat: {
      dateRanges: dateRange,
      dimensions: [
        { name: 'customEvent:label' },
        { name: 'customEvent:value' },
        { name: 'customEvent:index' },
      ],
      metrics: [{ name: 'eventCount' }],
      dimensionFilter: {
        andGroup: { expressions: [
          { filter: { fieldName: 'eventName', stringFilter: { value: 'click_event' } } },
          { filter: { fieldName: 'customEvent:source_screen', stringFilter: { value: 'chat' } } },
        ]}
      },
      orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
      limit: 100,
    },

    // ── Recommendations — impression + tap + add ──────────────────────
    recommendations: {
      dateRanges: dateRange,
      dimensions: [
        { name: 'eventName' },
        { name: 'customEvent:source_module' },
        { name: 'customEvent:value' },
        { name: 'customEvent:label' },
      ],
      metrics: [{ name: 'eventCount' }],
      dimensionFilter: {
        orGroup: { expressions: [
          { filter: { fieldName: 'eventName', stringFilter: { value: 'recommendation_impression' } } },
          { filter: { fieldName: 'eventName', stringFilter: { value: 'recommendation_added_to_cart' } } },
          { andGroup: { expressions: [
            { filter: { fieldName: 'eventName', stringFilter: { value: 'click_event' } } },
            { filter: { fieldName: 'customEvent:label', stringFilter: { value: 'add_suggested_item' } } },
          ]}},
        ]}
      },
      orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
      limit: 200,
    },

    // ── Notifications funnel ──────────────────────────────────────────
    notifications: {
      dateRanges: dateRange,
      dimensions: [{ name: 'eventName' }],
      metrics: [{ name: 'eventCount' }],
      dimensionFilter: {
        orGroup: { expressions: [
          { filter: { fieldName: 'eventName', stringFilter: { value: 'notification_receive' } } },
          { filter: { fieldName: 'eventName', stringFilter: { value: 'notification_open' } } },
          { filter: { fieldName: 'eventName', stringFilter: { value: 'notification_dismiss' } } },
          { filter: { fieldName: 'eventName', stringFilter: { value: 'notification_foreground' } } },
        ]}
      },
      limit: 20,
    },

    // ── App health ────────────────────────────────────────────────────
    app_health: {
      dateRanges: dateRange,
      dimensions: [{ name: 'eventName' }],
      metrics: [{ name: 'eventCount' }],
      dimensionFilter: {
        orGroup: { expressions: [
          { filter: { fieldName: 'eventName', stringFilter: { value: 'app_exception' } } },
          { filter: { fieldName: 'eventName', stringFilter: { value: 'app_remove' } } },
          { filter: { fieldName: 'eventName', stringFilter: { value: 'first_open' } } },
          { filter: { fieldName: 'eventName', stringFilter: { value: 'app_update' } } },
          { filter: { fieldName: 'eventName', stringFilter: { value: 'app_session_start' } } },
          { filter: { fieldName: 'eventName', stringFilter: { value: 'sustainability_tray_opened' } } },
          { filter: { fieldName: 'eventName', stringFilter: { value: 'sustainability_action_completed' } } },
        ]}
      },
      limit: 20,
    },

    // ── Spotlight taps ────────────────────────────────────────────────
    spotlight: {
      dateRanges: dateRange,
      dimensions: [
        { name: 'customEvent:label' },
        { name: 'customEvent:value' },
        { name: 'customEvent:index' },
      ],
      metrics: [{ name: 'eventCount' }],
      dimensionFilter: {
        andGroup: { expressions: [
          { filter: { fieldName: 'eventName', stringFilter: { value: 'click_event' } } },
          { filter: { fieldName: 'customEvent:label', stringFilter: { matchType: 'BEGINS_WITH', value: 'spotlight' } } },
        ]}
      },
      orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
      limit: 100,
    },

    // ── Daily trend ───────────────────────────────────────────────────
    daily_trend: {
      dateRanges: dateRange,
      dimensions: [{ name: 'date' }, { name: 'eventName' }],
      metrics: [{ name: 'eventCount' }],
      dimensionFilter: {
        orGroup: { expressions: [
          { filter: { fieldName: 'eventName', stringFilter: { value: 'booking_start' } } },
          { filter: { fieldName: 'eventName', stringFilter: { value: 'booking_complete' } } },
          { filter: { fieldName: 'eventName', stringFilter: { value: 'click_event' } } },
        ]}
      },
      orderBys: [{ dimension: { dimensionName: 'date' } }],
      limit: 500,
    },
  };

  if (!reports[report]) throw new Error(`Unknown report: ${report}`);
  return reports[report];
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  try {
    const keyRaw = process.env.GA4_SERVICE_ACCOUNT_KEY;
    if (!keyRaw) throw new Error('GA4_SERVICE_ACCOUNT_KEY env var not set');
    const serviceAccount = JSON.parse(keyRaw);
    const { report = 'screen_views', startDate = '30daysAgo', endDate = 'today', hotelId, hotelName, excludeTest = 'true', appVersion, reports: batchReports } = event.queryStringParameters || {};

    // Helper to apply shared filters to a report body
    function applyFilters(body) {
      if (hotelId) {
        const hf = { filter: { fieldName: 'customEvent:hotel_id', stringFilter: { value: hotelId } } };
        body.dimensionFilter = body.dimensionFilter ? { andGroup: { expressions: [body.dimensionFilter, hf] } } : hf;
      }
      if (hotelName) {
        const nf = { filter: { fieldName: 'customUser:property', stringFilter: { value: hotelName } } };
        body.dimensionFilter = body.dimensionFilter ? { andGroup: { expressions: [body.dimensionFilter, nf] } } : nf;
      }
      if (excludeTest === 'true') {
        const ef = { notExpression: { filter: { fieldName: 'customUser:environment', stringFilter: { value: 'development' } } } };
        body.dimensionFilter = body.dimensionFilter ? { andGroup: { expressions: [body.dimensionFilter, ef] } } : ef;
      }
      if (appVersion) {
        const vf = { filter: { fieldName: 'appVersion', stringFilter: { value: appVersion } } };
        body.dimensionFilter = body.dimensionFilter ? { andGroup: { expressions: [body.dimensionFilter, vf] } } : vf;
      }
      return body;
    }

    // ── BATCH MODE: multiple reports in one call ──
    if (batchReports) {
      const reportNames = batchReports.split(',').map(s => s.trim()).filter(Boolean);
      const cacheKey = `batch:${reportNames.join(',')}:${startDate}:${endDate}:${hotelId||''}:${hotelName||''}:${excludeTest}:${appVersion||''}`;
      if (_cache[cacheKey] && Date.now() - _cache[cacheKey].ts < CACHE_TTL) {
        return { statusCode: 200, headers, body: JSON.stringify(_cache[cacheKey].data) };
      }

      const token = await getAccessToken(serviceAccount);
      const result = {};
      let filterFailed = false;

      // GA4 batchRunReports supports max 5 per call
      for (let i = 0; i < reportNames.length; i += 5) {
        const chunk = reportNames.slice(i, i + 5);
        const bodies = chunk.map(r => applyFilters(buildReportBody(r, startDate, endDate)));

        try {
          const batchResult = await batchRunReports(token, bodies);
          chunk.forEach((name, idx) => {
            result[name] = batchResult.reports?.[idx] || { rows: [] };
          });
        } catch (batchErr) {
          // If user-scoped filter fails, retry chunk without those filters
          if (excludeTest === 'true' && (batchErr.message.includes('customUser:environment') || batchErr.message.includes('customUser:property'))) {
            filterFailed = true;
            const fallbackBodies = chunk.map(r => {
              const b = buildReportBody(r, startDate, endDate);
              if (appVersion) {
                const vf = { filter: { fieldName: 'appVersion', stringFilter: { value: appVersion } } };
                b.dimensionFilter = b.dimensionFilter ? { andGroup: { expressions: [b.dimensionFilter, vf] } } : vf;
              }
              return b;
            });
            const fallbackResult = await batchRunReports(token, fallbackBodies);
            chunk.forEach((name, idx) => {
              result[name] = fallbackResult.reports?.[idx] || { rows: [] };
            });
          } else {
            // Return partial results + error info
            chunk.forEach(name => { result[name] = { error: batchErr.message }; });
          }
        }

        // Small delay between batch chunks
        if (i + 5 < reportNames.length) await new Promise(r => setTimeout(r, 1000));
      }

      if (filterFailed) result._testFilterSkipped = true;
      _cache[cacheKey] = { data: result, ts: Date.now() };
      return { statusCode: 200, headers, body: JSON.stringify(result) };
    }

    // ── SINGLE REPORT MODE (original behavior) ──

    // ── SINGLE REPORT MODE (original behavior) ──

    // Check server-side cache first
    const cacheKey = `${report}:${startDate}:${endDate}:${hotelId||''}:${hotelName||''}:${excludeTest}:${appVersion||''}`;
    if (_cache[cacheKey] && Date.now() - _cache[cacheKey].ts < CACHE_TTL) {
      return { statusCode: 200, headers, body: JSON.stringify(_cache[cacheKey].data) };
    }

    const token = await getAccessToken(serviceAccount);
    let body = applyFilters(buildReportBody(report, startDate, endDate));

    let data;
    try {
      data = await runReport(token, body);
    } catch (reportErr) {
      // If excludeTest filter caused the error (dimension not registered yet), retry without it
      if (excludeTest === 'true' && (reportErr.message.includes('customUser:environment') || reportErr.message.includes('customUser:property'))) {
        console.warn('User-scoped dimension not available yet — retrying without filter');
        body = buildReportBody(report, startDate, endDate);
        // Only re-apply appVersion filter (skip user-scoped filters that caused the error)
        if (appVersion) {
          const vf = { filter: { fieldName: 'appVersion', stringFilter: { value: appVersion } } };
          body.dimensionFilter = body.dimensionFilter ? { andGroup: { expressions: [body.dimensionFilter, vf] } } : vf;
        }
        data = await runReport(token, body);
        data._testFilterSkipped = true;
      } else {
        throw reportErr;
      }
    }
    // Cache successful response
    _cache[cacheKey] = { data, ts: Date.now() };
    return { statusCode: 200, headers, body: JSON.stringify(data) };
  } catch (err) {
    console.error('GA4 function error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
