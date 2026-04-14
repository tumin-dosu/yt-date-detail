/* content.js
 * @file YouTube Absolute Date Display Extension (Hover-Only API / Fixed Next to Relative Date)
 * @description 相対日付の「直後」に絶対日付を固定表示する
 *              ※ YouTube APIはホバー時のみ呼び出す
 *              ※ anchor固定 / Promise重複排除 / fail reason対応
 */

const CONFIG = {
  VIDEO_CARDS: [
    'ytd-rich-item-renderer',
    'ytd-video-renderer',
    'ytd-compact-video-renderer',
    'ytd-grid-video-renderer',
    'yt-lockup-view-model',
    'yt-lockup-view-model-wiz'
  ].join(', '),

  METADATA_SELECTOR: [
    '.ytContentMetadataViewModelMetadataRow',
    '.yt-content-metadata-view-model-wiz__metadata-row',
    '#metadata-line',
    '#metadata',
    '[aria-label]'
  ].join(', '),

  RELATIVE_DATE_PATTERN: /(ago|前|時間|分|秒|日|週|週間|か月|ヶ月|月|年)/i,

  TIMING: {
    STEP_INTERVAL_MS: 250,
    API_DELAY_MS: 700,
    NEGATIVE_CACHE_TTL_MS: 60 * 1000,
    ERROR_BADGE_TTL_MS: 1500
  }
};

class Utils {
  static extractVideoId(input) {
    let targetUrl = '';
    if (typeof input === 'string') {
      targetUrl = input;
    } else if (input instanceof Element) {
      const link = input.querySelector(
        'a[href*="/watch?v="], a[href*="/live/"], a[href*="/shorts/"], a[href*="youtu.be/"]'
      );
      if (link?.href) {
        targetUrl = link.href;
      } else {
        const dataId = input.querySelector('[data-video-id]');
        if (dataId?.dataset?.videoId) return dataId.dataset.videoId;
      }
    }

    if (!targetUrl) return null;

    try {
      const url = new URL(targetUrl, window.location.origin);

      if (url.searchParams.has('v')) {
        return url.searchParams.get('v')?.substring(0, 11) || null;
      }

      const paths = url.pathname.split('/').filter(Boolean);
      if (paths.length > 1 && ['live', 'shorts', 'embed'].includes(paths[0].toLowerCase())) {
        return paths[1].substring(0, 11);
      }

      if (url.hostname === 'youtu.be' && paths.length > 0) {
        return paths[0].substring(0, 11);
      }
    } catch {
      return null;
    }

    return null;
  }

  static formatDate(isoString) {
    if (!isoString) return null;
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return null;
    return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
  }
}

class YouTubeAPI {
  constructor() {
    this.apiKey = null;
  }

  async init() {
    const result = await chrome.storage.sync.get(['youtubeApiKey']);
    this.apiKey = result.youtubeApiKey || null;
  }

  async fetchPublishedDate(videoId) {
    if (!videoId) return { ok: false, reason: 'not_found', publishedAt: null };
    if (!this.apiKey) return { ok: false, reason: 'no_api', publishedAt: null };

    try {
      const url =
        `https://www.googleapis.com/youtube/v3/videos` +
        `?id=${encodeURIComponent(videoId)}` +
        `&part=snippet` +
        `&key=${encodeURIComponent(this.apiKey)}`;

      const res = await fetch(url);
      if (!res.ok) return { ok: false, reason: 'network', publishedAt: null };

      const data = await res.json();
      const publishedAt = data.items?.[0]?.snippet?.publishedAt || null;
      if (!publishedAt) return { ok: false, reason: 'not_found', publishedAt: null };

      return { ok: true, reason: null, publishedAt };
    } catch {
      return { ok: false, reason: 'network', publishedAt: null };
    }
  }
}

class YouTubeDateDisplay {
  constructor() {
    this.api = new YouTubeAPI();

    // videoId -> { status:'ok', date } | { status:'fail', ts, reason }
    this.cache = new Map();

    // videoId -> Promise<{ok:boolean, date:string|null, reason:string|null}>
    this.promiseMap = new Map();

    // card -> anchor span
    this.anchorMap = new WeakMap();

    this.currentCard = null;
    this.currentVideoId = null;

    this.hoverTimer = null;
    this.animationTimer = null;
    this.hoverToken = 0;

    this.initialize();
  }

  async initialize() {
    await this.api.init();
    this.setupEventListeners();
  }

  setupEventListeners() {
    document.addEventListener('mouseover', (e) => this.handleMouseOver(e), true);
    document.addEventListener('mouseout', (e) => this.handleMouseOut(e), true);
    document.addEventListener('yt-navigate-finish', () => this.clearState());

    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === 'sync' && changes.youtubeApiKey !== undefined) {
        this.api.apiKey = changes.youtubeApiKey.newValue;
      }
    });
  }

  handleMouseOver(e) {
    const card = e.target.closest(CONFIG.VIDEO_CARDS);
    if (!card) return;

    const videoId = Utils.extractVideoId(card);
    if (!videoId) return;

    // 同一カード・同一動画なら何もしない
    if (card === this.currentCard && this.currentVideoId === videoId) return;

    this.currentCard = card;
    this.currentVideoId = videoId;

    // アンカー確定（無ければ以降処理しない）
    const anchor = this.getAnchor(card);
    if (!anchor) return;

    const cacheEntry = this.cache.get(videoId);

    if (cacheEntry?.status === 'ok') {
      this.injectDateOverlay(card, cacheEntry.date);
      return;
    }

    if (cacheEntry?.status === 'fail') {
      const freshFail = Date.now() - cacheEntry.ts < CONFIG.TIMING.NEGATIVE_CACHE_TTL_MS;
      if (freshFail) {
        // no_api時はうるさくしない（必要なら表示に変えてOK）
        if (cacheEntry.reason !== 'no_api') this.injectErrorOverlay(card);
        return;
      }
      this.cache.delete(videoId);
    }

    this.startProgressiveLoader(card, videoId);
  }

  handleMouseOut(e) {
    if (!this.currentCard) return;
    if (this.currentCard.contains(e.relatedTarget)) return;
    this.clearState();
  }

  startProgressiveLoader(card, videoId) {
    this.clearAnimationOnly();

    // 位置固定のため anchor 必須
    const anchor = this.getAnchor(card);
    if (!anchor) return;

    let step = 0;
    const steps = ['I..', 'II.', 'III'];

    this.startHoverTimer(card, videoId);

    const runAnimation = () => {
      if (this.currentCard !== card || this.currentVideoId !== videoId) return;
      if (step < steps.length) {
        const txt = card.querySelector('.absolute-date-overlay')?.textContent || '';
        if (txt.includes('/')) return; // 確定済みなら停止
        this.injectDateOverlay(card, steps[step]);
        step++;
        this.animationTimer = setTimeout(runAnimation, CONFIG.TIMING.STEP_INTERVAL_MS);
      }
    };

    runAnimation();
  }

  startHoverTimer(card, videoId) {
    clearTimeout(this.hoverTimer);
    const token = ++this.hoverToken;

    this.hoverTimer = setTimeout(async () => {
      if (token !== this.hoverToken) return;
      if (this.currentCard !== card || this.currentVideoId !== videoId) return;
      await this.processCard(card, videoId);
    }, CONFIG.TIMING.API_DELAY_MS);
  }

  async processCard(card, videoId) {
    if (this.currentCard !== card || this.currentVideoId !== videoId) return;

    // anchor必須（相対日付の横固定）
    const anchor = this.getAnchor(card);
    if (!anchor) return;

    const result = await this.fetchDateWithDedup(videoId);

    // 待っている間に対象が変わっていたら描画しない
    if (this.currentCard !== card || this.currentVideoId !== videoId) return;

    if (result.ok && result.date) {
      this.cache.set(videoId, { status: 'ok', date: result.date });
      this.injectDateOverlay(card, result.date);
      return;
    }

    // fail cache（reason付き）
    this.cache.set(videoId, {
      status: 'fail',
      ts: Date.now(),
      reason: result.reason || 'network'
    });

    // no_apiは無表示、その他は軽く×表示
    if (result.reason !== 'no_api') {
      this.injectErrorOverlay(card);
    } else {
      this.removeLoader(card);
    }
  }

  async fetchDateWithDedup(videoId) {
    if (this.promiseMap.has(videoId)) {
      return this.promiseMap.get(videoId);
    }

    const p = (async () => {
      const apiResult = await this.api.fetchPublishedDate(videoId);

      if (!apiResult.ok) {
        return { ok: false, date: null, reason: apiResult.reason || 'network' };
      }

      const date = Utils.formatDate(apiResult.publishedAt);
      if (!date) return { ok: false, date: null, reason: 'not_found' };

      return { ok: true, date, reason: null };
    })().finally(() => {
      this.promiseMap.delete(videoId);
    });

    this.promiseMap.set(videoId, p);
    return p;
  }

  findRelativeDateSpan(card) {
    const containers = Array.from(card.querySelectorAll(CONFIG.METADATA_SELECTOR));
    const roots = containers.length ? containers : [card];

    for (const root of roots) {
      const spans = Array.from(root.querySelectorAll('span'));
      for (const s of spans) {
        const text = (s.textContent || '').trim();
        if (!text || text.length > 40) continue;

        const aria = (s.getAttribute('aria-label') || '').trim();
        const title = (s.getAttribute('title') || '').trim();
        const probe = `${text} ${aria} ${title}`;

        if (CONFIG.RELATIVE_DATE_PATTERN.test(probe)) return s;
      }
    }
    return null;
  }

  getAnchor(card) {
    const cached = this.anchorMap.get(card);
    if (cached && cached.isConnected && card.contains(cached)) return cached;

    const span = this.findRelativeDateSpan(card);
    if (span) this.anchorMap.set(card, span);
    return span || null;
  }

  injectDateOverlay(card, text) {
    const isDate = text.includes('/');

    const anchor = this.getAnchor(card);
    if (!anchor || !anchor.isConnected || !card.contains(anchor)) return;

    const existingOverlay = card.querySelector('.absolute-date-overlay');

    // 確定日付があるときローダーで上書きしない
    if (existingOverlay && existingOverlay.dataset.isFinal === 'true' && !isDate) return;

    if (existingOverlay) existingOverlay.remove();

    const overlay = document.createElement('span');
    overlay.className = 'absolute-date-overlay ytContentMetadataViewModelMetadataText';
    if (isDate) overlay.dataset.isFinal = 'true';

    overlay.style.cssText = `
      color: var(--yt-spec-text-secondary);
      font-weight: 500;
      margin-left: 6px;
      padding: 1px 6px;
      background-color: var(--yt-spec-badge-chip-background, rgba(0, 0, 0, 0.05));
      border-radius: 4px;
      font-size: 1.4rem;
      line-height: 1.8rem;
      display: inline-flex;
      align-items: center;
      vertical-align: text-bottom;
      min-width: 2.2em;
      justify-content: center;
    `;

    overlay.textContent = isDate ? `(${text})` : text;

    // 相対日付の直後に固定挿入
    anchor.insertAdjacentElement('afterend', overlay);
  }

  injectErrorOverlay(card) {
    const anchor = this.getAnchor(card);
    if (!anchor || !anchor.isConnected || !card.contains(anchor)) return;

    const existingOverlay = card.querySelector('.absolute-date-overlay');
    if (existingOverlay && existingOverlay.dataset.isFinal === 'true') return;
    if (existingOverlay) existingOverlay.remove();

    const overlay = document.createElement('span');
    overlay.className = 'absolute-date-overlay';
    overlay.dataset.isError = 'true';
    overlay.style.cssText = `
      color: var(--yt-spec-error, #f44336);
      font-weight: 700;
      margin-left: 6px;
      padding: 1px 6px;
      background-color: rgba(244, 67, 54, 0.12);
      border-radius: 4px;
      font-size: 1.2rem;
      line-height: 1.8rem;
      display: inline-flex;
      align-items: center;
      vertical-align: text-bottom;
      min-width: 1.8em;
      justify-content: center;
    `;
    overlay.textContent = '×';

    // 相対日付の直後に固定挿入
    anchor.insertAdjacentElement('afterend', overlay);

    setTimeout(() => {
      if (overlay.isConnected && overlay.dataset.isError === 'true') overlay.remove();
    }, CONFIG.TIMING.ERROR_BADGE_TTL_MS);
  }

  removeLoader(card) {
    const overlay = card.querySelector('.absolute-date-overlay');
    if (overlay && !overlay.dataset.isFinal) overlay.remove();
  }

  clearAnimationOnly() {
    if (this.animationTimer) clearTimeout(this.animationTimer);
  }

  clearState() {
    this.clearAnimationOnly();
    if (this.hoverTimer) clearTimeout(this.hoverTimer);
    if (this.currentCard) this.removeLoader(this.currentCard);

    this.currentCard = null;
    this.currentVideoId = null;
    this.hoverToken++;
  }
}

if (window.location.hostname === 'www.youtube.com') {
  new YouTubeDateDisplay();
}