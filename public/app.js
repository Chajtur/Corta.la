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
