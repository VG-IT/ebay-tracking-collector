import { EbayOrderService } from './lib/api.js';
import { LOGIN_CHECK_URL, ORDER_URLS } from './lib/config.js';

const state = {
  running: false,
  stopRequested: false,
  phase: '',
  progress: '',
  tabId: null,
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

async function openOrReuseTab(url, { ignoreStop = false } = {}) {
  if (!ignoreStop) ensureNotStopped();
  if (state.tabId != null) {
    try {
      await chrome.tabs.update(state.tabId, { url, active: true });
      await waitForTabComplete(state.tabId);
      trackOpenedTab(state.tabId);
      return state.tabId;
    } catch (_) {
      state.tabId = null;
    }
  }
  const tab = await chrome.tabs.create({ url, active: true });
  state.tabId = tab.id;
  trackOpenedTab(tab.id);
  await waitForTabComplete(tab.id);
  return tab.id;
}

async function closeCollectorTabs() {
  const ids = [...new Set(state.openedTabIds.filter((id) => id != null))];
  if (state.tabId != null && !ids.includes(state.tabId)) {
    ids.push(state.tabId);
  }
  state.tabId = null;
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

async function getTrackingFromOrderPage(orderNumber) {
  const url = `https://order.ebay.com/ord/show?orderId=${encodeURIComponent(orderNumber)}#/`;
  const detailTab = await chrome.tabs.create({ url, active: true });
  trackOpenedTab(detailTab.id);
  try {
    await waitForTabComplete(detailTab.id);
    await sleep(1500 + Math.floor(Math.random() * 1500));
    await ensureStillLoggedIn(detailTab.id);
    const detail = await sendToTab(detailTab.id, { action: 'scrapeOrderDetail' });
    debug('order detail scraped', { orderNumber, detail });
    if (detail?.limitExceeded) {
      state.limitExceeded = true;
      log('Order detail daily limit exceeded');
      return null;
    }
    if (!detail?.tracking) return null;

    const payload = {
      order_number: orderNumber,
      tracking: detail.tracking,
    };
    if (detail.carrier) payload.carrier = detail.carrier;
    if (detail.address) payload.address = detail.address;
    if (detail.credit_card_last_digits) {
      payload.credit_card_last_digits = detail.credit_card_last_digits;
    }
    if (detail.delivered_date) payload.delivered_date = detail.delivered_date;
    if (detail.purchase_date) payload.purchase_date = detail.purchase_date;
    debug('order detail tracking payload', payload);
    return payload;
  } finally {
    // Keep tab tracked; all opened tabs are closed together after the run.
    if (state.tabId != null) {
      try {
        await chrome.tabs.update(state.tabId, { active: true });
      } catch (_) {
        /* ignore */
      }
    }
  }
}

async function collectOrderTrackings(service, email, lookbackPages) {
  const maxPages = Math.max(1, Number(lookbackPages) || 3);
  setPhase('Loading no-tracking orders');
  let noTrackingOrders = await service.getOrders(email);
  debug('no-tracking orders from API', noTrackingOrders);
  if (!noTrackingOrders?.length) {
    log('Pending tracking orders: 0');
    log('No orders missing tracking');
    return;
  }

  const pendingTotal = noTrackingOrders.length;
  const pendingNumbers = noTrackingOrders
    .map((order) => order.order_number)
    .filter(Boolean);
  log(`Pending tracking orders: ${pendingTotal}`);
  log(`Pending order numbers: ${pendingNumbers.join(', ')}`);
  log(`Scan at most ${maxPages} lookback page(s); open order detail for the rest`);

  const byNumber = new Map(
    noTrackingOrders.map((order) => [order.order_number, order])
  );
  const collected = [];
  const reportSuccess = [];
  const reportFailed = [];

  async function reportTrackingBatch(batch, source) {
    if (!batch.length) return;
    for (const item of batch) {
      collected.push(item);
      byNumber.delete(item.order_number);
      log(
        `Collected tracking[${source}]: order=${item.order_number}, tracking=${item.tracking}` +
          (item.carrier ? `, carrier=${item.carrier}` : '')
      );
    }
    debug('saving tracking batch', { source, batch });
    try {
      const resp = await service.saveOrders(batch);
      debug('save trackings response', resp);
      reportSuccess.push(...batch.map((item) => item.order_number));
      log(`Tracking report succeeded[${source}]: ${batch.length} item(s)`);
      log(`Report response: ${JSON.stringify(resp)}`);
    } catch (err) {
      console.error('[eBay Tracking Collector] save trackings failed', err);
      reportFailed.push(...batch.map((item) => item.order_number));
      log(`Tracking report failed[${source}]: ${err.message}`);
      log(`Failed order numbers: ${batch.map((item) => item.order_number).join(', ')}`);
    }
  }

  async function collectFromPageResult(result, source) {
    const batch = [];
    for (const tracking of result.trackings || []) {
      if (!byNumber.has(tracking.order_number)) continue;
      batch.push(tracking);
    }

    for (const orderNumber of result.needsOrderPage || []) {
      if (!byNumber.has(orderNumber)) continue;
      if (state.limitExceeded) continue;
      log(`Opening order detail for ${orderNumber}`);
      const detailTracking = await getTrackingFromOrderPage(orderNumber);
      if (detailTracking) batch.push(detailTracking);
    }

    await reportTrackingBatch(batch, source);
  }

  const tabId = await openOrReuseTab(ORDER_URLS.shipped);
  await sleep(2000);
  await ensureStillLoggedIn(tabId);

  let page = 1;
  while (byNumber.size > 0 && page <= maxPages) {
    ensureNotStopped();
    setPhase('Collecting trackings', `page ${page}/${maxPages}, remaining ${byNumber.size}`);
    await ensureStillLoggedIn(tabId);

    const orderNumbers = Array.from(byNumber.keys());
    const result = await sendToTab(tabId, {
      action: 'scrapeTrackings',
      orderNumbers,
    });
    debug('collectTrackings page result', { page, result });
    log(`Finished page ${page}/${maxPages}, candidates on page: ${(result.pageOrders || []).length}`);

    await collectFromPageResult(result, `page-${page}`);

    if (!byNumber.size) break;
    if (page >= maxPages) {
      log(`Reached lookback page limit ${maxPages}, stop paging`);
      break;
    }

    const next = await sendToTab(tabId, { action: 'goNextPage' });
    if (!next?.hasNext) {
      log('No next page, stop paging');
      break;
    }
    await sleep(2000);
    await ensureStillLoggedIn(tabId);
    page += 1;
  }

  const remainingAfterPages = Array.from(byNumber.keys());
  if (remainingAfterPages.length) {
    log(
      `Not found in ${maxPages} lookback page(s): ${remainingAfterPages.length} order(s). Opening order details: ${remainingAfterPages.join(', ')}`
    );
  }

  for (const orderNumber of remainingAfterPages) {
    if (!byNumber.has(orderNumber)) continue;
    ensureNotStopped();
    if (state.limitExceeded) {
      log('Order detail daily limit exceeded, stop opening order details');
      break;
    }

    setPhase('Open order detail', orderNumber);
    log(`Open order detail: ${orderNumber}`);
    const detailTracking = await getTrackingFromOrderPage(orderNumber);
    if (detailTracking) {
      await reportTrackingBatch([detailTracking], `order-detail-${orderNumber}`);
    } else {
      log(`No tracking on order detail: ${orderNumber}`);
    }
    await sleep(1000);
  }

  const notCollected = Array.from(byNumber.keys());
  const collectedCount = collected.length;
  const notCollectedCount = notCollected.length;

  log('========== Tracking collection summary ==========');
  log(`Pending: ${pendingTotal}`);
  log(`Lookback pages: ${maxPages}`);
  log(`Collected: ${collectedCount}`);
  log(`Not collected: ${notCollectedCount}`);
  if (collected.length) {
    log('Collected details:');
    for (const item of collected) {
      log(
        `  - ${item.order_number} => ${item.tracking}` +
          (item.carrier ? ` (${item.carrier})` : '')
      );
    }
  }
  if (notCollected.length) {
    log(`Not collected order numbers: ${notCollected.join(', ')}`);
  }
  log(`Report succeeded: ${reportSuccess.length}`);
  if (reportSuccess.length) {
    log(`Report succeeded orders: ${reportSuccess.join(', ')}`);
  }
  log(`Report failed: ${reportFailed.length}`);
  if (reportFailed.length) {
    log(`Report failed orders: ${reportFailed.join(', ')}`);
  }
  log('================================================');
}

async function runCollector({ email, days } = {}) {
  if (state.running) return { error: 'Already running' };

  await loadCachedSession();

  const settings = await chrome.storage.sync.get({ email: '', days: 3 });
  const localSettings = await chrome.storage.local.get({ token: '' });
  const buyerEmail = (email || settings.email || '').trim();
  const apiToken = (localSettings.token || '').trim();
  const lookbackPages = Number(days || settings.days) || 3;

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
  setPhase('Starting');
  startRunLog({ email: buyerEmail, days: lookbackPages });

  try {
    log(`Collector started for ${buyerEmail}, lookbackPages=${lookbackPages}`);
    const service = new EbayOrderService(apiToken);

    // Order list still uses lookback as days cutoff for purchase history
    await collectOrders(service, buyerEmail, lookbackPages, ORDER_URLS.all);
    await collectOrders(service, buyerEmail, lookbackPages, ORDER_URLS.payment_failed, 3);
    await collectOrders(service, buyerEmail, lookbackPages, ORDER_URLS.returns_and_canceled, 3);
    await collectOrderTrackings(service, buyerEmail, lookbackPages);

    setPhase('Done', 'completed');
    log('Collector finished');
    await finishRunLog('completed', { ok: true });
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
    runCollector(message.payload || {}).then((result) => sendResponse(result || { ok: true }));
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

loadCachedSession();
