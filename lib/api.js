const ENDPOINT = 'https://fulfill.everymarket.com';
const LOG_ENDPOINT = 'https://logging.everymarket.com/api/v1/logs';
const LOG_API_TOKEN =
  '7dfbd1c8a4e2453d9b2b569f37ce8b1c3c09e89157b7268cc60b6a4e35a68c51';

export function normalizeAccount(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized || '';
}

function maskTokenInUrl(url) {
  try {
    const u = new URL(url);
    if (u.searchParams.has('token')) {
      u.searchParams.set('token', '***');
    }
    return u.toString();
  } catch (_) {
    return String(url).replace(/([?&]token=)[^&]*/gi, '$1***');
  }
}

async function sendRemoteLog(log) {
  try {
    await fetch(LOG_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Log-Source': 'frontend',
        Authorization: `Bearer ${LOG_API_TOKEN}`,
      },
      body: JSON.stringify({
        ...log,
        logged_at: new Date().toISOString(),
      }),
    });
  } catch (err) {
    console.warn('[eBay Tracking Collector] sendRemoteLog failed', err);
  }
}

export class EbayOrderService {
  constructor(token) {
    this.token = token;
  }

  async getOrdersByNumbers(account, orderNumbers) {
    const numbers = Array.from(
      new Set((orderNumbers || []).map((n) => String(n || '').trim()).filter(Boolean)),
    );
    if (!numbers.length) return [];

    const email = normalizeAccount(account);
    const collected = [];
    for (let i = 0; i < numbers.length; i += 40) {
      const slice = numbers.slice(i, i + 40);
      const url = new URL(`${ENDPOINT}/api/v2/ebay_orders`);
      url.searchParams.set('token', this.token);
      url.searchParams.set('email', email);
      url.searchParams.set('order_number', slice.join(','));

      const response = await fetch(url.toString(), {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!response.ok) {
        throw new Error(`getOrdersByNumbers failed: ${response.status}`);
      }
      const body = await response.json();
      if (Array.isArray(body)) collected.push(...body);
    }
    return collected;
  }

  async ordersMissingTracking(account, orderNumbers) {
    const numbers = Array.from(
      new Set((orderNumbers || []).map((n) => String(n || '').trim()).filter(Boolean)),
    );
    if (!numbers.length) return [];

    const existing = await this.getOrdersByNumbers(account, numbers);
    const hasTracking = new Set(
      (existing || [])
        .filter((order) => String(order?.tracking || '').trim())
        .map((order) => String(order.order_number || '').trim())
        .filter(Boolean),
    );
    return numbers.filter((number) => !hasTracking.has(number));
  }

  async getPendingCollectionOrders(account, requestType = null) {
    const url = new URL(`${ENDPOINT}/api/v2/order_collection_requests`);
    url.searchParams.set('token', this.token);
    url.searchParams.set('account', normalizeAccount(account));
    url.searchParams.set('marketplace', 'ebay');
    url.searchParams.set('status', 'pending');
    if (requestType) url.searchParams.set('request_type', requestType);

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });
    if (!response.ok) {
      throw new Error(`getPendingCollectionOrders failed: ${response.status}`);
    }
    const body = await response.json();
    return Array.isArray(body) ? body : [];
  }

  async saveOrders(orders) {
    const url = `${ENDPOINT}/api/v2/ebay_orders/batch_create?token=${encodeURIComponent(this.token)}`;
    const payload = { ebay_orders: orders };
    const orderCount = orders?.length || 0;

    console.log('[eBay Tracking Collector] API saveOrders request', {
      method: 'POST',
      url: maskTokenInUrl(url),
      count: orderCount,
      payload,
    });

    let ok = false;
    let body = null;
    let status = 0;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      status = response.status;
      const text = await response.text();
      try {
        body = text ? JSON.parse(text) : null;
      } catch (_) {
        body = text;
      }
      ok = response.ok;

      console.log('[eBay Tracking Collector] API saveOrders response', {
        status: response.status,
        ok: response.ok,
        body,
      });
    } catch (err) {
      console.error('[eBay Tracking Collector] saveOrders network error', err);
      await sendRemoteLog({
        source: 'ebay-order',
        level: 'error',
        message: 'Sync failed',
        metadata: {
          order_count: orderCount,
          result: { ok: false, error: String(err?.message || err) },
        },
      });
      throw err;
    }

    await sendRemoteLog({
      source: 'ebay-order',
      level: ok ? 'info' : 'error',
      message: ok ? 'Synced orders' : 'Sync failed',
      metadata: {
        order_count: orderCount,
        result: ok
          ? { ok: true, data: body }
          : { ok: false, status, error: `HTTP ${status}` },
      },
    });

    if (!ok) {
      throw new Error(`saveOrders failed: ${status}`);
    }
    return body;
  }

  async sendClickLog(email) {
    if (!email) return;
    try {
      const url = `${ENDPOINT}/api/v2/plugin_click_logs?token=${encodeURIComponent(this.token)}`;
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: normalizeAccount(email) }),
      });
    } catch (err) {
      console.warn('[eBay Tracking Collector] sendClickLog failed', err);
    }
  }
}
