fetch('/api/runtime').then(r => r.json()).then(runtime => {
  if (runtime.publicSiteOrigin) {
    const url = new URL(runtime.publicSiteOrigin);
    if (['https:', 'http:'].includes(url.protocol)) {
      document.querySelectorAll('a[href="/"]').forEach(link => { link.href = url.origin; });
    }
  }
  if (runtime.mode !== 'demo') return;
  const banner = document.createElement('aside');
  banner.className = 'demo-banner';
  banner.textContent = 'DEMO · Fictional accounts and armory fixtures · Discord disabled';
  document.body.prepend(banner);
}).catch(() => {});
