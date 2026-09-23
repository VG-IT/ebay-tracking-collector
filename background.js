import { EbayOrderService, normalizeAccount } from './lib/api.js';
import { LOGIN_CHECK_URL, ORDER_URLS } from './lib/config.js';

const state = {
  running: false,
  stopRequested: false,
  phase: '',
  progress: '',
  tabId: null,
  detailTabId: null,
  openedTabIds: [],
  limitExceeded: false,
  session: {
    checked: false,
    loggedIn: false,
    checkedAt: null,
  },
  currentRun: null,
};

const MAX_RUN_LOGS = 3;
const AUTO_RUN_ALARM_PREFIX = 'ebay-tracking-auto-run-';
const AUTO_RUN_HOURS = [0, 12];
const PENDING_POLL_ALARM = 'ebay-tracking-pending-poll';
const DEFAULT_PENDING_POLL_HOURS = 2;

function nextLocalHour(hour) {
  const next = new Date();
  next.setHours(hour, 0, 0, 0);
  if (next.getTime() <= Date.now()) next.setDate(next.getDate() + 1);
  return next.getTime();
}

async function syncAutoRunAlarms() {
  const { autoRunEnabled = false } = await chrome.storage.sync.get({
    autoRunEnabled: false,
  });

  await Promise.all(
    AUTO_RUN_HOURS.map(async (hour) => {
      const name = `${AUTO_RUN_ALARM_PREFIX}${hour}`;
      await chrome.alarms.clear(name);
      if (autoRunEnabled) {
        await chrome.alarms.create(name, {
          when: nextLocalHour(hour),
        });
      }
    }),
  );
}

async function syncPendingPollAlarm() {
  const {
    pendingPollEnabled = false,
    pendingPollHours = DEFAULT_PENDING_POLL_HOURS,
  } = await chrome.storage.sync.get({
    pendingPollEnabled: false,
    pendingPollHours: DEFAULT_PENDING_POLL_HOURS,
  });

  await chrome.alarms.clear(PENDING_POLL_ALARM);
  if (!pendingPollEnabled) return;

  const hours = Math.max(1, Number(pendingPollHours) || DEFAULT_PENDING_POLL_HOURS);
  await chrome.alarms.create(PENDING_POLL_ALARM, {
    delayInMinutes: 1,
    periodInMinutes: hours * 60,
  });
}

async function syncAllAlarms() {
  await syncAutoRunAlarms();
  await syncPendingPollAlarm();
}

async function persistSession() {
  await chrome.storage.local.set({ session: { ...state.session } });
}

async function loadCachedSession() {
  try {
    const data = await chrome.storage.local.get({ session: null });
    if (data.session && typeof data.session === 'object') {
      state.session = {
        checked: !!data.session.checked,
        loggedIn: !!data.session.loggedIn,
        checkedAt: data.session.checkedAt || null,
      };
    }
  } catch (_) {
    /* ignore */
  }
}

async function markSession(loggedIn) {
  state.session = {
    checked: true,
    loggedIn: !!loggedIn,
    checkedAt: Date.now(),
  };
  await persistSession();
  broadcast('SESSION', { ...state.session });
}

async function ensureStillLoggedIn(tabId) {
  const info = await sendToTab(tabId, { action: 'isLoginPage' });
  if (info?.isLoginPage) {
    await markSession(false);
    throw new Error('LOGGED_OUT');
  }
}

function broadcast(type, payload) {
  chrome.runtime.sendMessage({ type, payload }).catch(() => {});
  // Also notify active eBay tabs so the floating trigger button stays in sync
  chrome.tabs.query({ url: ['*://*.ebay.com/*', '*://ebay.com/*'] }, (tabs) => {
    for (const tab of tabs || []) {
      if (tab.id == null) continue;
      chrome.tabs.sendMessage(tab.id, { type, payload }).catch(() => {});
    }
  });
}

function log(message) {
  console.log('[eBay Tracking Collector]', message);
  const line = {
    at: new Date().toISOString(),
    text: String(message),
  };
  if (state.currentRun) {
    state.currentRun.lines.push(line);
  }
  broadcast('LOG', message);
  broadcast('STATE', { ...state, lastLog: message });
}

function debug(...args) {
  console.log('[eBay Tracking Collector]', ...args);
}

function startRunLog({ email, days }) {
  state.currentRun = {
    id: `${Date.now()}`,
    startedAt: new Date().toISOString(),
    endedAt: null,
    email,
    days,
    status: 'running',
    lines: [],
  };
}

async function finishRunLog(status, result = null) {
  if (!state.currentRun) return;
  state.currentRun.endedAt = new Date().toISOString();
  state.currentRun.status = status;
  if (result != null) state.currentRun.result = result;

  const finished = { ...state.currentRun };
  state.currentRun = null;

  const data = await chrome.storage.local.get({ runLogs: [] });
  const runLogs = Array.isArray(data.runLogs) ? data.runLogs : [];
  runLogs.unshift(finished);
  await chrome.storage.local.set({ runLogs: runLogs.slice(0, MAX_RUN_LOGS) });
  broadcast('RUN_LOGS_UPDATED', { count: Math.min(runLogs.length, MAX_RUN_LOGS) });
}

async function getRunLogs() {
  const data = await chrome.storage.local.get({ runLogs: [] });
  return Array.isArray(data.runLogs) ? data.runLogs.slice(0, MAX_RUN_LOGS) : [];
}

async function clearRunLogs() {
  await chrome.storage.local.set({ runLogs: [] });
  broadcast('RUN_LOGS_UPDATED', { count: 0 });
}

function trackOpenedTab(tabId) {
  if (tabId == null) return;
  if (!state.openedTabIds.includes(tabId)) {
    state.openedTabIds.push(tabId);
  }
}

function setPhase(phase, progress = '') {
  state.phase = phase;
  state.progress = progress;
  broadcast('STATE', { ...state });
}

function ensureNotStopped() {
  if (state.stopRequested) {
    throw new Error('Stopped by user');
  }
}

async function sleep(ms, { ignoreStop = false } = {}) {
  if (!ignoreStop) ensureNotStopped();
  await new Promise((resolve) => setTimeout(resolve, ms));
  if (!ignoreStop) ensureNotStopped();
}

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { action: 'ping' });
    return;
  } catch (_) {
    /* inject */
  }
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content/collector.js'],
  });
  await sleep(300, { ignoreStop: true });
}

async function sendToTab(tabId, message, retries = 3, { ignoreStop = false } = {}) {
  let lastError;
  for (let i = 0; i < retries; i++) {
    if (!ignoreStop) ensureNotStopped();
    try {
      await ensureContentScript(tabId);
      const response = await chrome.tabs.sendMessage(tabId, message);
      if (response?.ok === false) {
        throw new Error(response.error || 'Content script error');
      }
      return response;
    } catch (err) {
      lastError = err;
      await sleep(700, { ignoreStop });
    }
  }
  throw lastError || new Error('Failed to message content script');
}

async function openOrReuseTab(url, { ignoreStop = false, active = true } = {}) {
  if (!ignoreStop) ensureNotStopped();

  if (state.tabId != null) {
    try {
      await chrome.tabs.get(state.tabId);
      await chrome.tabs.update(state.tabId, { url, active });
      await waitForTabComplete(state.tabId);
      trackOpenedTab(state.tabId);
      return state.tabId;
    } catch (_) {
      state.tabId = null;
    }
  }

  // Reuse a leftover purchase/order tab from a previous run if still open.
  try {
    const existing = await chrome.tabs.query({
      url: ['*://*.ebay.com/*', '*://ebay.com/*', '*://order.ebay.com/*'],
    });
    const reusable = existing.find(
      (tab) =>
        tab.id != null &&
        /\/mye\/myebay\/purchase|order\.ebay\.com\/ord\/show/i.test(tab.url || ''),
    );
    if (reusable?.id != null) {
      state.tabId = reusable.id;
      await chrome.tabs.update(state.tabId, { url, active });
      await waitForTabComplete(state.tabId);
      trackOpenedTab(state.tabId);
      return state.tabId;
    }
  } catch (_) {
    /* ignore */
  }

  const tab = await chrome.tabs.create({ url, active });
  state.tabId = tab.id;
  trackOpenedTab(tab.id);
  await waitForTabComplete(tab.id);
  return tab.id;
}

async function closeTabQuietly(tabId) {
  if (tabId == null) return;
  try {
    await chrome.tabs.remove(tabId);
  } catch (_) {
    /* already closed */
  }
  state.openedTabIds = state.openedTabIds.filter((id) => id !== tabId);
  if (state.tabId === tabId) state.tabId = null;
  if (state.detailTabId === tabId) state.detailTabId = null;
}

async function openFreshDetailTab(url) {
  const tab = await chrome.tabs.create({ url, active: true });
  trackOpenedTab(tab.id);
  await waitForTabComplete(tab.id);
  return tab.id;
}

async function closeCollectorTabs() {
  const ids = [...new Set(state.openedTabIds.filter((id) => id != null))];
  if (state.tabId != null && !ids.includes(state.tabId)) {
    ids.push(state.tabId);
  }
  if (state.detailTabId != null && !ids.includes(state.detailTabId)) {
    ids.push(state.detailTabId);
  }
  state.tabId = null;
  state.detailTabId = null;
  state.openedTabIds = [];

  if (!ids.length) {
    debug('No collector tabs to close');
    return;
  }

  try {
    await chrome.tabs.remove(ids);
    log(`Closed ${ids.length} opened tab(s): ${ids.join(', ')}`);
  } catch (err) {
    let closed = 0;
    for (const tabId of ids) {
      try {
        await chrome.tabs.remove(tabId);
        closed += 1;
      } catch (_) {
        /* already closed */
      }
    }
    log(`Closed ${closed}/${ids.length} opened tab(s)`);
    debug('closeCollectorTabs partial failure', err?.message || err);
  }
}

async function checkEbaySession({ openLogin = false } = {}) {
  // Background tab: open purchase URL, check login, then close.
  let tabId = null;
  try {
    const tab = await chrome.tabs.create({ url: LOGIN_CHECK_URL, active: false });
    tabId = tab.id;
    await waitForTabComplete(tabId);
    await sleep(1500, { ignoreStop: true });

    const info = await sendToTab(tabId, { action: 'isLoginPage' }, 3, { ignoreStop: true });
    const loggedIn = !info?.isLoginPage;
    await markSession(loggedIn);

    if (!loggedIn && openLogin) {
      await chrome.tabs.create({ url: 'https://www.ebay.com/signin/', active: true });
    }

    return { ...state.session };
  } finally {
    if (tabId != null) {
      try {
        await chrome.tabs.remove(tabId);
      } catch (_) {
        /* ignore */
      }
    }
  }
}

function waitForTabComplete(tabId, timeout = 60000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();

    const finish = (ok, err) => {
      chrome.tabs.onUpdated.removeListener(listener);
      clearInterval(poll);
      if (ok) resolve();
      else reject(err || new Error('Tab load timeout'));
    };

    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') finish(true);
    };
    chrome.tabs.onUpdated.addListener(listener);

    const poll = setInterval(async () => {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.status === 'complete') finish(true);
        else if (Date.now() - started > timeout) finish(false);
      } catch (err) {
        finish(false, err);
      }
    }, 400);
  });
}

async function collectOrders(service, email, days, ordersUrl, maxPages = null) {
  const earliest = Date.now() - days * 24 * 60 * 60 * 1000;
  const tabId = await openOrReuseTab(ordersUrl);
  await sleep(2000);
  await ensureStillLoggedIn(tabId);

  let page = 1;
  while (true) {
    ensureNotStopped();
    setPhase('Collecting orders', `page ${page}`);
    await ensureStillLoggedIn(tabId);

    const { orders } = await sendToTab(tabId, {
      action: 'scrapeOrders',
      buyerEmail: email,
    });
    debug('collectOrders page result', { page, url: ordersUrl, orders });

    if (!orders?.length) {
      await ensureStillLoggedIn(tabId);
      log(`No orders found on page ${page}`);
      break;
    }

    orders.forEach((order) => {
      order.buyer_email = email;
    });
    log(`Found ${orders.length} orders on page ${page}`);
    try {
      const resp = await service.saveOrders(orders);
      debug('saveOrders response', resp);
      log(`Orders report succeeded: ${orders.length} item(s)`);
      log(`Report response: ${JSON.stringify(resp)}`);
    } catch (err) {
      console.error('[eBay Tracking Collector] saveOrders failed', err);
      log(`Orders report failed: ${err.message}`);
    }

    if (maxPages && page >= maxPages) break;

    if (!maxPages) {
      const reached = orders.some((order) => {
        if (!order.purchase_date) return false;
        return new Date(order.purchase_date).getTime() < earliest;
      });
      if (reached) {
        log('Reached earliest order date');
        break;
      }
    }

    const next = await sendToTab(tabId, { action: 'goNextPage' });
    if (!next?.hasNext) break;
    await sleep(2000);
    await ensureStillLoggedIn(tabId);
    page += 1;
  }
}

async function getOrderDetail(orderNumber) {
  const url = `https://order.ebay.com/ord/show?orderId=${encodeURIComponent(orderNumber)}#/`;
  const detailTabId = await openFreshDetailTab(url);
  await sleep(800 + Math.floor(Math.random() * 700));

  try {
    await ensureStillLoggedIn(detailTabId);

    let detail = await sendToTab(detailTabId, { action: 'scrapeOrderDetail' });
    debug('order detail scraped', { orderNumber, detail });

    if (detail?.ok !== false && !detail?.limitExceeded && !detail?.tracking && detail?.ready) {
      log(`Retry scrape order detail: ${orderNumber}`);
      await sleep(1500);
      detail = await sendToTab(detailTabId, { action: 'scrapeOrderDetail' });
      debug('order detail scraped (retry)', { orderNumber, detail });
    }

    if (detail?.ok === false) {
      log(`Order detail scrape error: ${orderNumber}: ${detail.error || 'unknown'}`);
      return null;
    }
    if (detail?.limitExceeded) {
      state.limitExceeded = true;
      log('Order detail daily limit exceeded');
      return null;
    }

    const payload = { order_number: orderNumber };
    if (detail?.status) payload.status = detail.status;
    if (detail?.tracking) payload.tracking = detail.tracking;
    if (detail?.carrier) payload.carrier = detail.carrier;
    if (detail?.address) payload.address = detail.address;
    if (detail?.credit_card_last_digits) {
      payload.credit_card_last_digits = detail.credit_card_last_digits;
    }
    if (detail?.delivered_date) payload.delivered_date = detail.delivered_date;
    if (detail?.purchase_date) payload.purchase_date = detail.purchase_date;

    if (!payload.tracking && !payload.status) {
      log(
        `No status/tracking extracted: ${orderNumber}` +
          ` (ready=${!!detail?.ready}, hasTrackingUi=${!!detail?.hasTrackingUi})`,
      );
    }
    return payload;
  } finally {
    await closeTabQuietly(detailTabId);
  }
}

async function collectLookbackOrderStatuses(service, email, lookbackPages) {
  log(`Collecting lookback order-list status for ${email}`);
  await collectOrders(service, email, lookbackPages, ORDER_URLS.all);
  await collectOrders(service, email, lookbackPages, ORDER_URLS.payment_failed, 3);
  await collectOrders(service, email, lookbackPages, ORDER_URLS.returns_and_canceled, 3);
}

async function collectTrackingsFromShippedLookback(service, email, lookbackPages) {
  const maxPages = Math.max(1, Number(lookbackPages) || 3);
  setPhase('Collecting shipped-list tracking', `up to ${maxPages} page(s)`);
  log(`Shipped lookback tracking: scan ${maxPages} page(s), query em-data, collect missing tracking`);

  const tabId = await openOrReuseTab(ORDER_URLS.shipped);
  await sleep(2000);
  await ensureStillLoggedIn(tabId);

  const reportSuccess = [];
  const reportFailed = [];
  const collected = [];

  async function reportTrackingBatch(batch, source) {
    if (!batch.length) return;
    const withBuyer = batch.map((item) => ({ ...item, buyer_email: email }));
    for (const item of withBuyer) {
      collected.push(item);
      log(
        `Collected tracking[${source}]: order=${item.order_number}, tracking=${item.tracking}` +
          (item.carrier ? `, carrier=${item.carrier}` : ''),
      );
    }
    try {
      const resp = await service.saveOrders(withBuyer);
      reportSuccess.push(...batch.map((item) => item.order_number));
      log(`Tracking report succeeded[${source}]: ${batch.length} item(s)`);
      log(`Report response: ${JSON.stringify(resp)}`);
    } catch (err) {
      console.error('[eBay Tracking Collector] save trackings failed', err);
      reportFailed.push(...batch.map((item) => item.order_number));
      log(`Tracking report failed[${source}]: ${err.message}`);
    }
  }

  let page = 1;
  while (page <= maxPages) {
    ensureNotStopped();
    setPhase('Collecting shipped-list tracking', `page ${page}/${maxPages}`);
    await ensureStillLoggedIn(tabId);

    const { orders } = await sendToTab(tabId, {
      action: 'scrapeOrders',
      buyerEmail: email,
    });
    const pageNumbers = (orders || []).map((order) => order.order_number).filter(Boolean);
    log(`Shipped page ${page}: ${pageNumbers.length} order(s)`);

    let missing = [];
    if (pageNumbers.length) {
      try {
        missing = await service.ordersMissingTracking(email, pageNumbers);
      } catch (err) {
        log(`em-data tracking lookup failed: ${err.message}`);
        missing = pageNumbers;
      }
    }
    log(`Missing tracking on page ${page}: ${missing.length} (${missing.join(', ') || 'none'})`);

    if (missing.length && !state.limitExceeded) {
      const result = await sendToTab(tabId, {
        action: 'scrapeTrackings',
        orderNumbers: missing,
      });
      const batch = [];
      const found = new Set();
      for (const tracking of result.trackings || []) {
        if (!missing.includes(tracking.order_number) || !tracking.tracking) continue;
        batch.push(tracking);
        found.add(tracking.order_number);
      }
      await reportTrackingBatch(batch, `shipped-page-${page}`);

      const needDetail = missing.filter((number) => !found.has(number));
      for (const orderNumber of needDetail) {
        ensureNotStopped();
        if (state.limitExceeded) {
          log('Order detail daily limit exceeded, stop opening order details');
          break;
        }
        setPhase('Open order detail', orderNumber);
        log(`Open order detail for missing tracking: ${orderNumber}`);
        const detail = await getOrderDetail(orderNumber);
        if (detail?.tracking) {
          await reportTrackingBatch([detail], `order-detail-${orderNumber}`);
        }
        await sleep(1000);
      }
    }

    if (page >= maxPages) break;
    const next = await sendToTab(tabId, { action: 'goNextPage' });
    if (!next?.hasNext) {
      log('No next shipped page');
      break;
    }
    await sleep(2000);
    await ensureStillLoggedIn(tabId);
    page += 1;
  }

  log('========== Shipped tracking summary ==========');
  log(`Collected: ${collected.length}`);
  log(`Report succeeded: ${reportSuccess.length}`);
  log(`Report failed: ${reportFailed.length}`);
  log('================================================');
}

async function collectPendingFromDetails(service, email) {
  setPhase('Loading pending requests');
  let pending = [];
  try {
    pending = await service.getPendingCollectionOrders(email);
  } catch (err) {
    log(`Failed to load pending requests: ${err.message}`);
    return;
  }

  const byNumber = new Map();
  for (const req of pending || []) {
    const orderNumber = req.order_number || req.buy_order_number;
    if (!orderNumber) continue;
    if (!byNumber.has(orderNumber)) byNumber.set(orderNumber, new Set());
    byNumber.get(orderNumber).add(req.request_type || 'order_status');
  }

  if (!byNumber.size) {
    log('No pending collection requests');
    return { empty: true };
  }

  log(`Pending requests: ${pending.length} (${byNumber.size} unique order(s))`);
  log(`Pending order numbers: ${Array.from(byNumber.keys()).join(', ')}`);

  for (const [orderNumber, types] of byNumber.entries()) {
    ensureNotStopped();
    if (state.limitExceeded) {
      log('Order detail daily limit exceeded, stop pending details');
      break;
    }

    setPhase('Pending order detail', orderNumber);
    log(`Open pending detail ${orderNumber} types=${Array.from(types).join(',')}`);
    const detail = await getOrderDetail(orderNumber);
    if (!detail) {
      await sleep(1000);
      continue;
    }

    const payload = { ...detail, buyer_email: email };
    try {
      const resp = await service.saveOrders([payload]);
      log(`Pending detail report succeeded: ${orderNumber} ${JSON.stringify(resp)}`);
    } catch (err) {
      log(`Pending detail report failed: ${orderNumber}: ${err.message}`);
    }
    await sleep(1000);
  }

  return { empty: false };
}

async function runCollector({ email, days, mode = 'full' } = {}) {
  if (state.running) return { error: 'Already running' };

  await loadCachedSession();

  const settings = await chrome.storage.sync.get({ email: '', days: 3 });
  const localSettings = await chrome.storage.local.get({ token: '' });
  const buyerEmail = normalizeAccount(email || settings.email || '');
  const apiToken = (localSettings.token || '').trim();
  const lookbackPages = Number(days || settings.days) || 3;
  const pendingOnly = mode === 'pending';

  if (!buyerEmail) {
    return { error: 'Please save a buyer email in extension settings first' };
  }
  if (!apiToken) {
    return { error: 'Please save an Everymarket Token in extension settings first' };
  }
  if (!state.session.checked || !state.session.loggedIn) {
    return { error: 'Please click Check Login and confirm you are logged in first' };
  }

  state.running = true;
  state.stopRequested = false;
  state.limitExceeded = false;
  state.openedTabIds = [];
  state.detailTabId = null;
  setPhase('Starting');
  startRunLog({ email: buyerEmail, days: lookbackPages });

  try {
    const service = new EbayOrderService(apiToken);
    log(`Collector started for ${buyerEmail}, mode=${pendingOnly ? 'request' : 'full'}, lookbackPages=${lookbackPages}`);
    await collectLookbackOrderStatuses(service, buyerEmail, lookbackPages);

    if (pendingOnly) {
      const pendingResult = await collectPendingFromDetails(service, buyerEmail);
      if (pendingResult?.empty) {
        setPhase('Done', 'no pending');
        log('No pending requests after lookback status collection');
        await service.sendClickLog(buyerEmail);
        await finishRunLog('completed', { ok: true, pendingOnly: true, empty: true });
        return { ok: true, email: buyerEmail, empty: true };
      }
    } else {
      await collectTrackingsFromShippedLookback(service, buyerEmail, lookbackPages);
    }

    await service.sendClickLog(buyerEmail);

    setPhase('Done', 'completed');
    log('Collector finished');
    await finishRunLog('completed', { ok: true, pendingOnly });
    return { ok: true, email: buyerEmail };
  } catch (err) {
    if (String(err.message) === 'LOGGED_OUT') {
      setPhase('Logged out');
      log('Logged out while collecting orders/tracking. Please Check Login again.');
      await finishRunLog('logged_out', { error: 'logged_out' });
      return { error: 'Logged out. Please check login again.' };
    }
    if (String(err.message).includes('Stopped')) {
      setPhase('Stopped');
      log('Collector stopped');
      await finishRunLog('stopped', { stopped: true });
      return { ok: false, stopped: true };
    }
    setPhase('Error');
    log(`Fatal: ${err.message}`);
    await finishRunLog('error', { error: err.message });
    return { error: err.message };
  } finally {
    if (state.currentRun) {
      await finishRunLog('interrupted');
    }
    await closeCollectorTabs();
    state.running = false;
    state.stopRequested = false;
    broadcast('STATE', { ...state });
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'START') {
    runCollector({ ...(message.payload || {}), mode: 'full' }).then((result) =>
      sendResponse(result || { ok: true }),
    );
    return true;
  }
  if (message?.type === 'START_PENDING') {
    runCollector({ ...(message.payload || {}), mode: 'pending' }).then((result) =>
      sendResponse(result || { ok: true }),
    );
    return true;
  }
  if (message?.type === 'STOP') {
    state.stopRequested = true;
    log('Stop requested…');
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type === 'GET_STATE') {
    loadCachedSession().then(() => sendResponse({ ...state }));
    return true;
  }
  if (message?.type === 'CHECK_SESSION') {
    checkEbaySession(message.payload || {})
      .then((session) => sendResponse({ ok: true, session }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (message?.type === 'GET_RUN_LOGS') {
    getRunLogs()
      .then((runLogs) => sendResponse({ ok: true, runLogs }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (message?.type === 'CLEAR_RUN_LOGS') {
    clearRunLogs()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (message?.type === 'OPEN_LOGIN') {
    chrome.tabs
      .create({ url: 'https://www.ebay.com/signin/', active: true })
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  return false;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === PENDING_POLL_ALARM) {
    void (async () => {
      const { pendingPollEnabled = false } = await chrome.storage.sync.get({
        pendingPollEnabled: false,
      });
      if (!pendingPollEnabled) return;
      log('Scheduled pending-poll alarm fired');
      await runCollector({ mode: 'pending' });
    })();
    return;
  }

  if (!alarm.name.startsWith(AUTO_RUN_ALARM_PREFIX)) return;

  void (async () => {
    const hour = Number(alarm.name.slice(AUTO_RUN_ALARM_PREFIX.length));
    const { autoRunEnabled = false } = await chrome.storage.sync.get({
      autoRunEnabled: false,
    });
    if (!autoRunEnabled || !AUTO_RUN_HOURS.includes(hour)) return;

    // One-shot alarms are recreated so they stay at local 00:00/12:00 across DST.
    await chrome.alarms.create(alarm.name, { when: nextLocalHour(hour) });
    log('Scheduled full auto-run alarm fired');
    await runCollector({ mode: 'full' });
  })();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'sync') return;
  if (changes.autoRunEnabled) void syncAutoRunAlarms();
  if (changes.pendingPollEnabled || changes.pendingPollHours) void syncPendingPollAlarm();
});

chrome.runtime.onInstalled.addListener(() => {
  void syncAllAlarms();
});

chrome.runtime.onStartup.addListener(() => {
  void syncAllAlarms();
});

void loadCachedSession();
void syncAllAlarms();
