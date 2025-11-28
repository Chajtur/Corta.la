document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('shorten-form');
  const input = document.getElementById('url-input');
  const aliasInput = document.getElementById('alias-input');
  const checkAliasBtn = document.getElementById('check-alias');
  const aliasMsg = document.getElementById('alias-msg');
  const result = document.getElementById('result');
  const shortLink = document.getElementById('short-link');
  const copyBtn = document.getElementById('copy-btn');
  const statsLink = document.getElementById('stats-link');

  // Client-side alias pattern validation (same as server): letters, numbers, - _ , 4-64 chars
  const aliasRegex = /^[A-Za-z0-9_-]{4,64}$/;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const url = input.value.trim();
    const requestedAlias = aliasInput ? aliasInput.value.trim() : '';
    if (!url) return;
    try {
      // validate alias client-side first
      if (requestedAlias && !aliasRegex.test(requestedAlias)) {
        alert('Alias inválido. Solo letras, números, - y _. Longitud 4-64.');
        return;
      }

      // check recaptcha config
      let recaptchaToken;
      try {
        const cfg = await fetch('/api/config').then(r => r.json());
        if (cfg.recaptchaSiteKey) {
          // load grecaptcha if needed
          if (typeof grecaptcha === 'undefined') {
            const s = document.createElement('script');
            s.src = `https://www.google.com/recaptcha/api.js?render=${cfg.recaptchaSiteKey}`;
            document.head.appendChild(s);
            // wait briefly for script to load
            await new Promise(r => setTimeout(r, 600));
          }
          if (typeof grecaptcha !== 'undefined') {
            recaptchaToken = await grecaptcha.execute(cfg.recaptchaSiteKey, { action: 'shorten' });
          }
        }
      } catch (err) {
        // ignore config errors
      }

      const res = await fetch('/api/shorten', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, code: requestedAlias || undefined, recaptchaToken })
      });

      // If the response is not JSON (e.g. 404 from static server), read text for better error
      const contentType = res.headers.get('content-type') || '';
      let data;
      if (contentType.includes('application/json')) {
        data = await res.json();
      } else {
        const text = await res.text();
        throw new Error(text || `HTTP ${res.status} ${res.statusText}`);
      }
      if (!res.ok) throw new Error(data.error || 'Error');
      shortLink.textContent = data.shortUrl;
      shortLink.setAttribute('data-url', data.shortUrl);
      shortLink.innerHTML = `<a href="${data.shortUrl}" target="_blank">${data.shortUrl}</a>`;
      statsLink.href = `/api/stats/${data.code}`;
      result.classList.remove('hidden');
    } catch (err) {
      alert('Error: ' + err.message);
    }
  });

  copyBtn.addEventListener('click', async () => {
    const url = shortLink.getAttribute('data-url');
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      copyBtn.textContent = 'Copiado';
      setTimeout(() => (copyBtn.textContent = 'Copiar'), 2000);
    } catch (err) {
      alert('No se pudo copiar');
    }
  });

  // alias availability
  if (checkAliasBtn && aliasInput) {
    checkAliasBtn.addEventListener('click', async () => {
      const code = aliasInput.value.trim();
      aliasMsg.className = 'hidden';
      if (!code) {
        aliasMsg.textContent = 'Escribe un alias para comprobar.';
        aliasMsg.classList.remove('hidden');
        aliasMsg.classList.add('unavailable');
        return;
      }
      try {
        const res = await fetch(`/api/check/${encodeURIComponent(code)}`);
        const data = await res.json();
        if (res.ok) {
          if (data.available) {
            aliasMsg.textContent = 'Alias disponible ✓';
            aliasMsg.className = 'available';
          } else {
            aliasMsg.textContent = 'X Alias no disponible';
            aliasMsg.className = 'unavailable';
          }
        } else {
          aliasMsg.textContent = data.error || 'Error comprobando alias';
          aliasMsg.className = 'unavailable';
        }
      } catch (err) {
        aliasMsg.textContent = 'Error de red';
        aliasMsg.className = 'unavailable';
      }
      aliasMsg.classList.remove('hidden');
    });
  }
});
document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('shorten-form');
  const input = document.getElementById('url-input');
  const result = document.getElementById('result');
  const shortLink = document.getElementById('short-link');
  const copyBtn = document.getElementById('copy-btn');
  const statsLink = document.getElementById('stats-link');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const url = input.value.trim();
    if (!url) return;
    try {
      const res = await fetch('/api/shorten', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error');
      shortLink.textContent = data.shortUrl;
      shortLink.setAttribute('data-url', data.shortUrl);
      shortLink.innerHTML = `<a href="${data.shortUrl}" target="_blank">${data.shortUrl}</a>`;
      statsLink.href = `/api/stats/${data.code}`;
      result.classList.remove('hidden');
    } catch (err) {
      alert('Error: ' + err.message);
    }
  });

  copyBtn.addEventListener('click', async () => {
    const url = shortLink.getAttribute('data-url');
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      copyBtn.textContent = 'Copiado';
      setTimeout(() => (copyBtn.textContent = 'Copiar'), 2000);
    } catch (err) {
      alert('No se pudo copiar');
    }
  });
});
