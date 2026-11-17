/**
 * InstaKit Content Script (ISOLATED world)
 * Final production build:
 * - Bulletproof clipboard copy (Clipboard API + execCommand fallback)
 * - SPA route cleanup so profile/story/reel icons never duplicate
 * - On-demand media & profile resolution (posts, carousels, reels, stories, highlights, bio, PFP)
 * - Multi-select media picker modal (all pre-selected, ZIP or Sequential choice)
 * - CORS-safe ZIP bundling via background fallback + direct blob download
 */
(() => {
  if (window.__INSTAKIT_CONTENT__) return;
  window.__INSTAKIT_CONTENT__ = true;

  const I18N = {
    ar: {
      downloadPost: 'تنزيل البوست',
      downloadSelected: 'تحميل الصورة المحددة فقط',
      downloadAllPost: 'تحديد وتحميل كل صور ومقاطع البوست',
      downloadReel: 'تحميل الريلز',
      downloadPhoto: 'تحميل الصورة',
      downloadStory: 'تحميل الستوري',
      downloadAllStories: 'تحديد وتحميل كل الستوريات',
      downloadHighlightOne: 'تحميل هذه الستوري من الهايلايت',
      downloadHighlightAll: 'تحديد وتحميل الهايلايت كامل',
      downloadPfp: 'تحميل صورة البروفايل (PFP)',
      copyBio: 'نسخ البايو',
      downloadBio: 'تحميل البايو (.txt)',
      copyUser: 'نسخ اليوزر',
      copyName: 'نسخ الاسم',
      copyCaption: 'نسخ الوصف',
      copied: 'تم النسخ:',
      copyFailed: 'تعذر النسخ إلى الحافظة',
      downloading: 'جاري التنزيل...',
      packingZip: 'جاري تجهيز ملف ZIP...',
      downloaded: 'تم بدء التنزيل',
      noMedia: 'تعذر العثور على رابط مباشر للوسائط',
      noText: 'لا يوجد نص متاح للنسخ',
      pickerTitle: 'تحديد الصور والمقاطع للتنزيل',
      selectAll: 'تحديد الكل',
      deselectAll: 'إلغاء الكل',
      selectedCount: 'محدد',
      downloadZip: 'تنزيل في ملف .ZIP',
      downloadSequential: 'تنزيل متتالي (واحد تلو الآخر)',
      close: 'إغلاق',
      videoTag: 'فيديو',
      photoTag: 'صورة',
    },
    en: {
      downloadPost: 'Download Post',
      downloadSelected: 'Download Selected Photo Only',
      downloadAllPost: 'Select & Download All Post Media',
      downloadReel: 'Download Reel',
      downloadPhoto: 'Download Photo',
      downloadStory: 'Download Story',
      downloadAllStories: 'Select & Download All Stories',
      downloadHighlightOne: 'Download This Highlight Story',
      downloadHighlightAll: 'Select & Download Full Highlight',
      downloadPfp: 'Download Profile Picture (PFP)',
      copyBio: 'Copy Bio',
      downloadBio: 'Save Bio (.txt)',
      copyUser: 'Copy @username',
      copyName: 'Copy Display Name',
      copyCaption: 'Copy Caption',
      copied: 'Copied:',
      copyFailed: 'Failed to copy to clipboard',
      downloading: 'Downloading...',
      packingZip: 'Building ZIP archive...',
      downloaded: 'Download started',
      noMedia: 'Could not locate direct media URL',
      noText: 'No text found to copy',
      pickerTitle: 'Select Media to Download',
      selectAll: 'Select All',
      deselectAll: 'Deselect All',
      selectedCount: 'selected',
      downloadZip: 'Download as .ZIP',
      downloadSequential: 'Download Sequentially',
      close: 'Close',
      videoTag: 'MP4',
      photoTag: 'JPG',
    },
  };

  let settings = {
    lang: 'ar',
    theme: 'auto',
    batchMode: 'ask',
    enablePostDownload: true,
    enableReelDownload: true,
    enablePhotoDownload: true,
    enableStoryDownload: true,
    enablePfpDownload: true,
    enableBioActions: true,
    enableCopyUsername: true,
    filenamePattern: '{username}_{type}_{id}',
  };

  const mediaCache = new Map();
  const userCache = new Map();
  const storyCache = new Map();
  let lastPathname = location.pathname;

  window.addEventListener('instakit:cache-update', (e) => {
    const { type, payload } = e.detail || {};
    if (type === 'media' && payload?.code) {
      mediaCache.set(payload.code, payload);
    } else if (type === 'user' && payload?.username) {
      userCache.set(payload.username.toLowerCase(), payload);
    } else if (type === 'story' && payload) {
      if (payload.highlightId) storyCache.set(`highlight:${payload.highlightId}`, payload);
      if (payload.username) storyCache.set(`user:${payload.username.toLowerCase()}`, payload);
    }
  });

  function sendMsg(payload) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(payload, (res) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
          } else {
            resolve(res || { ok: false });
          }
        });
      } catch (err) {
        resolve({ ok: false, error: err.message });
      }
    });
  }

  function resolveFromPageWorld(kind, key) {
    return new Promise((resolve) => {
      const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const timer = setTimeout(() => {
        window.removeEventListener('instakit:resolve-result', onRes);
        resolve(null);
      }, 4500);

      function onRes(e) {
        if (e.detail?.requestId === requestId) {
          clearTimeout(timer);
          window.removeEventListener('instakit:resolve-result', onRes);
          resolve(e.detail.result || null);
        }
      }

      window.addEventListener('instakit:resolve-result', onRes);
      window.dispatchEvent(
        new CustomEvent('instakit:resolve-media', {
          detail: { requestId, kind, key },
        })
      );
    });
  }

  function detectPageDarkTheme() {
    if (settings.theme === 'dark') return true;
    if (settings.theme === 'light') return false;
    const bg = getComputedStyle(document.body).backgroundColor;
    const match = bg.match(/\d+/g);
    if (match && match.length >= 3) {
      const luminance =
        (0.299 * Number(match[0]) +
          0.587 * Number(match[1]) +
          0.114 * Number(match[2])) /
        255;
      return luminance < 0.45;
    }
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  function applyAdaptiveTheme() {
    const isDark = detectPageDarkTheme();
    document.documentElement.setAttribute(
      'data-instakit-theme',
      isDark ? 'dark' : 'light'
    );
  }

  function t(key) {
    const dict = I18N[settings.lang] || I18N.ar;
    return dict[key] || key;
  }

  function loadSettings() {
    chrome.storage.sync.get(settings, (stored) => {
      if (!chrome.runtime.lastError && stored) {
        settings = { ...settings, ...stored };
      }
      applyAdaptiveTheme();
      scanAndInject();
    });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync') {
      for (const [key, val] of Object.entries(changes)) {
        settings[key] = val.newValue;
      }
      applyAdaptiveTheme();
      document.querySelectorAll('[data-instakit-injected]').forEach((el) => el.remove());
      document.querySelectorAll('[data-instakit-profile-user]').forEach((el) => {
        delete el.dataset.instakitProfileUser;
      });
      scanAndInject();
    }
  });

  function showToast(message) {
    let toast = document.getElementById('instakit-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'instakit-toast';
      toast.className = 'instakit-toast';
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.add('is-visible');
    clearTimeout(toast.__timer);
    toast.__timer = setTimeout(() => {
      toast.classList.remove('is-visible');
    }, 2600);
  }

  const ICONS = {
    download:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
    copy:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
    layers:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>',
    fileText:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
    atSign:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-3.92 7.94"/></svg>',
    user:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
  };

  function createIconBtn({
    tooltip,
    icon = 'download',
    variant = 'default',
    size = 'md',
    tooltipPos = 'top',
    onClick,
  }) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `instakit-icon-btn ${
      variant === 'primary' ? 'instakit-icon-btn--primary' : ''
    } ${size === 'sm' ? 'instakit-icon-btn--sm' : ''}`;
    btn.setAttribute('data-instakit-injected', 'true');
    btn.setAttribute('data-tooltip', tooltip);
    btn.setAttribute('aria-label', tooltip);
    if (tooltipPos === 'bottom') btn.setAttribute('data-tooltip-pos', 'bottom');
    btn.innerHTML = ICONS[icon] || ICONS.download;
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      onClick(btn);
    });
    return btn;
  }

  function execCommandCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.left = '-9999px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    const activeEl = document.activeElement;
    ta.focus({ preventScroll: true });
    ta.select();
    ta.setSelectionRange(0, text.length);
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    if (activeEl && typeof activeEl.focus === 'function') {
      try {
        activeEl.focus({ preventScroll: true });
      } catch {
        // Ignore
      }
    }
    return ok;
  }

  async function copyText(text, label, username = '') {
    const cleaned = String(text || '').trim();
    if (!cleaned) {
      showToast(t('noText'));
      return;
    }

    let copied = false;
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      try {
        await navigator.clipboard.writeText(cleaned);
        copied = true;
      } catch {
        copied = execCommandCopy(cleaned);
      }
    } else {
      copied = execCommandCopy(cleaned);
    }

    if (copied) {
      const preview = cleaned.replace(/\s+/g, ' ').slice(0, 40);
      showToast(`${t('copied')} ${preview}${cleaned.length > 40 ? '...' : ''}`);
      sendMsg({
        action: 'LOG_COPY',
        label: `${label}: ${preview}`,
        username,
        type: 'copy',
      });
    } else {
      showToast(t('copyFailed'));
    }
  }

  async function downloadSingle({ url, username, type, id, ext }) {
    if (!url || url.startsWith('blob:')) {
      showToast(t('noMedia'));
      return;
    }
    showToast(t('downloading'));
    const res = await sendMsg({
      action: 'DOWNLOAD_MEDIA',
      url,
      username,
      type,
      id,
      ext,
    });
    if (res?.ok) showToast(`${t('downloaded')}: ${res.filename}`);
    else showToast(res?.error || t('noMedia'));
  }

  async function downloadSequential({ items, username, type, id }) {
    const valid = items.filter((item) => item.url && !item.url.startsWith('blob:'));
    if (valid.length === 0) {
      showToast(t('noMedia'));
      return;
    }
    showToast(t('downloading'));
    const res = await sendMsg({
      action: 'DOWNLOAD_BATCH',
      items: valid,
      username,
      type,
      id,
    });
    if (res?.ok) showToast(`${t('downloaded')} (${res.count})`);
    else showToast(res?.error || t('noMedia'));
  }

  function base64ToUint8Array(base64) {
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
      bytes[i] = bin.charCodeAt(i);
    }
    return bytes;
  }

  async function fetchBinaryBytes(url) {
    try {
      const res = await fetch(url, { mode: 'cors', credentials: 'omit', cache: 'no-store' });
      if (res.ok) return new Uint8Array(await res.arrayBuffer());
    } catch {
      // Fallback to service worker fetch with host_permissions (CORS-free)
    }
    const bgRes = await sendMsg({ action: 'FETCH_MEDIA_BASE64', url });
    if (bgRes?.ok && bgRes.base64) {
      return base64ToUint8Array(bgRes.base64);
    }
    throw new Error('Unable to fetch binary');
  }

  async function downloadAsZip({ items, username, type, id }) {
    const valid = items.filter((item) => item.url && !item.url.startsWith('blob:'));
    if (valid.length === 0 || !window.InstaKitZip) {
      showToast(t('noMedia'));
      return;
    }
    showToast(t('packingZip'));
    try {
      const entries = [];
      for (let i = 0; i < valid.length; i++) {
        const item = valid[i];
        const data = await fetchBinaryBytes(item.url);
        const ext = item.ext || (item.type === 'video' ? 'mp4' : 'jpg');
        entries.push({
          name: `${username}_${type}_${i + 1}.${ext}`,
          data,
        });
      }
      const zipBlob = window.InstaKitZip.buildZipBlob(entries);
      const zipName = `${username}_${type}_${id || Date.now()}.zip`.replace(
        /[<>:"/\\|?*]/g,
        '_'
      );
      const objectUrl = URL.createObjectURL(zipBlob);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = zipName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 2500);
      showToast(`${t('downloaded')}: ${zipName}`);
      sendMsg({ action: 'LOG_HISTORY', filename: zipName, type, username });
    } catch {
      downloadSequential({ items: valid, username, type, id });
    }
  }

  function openMediaPickerModal({ items, username, type, id }) {
    const valid = items.filter((item) => item.url && !item.url.startsWith('blob:'));
    if (valid.length === 0) {
      showToast(t('noMedia'));
      return;
    }

    if (settings.batchMode === 'zip') {
      downloadAsZip({ items: valid, username, type, id });
      return;
    }
    if (settings.batchMode === 'sequential') {
      downloadSequential({ items: valid, username, type, id });
      return;
    }

    document.getElementById('instakit-picker-backdrop')?.remove();

    const selected = new Set(valid.map((_, idx) => idx));

    const backdrop = document.createElement('div');
    backdrop.id = 'instakit-picker-backdrop';
    backdrop.className = 'instakit-modal-backdrop';
    backdrop.dir = settings.lang === 'ar' ? 'rtl' : 'ltr';

    const modal = document.createElement('div');
    modal.className = 'instakit-modal';

    const header = document.createElement('div');
    header.className = 'instakit-modal-header';
    const titleEl = document.createElement('h3');
    titleEl.className = 'instakit-modal-title';
    titleEl.textContent = t('pickerTitle');
    header.appendChild(titleEl);

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'instakit-pill-btn';
    closeBtn.textContent = t('close');
    closeBtn.addEventListener('click', () => backdrop.remove());
    header.appendChild(closeBtn);

    const toolbar = document.createElement('div');
    toolbar.className = 'instakit-modal-toolbar';
    const countLabel = document.createElement('span');
    const toggleAllBtn = document.createElement('button');
    toggleAllBtn.type = 'button';
    toggleAllBtn.className = 'instakit-pill-btn';
    toolbar.appendChild(countLabel);
    toolbar.appendChild(toggleAllBtn);

    const grid = document.createElement('div');
    grid.className = 'instakit-modal-grid';

    const footer = document.createElement('div');
    footer.className = 'instakit-modal-footer';

    const seqBtn = document.createElement('button');
    seqBtn.type = 'button';
    seqBtn.className = 'instakit-pill-btn';

    const zipBtn = document.createElement('button');
    zipBtn.type = 'button';
    zipBtn.className = 'instakit-pill-btn instakit-pill-btn--primary';

    footer.appendChild(seqBtn);
    footer.appendChild(zipBtn);

    function syncUI() {
      const count = selected.size;
      countLabel.textContent = `${count} / ${valid.length} ${t('selectedCount')}`;
      toggleAllBtn.textContent =
        count === valid.length ? t('deselectAll') : t('selectAll');
      seqBtn.textContent = `${t('downloadSequential')} (${count})`;
      zipBtn.textContent = `${t('downloadZip')} (${count})`;
      seqBtn.disabled = count === 0;
      zipBtn.disabled = count === 0;
    }

    valid.forEach((item, idx) => {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'instakit-thumb is-selected';

      const previewUrl = item.poster || item.url;
      const imgEl = document.createElement('img');
      imgEl.src = previewUrl;
      imgEl.alt = `Item ${idx + 1}`;

      const checkEl = document.createElement('span');
      checkEl.className = 'instakit-thumb-check';
      checkEl.textContent = '✓';

      const typeEl = document.createElement('span');
      typeEl.className = 'instakit-thumb-type';
      typeEl.textContent = item.type === 'video' ? t('videoTag') : t('photoTag');

      card.appendChild(imgEl);
      card.appendChild(checkEl);
      card.appendChild(typeEl);

      card.addEventListener('click', () => {
        if (selected.has(idx)) {
          selected.delete(idx);
          card.classList.remove('is-selected');
          checkEl.textContent = '';
        } else {
          selected.add(idx);
          card.classList.add('is-selected');
          checkEl.textContent = '✓';
        }
        syncUI();
      });
      grid.appendChild(card);
    });

    toggleAllBtn.addEventListener('click', () => {
      const selectEverything = selected.size < valid.length;
      const cards = grid.querySelectorAll('.instakit-thumb');
      cards.forEach((card, idx) => {
        const checkEl = card.querySelector('.instakit-thumb-check');
        if (selectEverything) {
          selected.add(idx);
          card.classList.add('is-selected');
          if (checkEl) checkEl.textContent = '✓';
        } else {
          selected.delete(idx);
          card.classList.remove('is-selected');
          if (checkEl) checkEl.textContent = '';
        }
      });
      syncUI();
    });

    seqBtn.addEventListener('click', () => {
      const picked = valid.filter((_, idx) => selected.has(idx));
      backdrop.remove();
      downloadSequential({ items: picked, username, type, id });
    });

    zipBtn.addEventListener('click', () => {
      const picked = valid.filter((_, idx) => selected.has(idx));
      backdrop.remove();
      downloadAsZip({ items: picked, username, type, id });
    });

    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) backdrop.remove();
    });

    syncUI();
    modal.appendChild(header);
    modal.appendChild(toolbar);
    modal.appendChild(grid);
    modal.appendChild(footer);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
  }

  function getBestSrcFromImg(img) {
    if (!img) return null;
    const srcset = img.getAttribute('srcset');
    if (srcset) {
      const candidates = srcset
        .split(',')
        .map((part) => {
          const [url, size] = part.trim().split(/\s+/);
          const width = parseInt(size || '0', 10) || 0;
          return { url, width };
        })
        .filter((c) => c.url);
      candidates.sort((a, b) => b.width - a.width);
      if (candidates[0]?.url) return candidates[0].url;
    }
    return img.src || null;
  }

  function getPostShortcode(root) {
    const links = root.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]');
    for (const a of links) {
      const m = a.getAttribute('href')?.match(/\/(p|reel)\/([^/?]+)/);
      if (m) return m[2];
    }
    const pathMatch = location.pathname.match(/\/(p|reel)\/([^/?]+)/);
    return pathMatch ? pathMatch[2] : '';
  }

  function getArticleUsername(article) {
    const headerLink = article.querySelector('header a[href^="/"]');
    const href = headerLink?.getAttribute('href') || '';
    const clean = href.replace(/\//g, '').trim();
    if (clean) return clean;
    return headerLink?.textContent?.trim() || 'instagram';
  }

  function getArticleCaption(article, username) {
    const h1 = article.querySelector('h1');
    if (h1?.textContent?.trim()) return h1.textContent.trim();

    const authorBlocks = Array.from(article.querySelectorAll('span[dir="auto"]'));
    for (const span of authorBlocks) {
      if (span.closest('header') || span.closest('button')) continue;
      const text = span.textContent?.trim() || '';
      if (!text || text === username) continue;
      if (/^(\d[\d,.]*\s*(likes?|views?|أعجبني|تسجيل إعجاب))$/i.test(text)) continue;
      if (text.length > 3) return text;
    }
    return '';
  }

  function detectVisibleSlideIndex(article) {
    const dots = Array.from(article.querySelectorAll('div._acnb'));
    const activeDot = dots.findIndex((d) => d.classList.contains('_acnf'));
    if (activeDot >= 0) return activeDot;

    const listItems = Array.from(article.querySelectorAll('ul li'));
    if (listItems.length > 1) {
      const articleRect = article.getBoundingClientRect();
      const centerX = articleRect.left + articleRect.width / 2;
      let bestIdx = 0;
      let bestDist = Infinity;
      listItems.forEach((li, idx) => {
        const rect = li.getBoundingClientRect();
        if (rect.width === 0) return;
        const dist = Math.abs(rect.left + rect.width / 2 - centerX);
        if (dist < bestDist) {
          bestDist = dist;
          bestIdx = idx;
        }
      });
      return bestIdx;
    }
    return 0;
  }

  function injectPostControls(article) {
    const saveIcon = article.querySelector('svg[aria-label*="Save"], svg[aria-label*="حفظ"]');
    const actionBar = saveIcon?.closest('section') || article.querySelector('section');
    if (!actionBar || article.querySelector('[data-instakit-post-dock]')) return;

    const shortcode = getPostShortcode(article);
    const username = getArticleUsername(article);

    if (settings.enableCopyUsername && username && username !== 'instagram') {
      const header = article.querySelector('header');
      if (header && !header.querySelector('[data-instakit-userbtn]')) {
        const copyUserBtn = createIconBtn({
          tooltip: t('copyUser'),
          icon: 'atSign',
          size: 'sm',
          tooltipPos: 'bottom',
          onClick: () => copyText(`@${username}`, 'Username', username),
        });
        copyUserBtn.setAttribute('data-instakit-userbtn', '1');
        header.appendChild(copyUserBtn);
      }
    }

    const dock = document.createElement('div');
    dock.className = 'instakit-dock';
    dock.setAttribute('data-instakit-injected', 'true');
    dock.setAttribute('data-instakit-post-dock', '1');

    const cached = shortcode ? mediaCache.get(shortcode) : null;
    const hasCarousel = Boolean(
      (cached && cached.slides.length > 1) ||
        article.querySelector('button[aria-label*="Next"], button[aria-label*="التالي"]') ||
        article.querySelectorAll('div._acnb').length > 1
    );

    if (settings.enablePostDownload || settings.enablePhotoDownload) {
      dock.appendChild(
        createIconBtn({
          tooltip: hasCarousel ? t('downloadSelected') : t('downloadPost'),
          icon: 'download',
          variant: 'primary',
          onClick: async () => {
            let freshCache = shortcode ? mediaCache.get(shortcode) : null;
            if (!freshCache && shortcode) {
              freshCache = await resolveFromPageWorld('post', shortcode);
            }
            const visibleIdx = detectVisibleSlideIndex(article);

            if (freshCache?.slides?.[visibleIdx]?.url) {
              const s = freshCache.slides[visibleIdx];
              downloadSingle({
                url: s.url,
                username,
                type: s.type === 'video' ? 'post_video' : 'photo_selected',
                id: `${shortcode}_${visibleIdx + 1}`,
                ext: s.type === 'video' ? 'mp4' : 'jpg',
              });
              return;
            }

            const listItems = Array.from(article.querySelectorAll('ul li'));
            const targetRoot = listItems[visibleIdx] || article;
            const video = targetRoot.querySelector('video');
            const videoSrc = video?.src || video?.querySelector('source')?.src || '';
            if (videoSrc && !videoSrc.startsWith('blob:')) {
              downloadSingle({
                url: videoSrc,
                username,
                type: 'post_video',
                id: shortcode,
                ext: 'mp4',
              });
              return;
            }

            const imgs = Array.from(targetRoot.querySelectorAll('img')).filter(
              (img) => (img.naturalWidth || img.width) > 150
            );
            const bestImg = getBestSrcFromImg(imgs[0]);
            if (bestImg) {
              downloadSingle({
                url: bestImg,
                username,
                type: 'photo_selected',
                id: `${shortcode}_${visibleIdx + 1}`,
                ext: 'jpg',
              });
            } else {
              showToast(t('noMedia'));
            }
          },
        })
      );
    }

    if (hasCarousel && settings.enablePostDownload) {
      dock.appendChild(
        createIconBtn({
          tooltip: t('downloadAllPost'),
          icon: 'layers',
          onClick: async () => {
            let freshCache = shortcode ? mediaCache.get(shortcode) : null;
            if ((!freshCache || freshCache.slides.length <= 1) && shortcode) {
              const resolved = await resolveFromPageWorld('post', shortcode);
              if (resolved) freshCache = resolved;
            }

            if (freshCache?.slides?.length) {
              openMediaPickerModal({
                items: freshCache.slides.map((s) => ({
                  url: s.url,
                  poster: s.poster || s.url,
                  type: s.type,
                  ext: s.type === 'video' ? 'mp4' : 'jpg',
                })),
                username,
                type: 'carousel',
                id: shortcode,
              });
              return;
            }

            const domItems = Array.from(article.querySelectorAll('ul li'))
              .map((li) => {
                const v = li.querySelector('video');
                const vSrc = v?.src || v?.querySelector('source')?.src || '';
                if (vSrc && !vSrc.startsWith('blob:')) {
                  return { url: vSrc, poster: v?.poster, type: 'video', ext: 'mp4' };
                }
                const img = li.querySelector('img');
                const url = getBestSrcFromImg(img);
                return url ? { url, poster: url, type: 'image', ext: 'jpg' } : null;
              })
              .filter(Boolean);

            openMediaPickerModal({
              items: domItems,
              username,
              type: 'carousel',
              id: shortcode || Date.now(),
            });
          },
        })
      );
    }

    if (settings.enableBioActions) {
      dock.appendChild(
        createIconBtn({
          tooltip: t('copyCaption'),
          icon: 'copy',
          onClick: async () => {
            let freshCache = shortcode ? mediaCache.get(shortcode) : null;
            if (!freshCache?.caption && shortcode) {
              freshCache = await resolveFromPageWorld('post', shortcode);
            }
            const caption = freshCache?.caption || getArticleCaption(article, username);
            copyText(caption, 'Caption', username);
          },
        })
      );
    }

    if (dock.children.length > 0) {
      actionBar.appendChild(dock);
    }
  }

  function injectReelControls() {
    if (!settings.enableReelDownload) return;
    if (!location.pathname.includes('/reel')) return;

    const videos = document.querySelectorAll('video');
    videos.forEach((video) => {
      const container = video.closest('div[role="presentation"]') || video.parentElement;
      if (!container || container.querySelector('[data-instakit-reelbtn]')) return;

      if (getComputedStyle(container).position === 'static') {
        container.style.position = 'relative';
      }

      const corner = document.createElement('div');
      corner.className = 'instakit-overlay-corner';
      corner.setAttribute('data-instakit-injected', 'true');
      corner.setAttribute('data-instakit-reelbtn', '1');

      corner.appendChild(
        createIconBtn({
          tooltip: t('downloadReel'),
          icon: 'download',
          variant: 'primary',
          onClick: async () => {
            const cardRoot = container.closest('article') || container.parentElement?.parentElement || document;
            const linkCode = getPostShortcode(cardRoot);
            const pathCode = location.pathname.match(/\/reels?\/([^/?]+)/)?.[1] || '';
            const code = linkCode || pathCode;

            let cached = code ? mediaCache.get(code) : null;
            if (!cached && code) {
              cached = await resolveFromPageWorld('post', code);
            }
            const directSrc = video.src || video.querySelector('source')?.src || '';
            const url =
              cached?.slides?.find((s) => s.type === 'video')?.url ||
              (directSrc && !directSrc.startsWith('blob:') ? directSrc : '');

            downloadSingle({
              url,
              username: cached?.username || 'instagram',
              type: 'reel',
              id: code || Date.now(),
              ext: 'mp4',
            });
          },
        })
      );

      container.appendChild(corner);
    });
  }

  function matchVisibleStoryItem(section, items) {
    if (!Array.isArray(items) || items.length === 0) return items[0];
    const visibleImg = Array.from(section.querySelectorAll('img')).find(
      (img) => (img.naturalWidth || img.width) > 200
    );
    const visibleSrc = visibleImg?.src || '';
    if (visibleSrc) {
      const matched = items.find((item) => {
        const ref = item.poster || item.url || '';
        const token = ref.split('/').pop()?.split('?')[0];
        return token && visibleSrc.includes(token);
      });
      if (matched) return matched;
    }
    return items[0];
  }

  function injectStoryAndHighlightControls() {
    if (!settings.enableStoryDownload) return;
    if (!location.pathname.startsWith('/stories/')) return;

    const section = document.querySelector('section');
    if (!section || section.querySelector('[data-instakit-storybar]')) return;

    const highlightMatch = location.pathname.match(/\/stories\/highlights\/(\d+)/);
    const isHighlight = Boolean(highlightMatch);
    const highlightId = highlightMatch ? highlightMatch[1] : null;
    const userMatch = location.pathname.match(/\/stories\/([^/?]+)/);
    const storyUser = !isHighlight && userMatch ? userMatch[1] : 'instagram';

    const corner = document.createElement('div');
    corner.className = 'instakit-overlay-corner';
    corner.setAttribute('data-instakit-injected', 'true');
    corner.setAttribute('data-instakit-storybar', '1');

    const resolveTray = async () => {
      const key = isHighlight ? `highlight:${highlightId}` : `user:${storyUser.toLowerCase()}`;
      let cached = storyCache.get(key);
      if (!cached?.items?.length) {
        cached = await resolveFromPageWorld(
          isHighlight ? 'highlight' : 'story',
          isHighlight ? highlightId : storyUser
        );
      }
      return cached;
    };

    const getCurrentStoryMedia = async () => {
      const cached = await resolveTray();
      if (cached?.items?.length) {
        const item = matchVisibleStoryItem(section, cached.items);
        if (item?.url) {
          return {
            url: item.url,
            ext: item.type === 'video' ? 'mp4' : 'jpg',
            username: cached.username || storyUser,
            id: item.id,
          };
        }
      }
      const video = section.querySelector('video');
      const vSrc = video?.src || video?.querySelector('source')?.src || '';
      if (vSrc && !vSrc.startsWith('blob:')) {
        return { url: vSrc, ext: 'mp4', username: storyUser, id: Date.now() };
      }
      const imgs = Array.from(section.querySelectorAll('img')).filter(
        (img) => (img.naturalWidth || img.width) > 200
      );
      const best = getBestSrcFromImg(imgs[0]);
      return best ? { url: best, ext: 'jpg', username: storyUser, id: Date.now() } : null;
    };

    corner.appendChild(
      createIconBtn({
        tooltip: isHighlight ? t('downloadHighlightOne') : t('downloadStory'),
        icon: 'download',
        variant: 'primary',
        onClick: async () => {
          const media = await getCurrentStoryMedia();
          if (!media) return showToast(t('noMedia'));
          downloadSingle({
            url: media.url,
            username: media.username,
            type: isHighlight ? 'highlight_story' : 'story',
            id: isHighlight ? `${highlightId}_${media.id}` : media.id,
            ext: media.ext,
          });
        },
      })
    );

    corner.appendChild(
      createIconBtn({
        tooltip: isHighlight ? t('downloadHighlightAll') : t('downloadAllStories'),
        icon: 'layers',
        onClick: async () => {
          const cached = await resolveTray();
          if (cached?.items?.length) {
            openMediaPickerModal({
              items: cached.items.map((item) => ({
                url: item.url,
                poster: item.poster || item.url,
                type: item.type,
                ext: item.type === 'video' ? 'mp4' : 'jpg',
              })),
              username: cached.username || storyUser,
              type: isHighlight ? 'highlight_full' : 'stories',
              id: highlightId || storyUser,
            });
          } else {
            const single = await getCurrentStoryMedia();
            if (!single) return showToast(t('noMedia'));
            openMediaPickerModal({
              items: [
                {
                  url: single.url,
                  poster: single.url,
                  type: single.ext === 'mp4' ? 'video' : 'image',
                  ext: single.ext,
                },
              ],
              username: single.username,
              type: isHighlight ? 'highlight_full' : 'stories',
              id: highlightId || storyUser,
            });
          }
        },
      })
    );

    if (getComputedStyle(section).position === 'static') {
      section.style.position = 'relative';
    }
    section.appendChild(corner);
  }

  function injectProfileControls() {
    const pathParts = location.pathname.split('/').filter(Boolean);
    const reserved = new Set([
      'explore',
      'reels',
      'reel',
      'direct',
      'accounts',
      'stories',
      'p',
    ]);
    if (pathParts.length !== 1 || reserved.has(pathParts[0])) return;

    const username = pathParts[0];
    const header = document.querySelector('header');
    if (!header) return;
    if (
      header.dataset.instakitProfileUser === username &&
      header.querySelector('[data-instakit-profile-dock]')
    ) {
      return;
    }

    // Clear stale controls if React reused <header> across profile navigation
    header.querySelectorAll('[data-instakit-injected]').forEach((el) => el.remove());
    header.dataset.instakitProfileUser = username;

    if (settings.enablePfpDownload) {
      const avatarImg =
        header.querySelector(`img[alt*="${username}"]`) || header.querySelector('img');
      const avatarWrap = avatarImg?.closest('div');
      if (avatarImg && avatarWrap && !avatarWrap.querySelector('[data-instakit-pfp]')) {
        if (getComputedStyle(avatarWrap).position === 'static') {
          avatarWrap.style.position = 'relative';
        }
        const pfpBtn = createIconBtn({
          tooltip: t('downloadPfp'),
          icon: 'download',
          variant: 'primary',
          size: 'sm',
          tooltipPos: 'bottom',
          onClick: async () => {
            let latest = userCache.get(username.toLowerCase());
            if (!latest?.pfpUrl) {
              latest = await resolveFromPageWorld('user', username);
            }
            const url = latest?.pfpUrl || getBestSrcFromImg(avatarImg);
            downloadSingle({
              url,
              username,
              type: 'pfp',
              id: 'avatar',
              ext: 'jpg',
            });
          },
        });
        pfpBtn.classList.add('instakit-pfp-corner');
        pfpBtn.setAttribute('data-instakit-pfp', '1');
        avatarWrap.appendChild(pfpBtn);
      }
    }

    const dock = document.createElement('div');
    dock.className = 'instakit-dock';
    dock.style.marginTop = '8px';
    dock.setAttribute('data-instakit-injected', 'true');
    dock.setAttribute('data-instakit-profile-dock', '1');

    const resolveUser = async () => {
      let latest = userCache.get(username.toLowerCase());
      if (!latest || (!latest.bio && !latest.fullName)) {
        const fetched = await resolveFromPageWorld('user', username);
        if (fetched) latest = fetched;
      }
      return latest;
    };

    if (settings.enableCopyUsername) {
      dock.appendChild(
        createIconBtn({
          tooltip: t('copyUser'),
          icon: 'atSign',
          size: 'sm',
          onClick: () => copyText(`@${username}`, 'Username', username),
        })
      );

      dock.appendChild(
        createIconBtn({
          tooltip: t('copyName'),
          icon: 'user',
          size: 'sm',
          onClick: async () => {
            const latest = await resolveUser();
            const domName =
              header.querySelector('section span[dir="auto"]')?.textContent?.trim() ||
              username;
            copyText(latest?.fullName || domName, 'Name', username);
          },
        })
      );
    }

    if (settings.enableBioActions) {
      const getBioPayload = async () => {
        const latest = await resolveUser();
        if (latest && (latest.bio || latest.externalUrl)) {
          return [
            `${latest.fullName || username} (@${username})`,
            latest.bio,
            latest.externalUrl,
          ]
            .filter(Boolean)
            .join('\n');
        }
        const candidates = Array.from(header.querySelectorAll('section span[dir="auto"], section h1'))
          .map((el) => el.textContent?.trim() || '')
          .filter(
            (txt) =>
              txt &&
              txt !== username &&
              !/^(posts?|followers?|following|follow|message|edit profile|منشور|متابع|يتابع|متابعة|مراسلة)$/i.test(
                txt
              )
          );
        const unique = Array.from(new Set(candidates));
        return unique.join('\n') || `@${username}`;
      };

      dock.appendChild(
        createIconBtn({
          tooltip: t('copyBio'),
          icon: 'copy',
          size: 'sm',
          onClick: async () => {
            const text = await getBioPayload();
            copyText(text, 'Bio', username);
          },
        })
      );

      dock.appendChild(
        createIconBtn({
          tooltip: t('downloadBio'),
          icon: 'fileText',
          size: 'sm',
          variant: 'primary',
          onClick: async () => {
            const text = await getBioPayload();
            const res = await sendMsg({
              action: 'DOWNLOAD_TEXT',
              username,
              type: 'bio',
              id: 'profile',
              text,
            });
            if (res?.ok) showToast(`${t('downloaded')}: ${res.filename}`);
          },
        })
      );
    }

    if (dock.children.length > 0) {
      header.appendChild(dock);
    }
  }

  function scanAndInject() {
    if (location.pathname !== lastPathname) {
      lastPathname = location.pathname;
      document.querySelectorAll('[data-instakit-storybar], [data-instakit-reelbtn]').forEach((el) => el.remove());
    }
    applyAdaptiveTheme();
    document.querySelectorAll('article').forEach(injectPostControls);
    injectReelControls();
    injectStoryAndHighlightControls();
    injectProfileControls();
  }

  const observer = new MutationObserver(() => {
    scanAndInject();
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  window.addEventListener('popstate', scanAndInject);
  loadSettings();
})();
