/**
 * InstaKit Page Interceptor (MAIN world)
 * Passively reads Instagram API/GraphQL responses and provides reliable on-demand
 * resolution (cache + React fiber + authenticated fetch fallback) for posts,
 * carousels, reels, stories, highlights, PFP, bio, and captions.
 */
(() => {
  if (window.__INSTAKIT_INTERCEPTOR__) return;
  window.__INSTAKIT_INTERCEPTOR__ = true;

  const mediaCache = new Map();
  const userCache = new Map();
  const storyCache = new Map();

  function emit(type, payload) {
    window.dispatchEvent(
      new CustomEvent('instakit:cache-update', {
        detail: { type, payload },
      })
    );
  }

  function pickBestCandidate(candidates) {
    if (!Array.isArray(candidates) || candidates.length === 0) return null;
    return (
      candidates
        .slice()
        .sort(
          (a, b) =>
            (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0)
        )[0]?.url || null
    );
  }

  function pickBestVideo(versions) {
    if (!Array.isArray(versions) || versions.length === 0) return null;
    return (
      versions
        .slice()
        .sort(
          (a, b) =>
            (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0)
        )[0]?.url || null
    );
  }

  function extractReelTray(reel) {
    if (!reel || typeof reel !== 'object' || !Array.isArray(reel.items)) return;
    const rawId = String(reel.id || '');
    const highlightMatch = rawId.match(/highlight:(\d+)/);
    const key = highlightMatch ? `highlight:${highlightMatch[1]}` : rawId;
    const username = reel.user?.username || '';
    const title = reel.title || '';

    const items = [];
    for (const item of reel.items) {
      const videoUrl = pickBestVideo(item.video_versions) || item.video_url;
      const imageUrl =
        pickBestCandidate(item.image_versions2?.candidates) || item.display_url;
      if (videoUrl) {
        items.push({
          id: String(item.pk || item.id || items.length + 1),
          type: 'video',
          url: videoUrl,
          poster: imageUrl,
          username: item.user?.username || username,
        });
      } else if (imageUrl) {
        items.push({
          id: String(item.pk || item.id || items.length + 1),
          type: 'image',
          url: imageUrl,
          poster: imageUrl,
          username: item.user?.username || username,
        });
      }
    }

    if (items.length > 0 && (key || username)) {
      const entry = {
        key: key || username,
        isHighlight: Boolean(highlightMatch),
        highlightId: highlightMatch ? highlightMatch[1] : null,
        title,
        username: username || items[0]?.username || 'instagram',
        items,
      };
      if (entry.highlightId) storyCache.set(`highlight:${entry.highlightId}`, entry);
      if (entry.username) storyCache.set(`user:${entry.username.toLowerCase()}`, entry);
      emit('story', entry);
    }
  }

  function extractMediaItem(node) {
    if (!node || typeof node !== 'object') return;

    const code = node.code || node.shortcode;
    const id = node.pk || node.id;
    const owner = node.user || node.owner || {};
    const username = owner.username || '';

    if (
      username &&
      (owner.hd_profile_pic_url_info?.url ||
        owner.profile_pic_url_hd ||
        owner.profile_pic_url ||
        owner.biography !== undefined)
    ) {
      const prev = userCache.get(username.toLowerCase()) || {};
      const userEntry = {
        username,
        id: String(owner.pk || owner.id || prev.id || ''),
        fullName: owner.full_name || prev.fullName || '',
        bio: owner.biography !== undefined ? owner.biography : prev.bio || '',
        externalUrl: owner.external_url || prev.externalUrl || '',
        pfpUrl:
          owner.hd_profile_pic_url_info?.url ||
          owner.profile_pic_url_hd ||
          owner.profile_pic_url ||
          prev.pfpUrl ||
          '',
      };
      userCache.set(username.toLowerCase(), userEntry);
      emit('user', userEntry);
    }

    if (code) {
      const slides = [];

      if (Array.isArray(node.carousel_media) && node.carousel_media.length > 0) {
        for (const item of node.carousel_media) {
          const videoUrl = pickBestVideo(item.video_versions);
          const imageUrl = pickBestCandidate(item.image_versions2?.candidates);
          if (videoUrl) {
            slides.push({ type: 'video', url: videoUrl, poster: imageUrl });
          } else if (imageUrl) {
            slides.push({ type: 'image', url: imageUrl, poster: imageUrl });
          }
        }
      } else if (Array.isArray(node.edge_sidecar_to_children?.edges)) {
        for (const edge of node.edge_sidecar_to_children.edges) {
          const child = edge?.node;
          if (!child) continue;
          if (child.is_video && child.video_url) {
            slides.push({
              type: 'video',
              url: child.video_url,
              poster: child.display_url,
            });
          } else if (child.display_url) {
            slides.push({
              type: 'image',
              url: child.display_url,
              poster: child.display_url,
            });
          }
        }
      } else {
        const videoUrl = pickBestVideo(node.video_versions) || node.video_url;
        const imageUrl =
          pickBestCandidate(node.image_versions2?.candidates) || node.display_url;
        if (videoUrl) {
          slides.push({ type: 'video', url: videoUrl, poster: imageUrl });
        } else if (imageUrl) {
          slides.push({ type: 'image', url: imageUrl, poster: imageUrl });
        }
      }

      if (slides.length > 0) {
        const existing = mediaCache.get(code);
        const caption =
          node.caption?.text ||
          node.edge_media_to_caption?.edges?.[0]?.node?.text ||
          existing?.caption ||
          '';
        if (!existing || slides.length >= existing.slides.length) {
          const entry = {
            code,
            id: id ? String(id) : code,
            username: username || existing?.username || '',
            fullName: owner.full_name || existing?.fullName || '',
            caption,
            slides,
          };
          mediaCache.set(code, entry);
          emit('media', entry);
        }
      }
    }
  }

  function walkObject(obj, depth = 0, seen = new WeakSet()) {
    if (!obj || typeof obj !== 'object' || depth > 10) return;
    if (seen.has(obj)) return;
    seen.add(obj);

    if (Array.isArray(obj)) {
      for (const item of obj) {
        walkObject(item, depth + 1, seen);
      }
      return;
    }

    if (Array.isArray(obj.items) && (obj.id || obj.reel_type || obj.user)) {
      extractReelTray(obj);
    }

    if (obj.code || obj.shortcode) {
      extractMediaItem(obj);
    }

    if (
      obj.username &&
      (obj.biography !== undefined ||
        obj.profile_pic_url_hd ||
        obj.hd_profile_pic_url_info)
    ) {
      const prev = userCache.get(obj.username.toLowerCase()) || {};
      const userEntry = {
        username: obj.username,
        id: String(obj.pk || obj.id || prev.id || ''),
        fullName: obj.full_name || prev.fullName || '',
        bio: obj.biography !== undefined ? obj.biography : prev.bio || '',
        externalUrl: obj.external_url || prev.externalUrl || '',
        pfpUrl:
          obj.hd_profile_pic_url_info?.url ||
          obj.profile_pic_url_hd ||
          obj.profile_pic_url ||
          prev.pfpUrl ||
          '',
      };
      userCache.set(obj.username.toLowerCase(), userEntry);
      emit('user', userEntry);
    }

    for (const key of Object.keys(obj)) {
      if (key === 'return' || key === '_owner' || key === 'stateNode') continue;
      const val = obj[key];
      if (val && typeof val === 'object') {
        walkObject(val, depth + 1, seen);
      }
    }
  }

  function inspectPayloadText(text) {
    if (!text || typeof text !== 'string') return;
    try {
      const cleaned = text.startsWith('for (;;);') ? text.slice(9) : text;
      const json = JSON.parse(cleaned);
      walkObject(json, 0);
    } catch {
      // Ignore non-JSON payloads
    }
  }

  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await origFetch.apply(this, args);
    try {
      const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
      if (
        url.includes('/graphql') ||
        url.includes('/api/v1/') ||
        url.includes('query_hash')
      ) {
        const clone = res.clone();
        clone.text().then(inspectPayloadText).catch(() => {});
      }
    } catch {
      // Ignore interceptor errors
    }
    return res;
  };

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__instakitUrl = typeof url === 'string' ? url : '';
    return origOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener('load', function () {
      try {
        const url = this.__instakitUrl || '';
        if (
          url.includes('/graphql') ||
          url.includes('/api/v1/') ||
          url.includes('query_hash')
        ) {
          if (typeof this.responseText === 'string') {
            inspectPayloadText(this.responseText);
          }
        }
      } catch {
        // Ignore
      }
    });
    return origSend.apply(this, args);
  };

  function scanReactNodes(selector) {
    document.querySelectorAll(selector).forEach((el) => {
      const propKey = Object.keys(el).find(
        (k) => k.startsWith('__reactProps') || k.startsWith('__reactFiber')
      );
      if (propKey) walkObject(el[propKey], 4);
    });
  }

  async function resolveOnDemand(kind, key) {
    if (kind === 'post') {
      if (mediaCache.get(key)?.slides?.length > 0) return mediaCache.get(key);
      scanReactNodes('article, section, main');
      if (mediaCache.get(key)?.slides?.length > 0) return mediaCache.get(key);
      try {
        const res = await origFetch(`https://www.instagram.com/p/${key}/?__a=1&__d=dis`, {
          credentials: 'include',
          headers: { 'x-ig-app-id': '936619743392459' },
        });
        if (res.ok) inspectPayloadText(await res.text());
      } catch {
        // Ignore
      }
      return mediaCache.get(key) || null;
    }

    if (kind === 'user') {
      const lower = String(key || '').toLowerCase();
      const existing = userCache.get(lower);
      if (existing && (existing.bio || existing.pfpUrl)) return existing;
      try {
        const res = await origFetch(
          `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(
            key
          )}`,
          {
            credentials: 'include',
            headers: { 'x-ig-app-id': '936619743392459' },
          }
        );
        if (res.ok) inspectPayloadText(await res.text());
      } catch {
        // Ignore
      }
      return userCache.get(lower) || null;
    }

    if (kind === 'highlight') {
      const cacheKey = `highlight:${key}`;
      if (storyCache.get(cacheKey)?.items?.length > 0) return storyCache.get(cacheKey);
      scanReactNodes('section');
      if (storyCache.get(cacheKey)?.items?.length > 0) return storyCache.get(cacheKey);
      try {
        const res = await origFetch(
          `https://www.instagram.com/api/v1/feed/reels_media/?reel_ids=highlight:${key}`,
          {
            credentials: 'include',
            headers: { 'x-ig-app-id': '936619743392459' },
          }
        );
        if (res.ok) inspectPayloadText(await res.text());
      } catch {
        // Ignore
      }
      return storyCache.get(cacheKey) || null;
    }

    if (kind === 'story') {
      const lower = String(key || '').toLowerCase();
      const cacheKey = `user:${lower}`;
      if (storyCache.get(cacheKey)?.items?.length > 0) return storyCache.get(cacheKey);
      scanReactNodes('section');
      if (storyCache.get(cacheKey)?.items?.length > 0) return storyCache.get(cacheKey);

      let cachedUser = userCache.get(lower);
      if (!cachedUser?.id) {
        cachedUser = await resolveOnDemand('user', key);
      }
      if (cachedUser?.id) {
        try {
          const res = await origFetch(
            `https://www.instagram.com/api/v1/feed/reels_media/?reel_ids=${cachedUser.id}`,
            {
              credentials: 'include',
              headers: { 'x-ig-app-id': '936619743392459' },
            }
          );
          if (res.ok) inspectPayloadText(await res.text());
        } catch {
          // Ignore
        }
      }
      return storyCache.get(cacheKey) || null;
    }

    return null;
  }

  window.addEventListener('instakit:resolve-media', async (e) => {
    const { requestId, kind, key } = e.detail || {};
    const result = await resolveOnDemand(kind, key);
    window.dispatchEvent(
      new CustomEvent('instakit:resolve-result', {
        detail: { requestId, result },
      })
    );
  });

  window.addEventListener('DOMContentLoaded', () => {
    const scripts = document.querySelectorAll('script[type="application/json"]');
    scripts.forEach((s) => inspectPayloadText(s.textContent));
  });
})();
