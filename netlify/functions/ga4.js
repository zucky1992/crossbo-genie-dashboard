/**
 * Netlify Function: ga4.js
 * Proxies GA4 Data API requests using server-side JWT signing.
 * The private key never leaves this function — it's read from env vars.
 *
 * Endpoint: GET /.netlify/functions/ga4?report=REPORT_NAME&startDate=30daysAgo&endDate=today
 */

const GA4_PROPERTY_ID = '503373961';
const GA4_API_BASE = 'https://analyticsdata.googleapis.com/v1beta';
const TOKEN_URI = 'https://oauth2.googleapis.com/token';

// ── JWT signing (no external dependencies — pure Node.js crypto) ──────────
function base64url(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

async function getAccessToken(serviceAccount) {
  const crypto = require('crypto');
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({
    iss: serviceAccount.client_email,
    scope: 'https://www.googleapis.com/auth/analytics.readonly',
    aud: TOKEN_URI,
    iat: now,
    exp: now + 3600,
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

// ── GA4 report runner ─────────────────────────────────────────────────────
async function runReport(token, body) {
  const res = await fetch(`${GA4_API_BASE}/properties/${GA4_PROPERTY_ID}:runReport`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GA4 API error: ${err}`);
  }
  return res.json();
}

// ── Report definitions ────────────────────────────────────────────────────
function buildReportBody(report, startDate, endDate) {
  const dateRange = [{ startDate, endDate }];

  const reports = {

    // ── Feature Usage: click_event breakdown by label ──────────────────
    click_events: {
      dateRanges: dateRange,
      dimensions: [
        { name: 'customEvent:label' },
        { name: 'customEvent:source_module' },
        { name: 'customEvent:source_screen' },
        { name: 'customEvent:type' },
      ],
      metrics: [{ name: 'eventCount' }],
      dimensionFilter: {
        filter: { fieldName: 'eventName', stringFilter: { value: 'click_event' } }
      },
      orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
      limit: 200,
    },

    // ── Booking funnel: start → complete ──────────────────────────────
    booking_funnel: {
      dateRanges: dateRange,
      dimensions: [
        { name: 'eventName' },
        { name: 'customEvent:source_module' },  // dept (dining, spa, etc.)
        { name: 'customEvent:value' },
      ],
      metrics: [{ name: 'eventCount' }],
      dimensionFilter: {
        orGroup: {
          expressions: [
            { filter: { fieldName: 'eventName', stringFilter: { value: 'booking_start' } } },
            { filter: { fieldName: 'eventName', stringFilter: { value: 'booking_complete' } } },
            { filter: { fieldName: 'eventName', stringFilter: { value: 'booking_abandoned' } } },
          ]
        }
      },
      limit: 500,
    },

    // ── IRD specific: menu interactions ───────────────────────────────
    ird_menu: {
      dateRanges: dateRange,
      dimensions: [{ name: 'customEvent:label' }, { name: 'customEvent:value' }],
      metrics: [{ name: 'eventCount' }],
      dimensionFilter: {
        andGroup: {
          expressions: [
            { filter: { fieldName: 'eventName', stringFilter: { value: 'click_event' } } },
            { filter: {
                fieldName: 'customEvent:label',
                stringFilter: { matchType: 'BEGINS_WITH', value: 'dining_' }
              }
            },
          ]
        }
      },
      orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
      limit: 100,
    },

    // ── Cart interactions ─────────────────────────────────────────────
    cart: {
      dateRanges: dateRange,
      dimensions: [{ name: 'customEvent:label' }, { name: 'customEvent:value' }],
      metrics: [{ name: 'eventCount' }],
      dimensionFilter: {
        andGroup: {
          expressions: [
            { filter: { fieldName: 'eventName', stringFilter: { value: 'click_event' } } },
            { filter: {
                fieldName: 'customEvent:source_screen',
                stringFilter: { value: 'cart' }
              }
            },
          ]
        }
      },
      orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
      limit: 100,
    },

    // ── Recommendations: add_suggested_item ───────────────────────────
    recommendations: {
      dateRanges: dateRange,
      dimensions: [
        { name: 'customEvent:label' },
        { name: 'customEvent:value' },
        { name: 'customEvent:source_module' },
      ],
      metrics: [{ name: 'eventCount' }],
      dimensionFilter: {
        andGroup: {
          expressions: [
            { filter: { fieldName: 'eventName', stringFilter: { value: 'click_event' } } },
            { filter: {
                fieldName: 'customEvent:label',
                stringFilter: { value: 'add_suggested_item' }
              }
            },
          ]
        }
      },
      limit: 200,
    },

    // ── Home screen engagement ─────────────────────────────────────────
    home: {
      dateRanges: dateRange,
      dimensions: [{ name: 'customEvent:label' }, { name: 'customEvent:value' }],
      metrics: [{ name: 'eventCount' }],
      dimensionFilter: {
        andGroup: {
          expressions: [
            { filter: { fieldName: 'eventName', stringFilter: { value: 'click_event' } } },
            { filter: {
                fieldName: 'customEvent:source_screen',
                stringFilter: { matchType: 'BEGINS_WITH', value: 'index' }
              }
            },
            { filter: {
                fieldName: 'customEvent:source_module',
                stringFilter: { value: 'home' }
              }
            },
          ]
        }
      },
      orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
      limit: 100,
    },

    // ── Spotlight & quick actions ─────────────────────────────────────
    spotlight: {
      dateRanges: dateRange,
      dimensions: [{ name: 'customEvent:label' }, { name: 'customEvent:value' }],
      metrics: [{ name: 'eventCount' }],
      dimensionFilter: {
        andGroup: {
          expressions: [
            { filter: { fieldName: 'eventName', stringFilter: { value: 'click_event' } } },
            { filter: {
                fieldName: 'customEvent:label',
                stringFilter: { matchType: 'BEGINS_WITH', value: 'spotlight' }
              }
            },
          ]
        }
      },
      orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
      limit: 100,
    },

    // ── Daily event counts (trend line) ───────────────────────────────
    daily_trend: {
      dateRanges: dateRange,
      dimensions: [{ name: 'date' }, { name: 'eventName' }],
      metrics: [{ name: 'eventCount' }],
      dimensionFilter: {
        orGroup: {
          expressions: [
            { filter: { fieldName: 'eventName', stringFilter: { value: 'booking_start' } } },
            { filter: { fieldName: 'eventName', stringFilter: { value: 'booking_complete' } } },
            { filter: { fieldName: 'eventName', stringFilter: { value: 'click_event' } } },
          ]
        }
      },
      orderBys: [{ dimension: { dimensionName: 'date' } }],
      limit: 500,
    },
  };

  if (!reports[report]) throw new Error(`Unknown report: ${report}`);
  return reports[report];
}

// ── Main handler ──────────────────────────────────────────────────────────
exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  try {
    const keyRaw = process.env.GA4_SERVICE_ACCOUNT_KEY;
    if (!keyRaw) throw new Error('GA4_SERVICE_ACCOUNT_KEY env var not set');

    const serviceAccount = JSON.parse(keyRaw);
    const { report = 'click_events', startDate = '30daysAgo', endDate = 'today' } = event.queryStringParameters || {};

    const token = await getAccessToken(serviceAccount);
    const body = buildReportBody(report, startDate, endDate);
    const data = await runReport(token, body);

    return { statusCode: 200, headers, body: JSON.stringify(data) };

  } catch (err) {
    console.error('GA4 function error:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
