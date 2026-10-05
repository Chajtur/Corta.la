let recaptchaLoadPromise;
let isRegistering = false;
let currentUser = null;

function loadRecaptcha(siteKey) {
  if (typeof grecaptcha !== 'undefined') return Promise.resolve();
  if (!recaptchaLoadPromise) {
    recaptchaLoadPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = `https://www.google.com/recaptcha/api.js?render=${encodeURIComponent(siteKey)}`;
      script.onload = resolve;
      script.onerror = () => reject(new Error('No se pudo cargar reCAPTCHA'));
      document.head.appendChild(script);
    });
  }
  return recaptchaLoadPromise;
}

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
  if (response.status === 204) return null;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Error ${response.status}`);
  return data;
}

function showMessage(el, text, type = 'error') {
  el.textContent = text;
  el.className = `message ${type}`;
}

function dateLabel(value) {
  if (!value) return 'Sin vencimiento';
  const dateOnly = typeof value === 'string' && /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const date = dateOnly ? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3])) : new Date(value);
  return date.toLocaleDateString('es-HN', { year: 'numeric', month: 'short', day: 'numeric' });
}

function renderDashboard(urls, freeUrlDays) {
  const list = document.getElementById('url-list');
  list.replaceChildren();
  document.getElementById('plan-note').textContent = `Los enlaces gratuitos vencen ${freeUrlDays} días después de crearse. El plan pagado conserva los enlaces sin vencimiento.`;
  if (!urls.length) {
    const empty = document.createElement('p');
    empty.className = 'muted empty-state';
    empty.textContent = 'Aún no tienes enlaces guardados. Crea uno arriba con tu sesión iniciada.';
    list.append(empty);
    return;
  }

  for (const url of urls) {
    const card = document.createElement('article');
    card.className = 'url-card';
    const details = document.createElement('div');
    const short = document.createElement('a');
    short.className = 'url-short';
    short.href = `/${encodeURIComponent(url.code)}`;
    short.textContent = `${location.origin}/${url.code}`;
    short.target = '_blank';
    short.rel = 'noopener';
    const target = document.createElement('p');
    target.className = 'url-target';
    target.textContent = url.original_url;
    const meta = document.createElement('p');
    meta.className = 'muted';
    meta.textContent = `${Number(url.clicks).toLocaleString('es-HN')} clics · ${url.plan === 'paid' ? 'Pagado · sin vencimiento' : `Gratis · vence ${dateLabel(url.expires_at)}`}${url.expired ? ' · Caducado' : ''}`;
    details.append(short, target, meta);
    const statsButton = document.createElement('button');
    statsButton.type = 'button';
    statsButton.className = 'button button-secondary stats-button';
    statsButton.textContent = 'Ver clics';
    statsButton.addEventListener('click', async () => {
      try {
        const stats = await api(`/api/my/urls/${url.id}/stats`);
        const byDay = stats.daily_clicks.map((item) => `${dateLabel(item.date)}: ${Number(item.clicks).toLocaleString('es-HN')}`).join(' · ');
        showMessage(meta, byDay ? `Clics recientes — ${byDay}` : `${stats.clicks_total} clics. Aún no hay actividad reciente.`, 'info');
      } catch (error) { showMessage(meta, error.message); }
    });
    const removeButton = document.createElement('button');
    removeButton.type = 'button';
    removeButton.className = 'text-button';
    removeButton.textContent = 'Eliminar';
    removeButton.addEventListener('click', async () => {
      if (!window.confirm(`¿Eliminar el enlace ${url.code}? Esta acción no se puede deshacer.`)) return;
      try {
        await api(`/api/my/urls/${url.id}`, { method: 'DELETE' });
        card.remove();
        if (!list.children.length) renderDashboard([], freeUrlDays);
      } catch (error) { showMessage(meta, error.message); }
    });
    const actions = document.createElement('div');
    actions.className = 'url-actions';
    actions.append(statsButton, removeButton);
    card.append(details, actions);
    list.append(card);
  }
}

async function refreshAccount() {
  const authView = document.getElementById('auth-view');
  const dashboardView = document.getElementById('dashboard-view');
  try {
    const { user } = await api('/api/me');
    if (!user) {
      currentUser = null;
      dashboardView.classList.add('hidden');
      authView.classList.remove('hidden');
      return;
    }
    currentUser = user;
    authView.classList.add('hidden');
    dashboardView.classList.remove('hidden');
    document.getElementById('account-email').textContent = user.email;
    const { urls, freeUrlDays } = await api('/api/my/urls');
    renderDashboard(urls, freeUrlDays);
  } catch {
    currentUser = null;
    dashboardView.classList.add('hidden');
    authView.classList.remove('hidden');
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  const form = document.getElementById('shorten-form');
  const input = document.getElementById('url-input');
  const aliasInput = document.getElementById('alias-input');
  const aliasMsg = document.getElementById('alias-msg');
  const result = document.getElementById('result');
  const shortLink = document.getElementById('short-link');
  const expiryNote = document.getElementById('expiry-note');
  const cookieSettingsButton = document.getElementById('cookie-settings');
  cookieSettingsButton.classList.add('hidden');
  const aliasRegex = /^[A-Za-z0-9_-]{4,64}$/;
  let siteKey = null;
  let gaMeasurementId = null;
  const actionFragment = new URLSearchParams(location.hash.slice(1));
  const verificationToken = actionFragment.get('verify');
  const resetToken = actionFragment.get('reset');
  if (verificationToken || resetToken) history.replaceState(null, '', `${location.pathname}${location.search}`);

  function enableAnalytics() {
    if (!gaMeasurementId) return;
    if (window.gtag) {
      window.gtag('consent', 'update', { analytics_storage: 'granted' });
      return;
    }
    const gaScript = document.createElement('script');
    gaScript.async = true;
    gaScript.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(gaMeasurementId)}`;
    document.head.append(gaScript);
    window.dataLayer = window.dataLayer || [];
    window.gtag = function gtag() { window.dataLayer.push(arguments); };
    window.gtag('consent', 'default', { analytics_storage: 'denied' });
    window.gtag('consent', 'update', { analytics_storage: 'granted' });
    window.gtag('js', new Date());
    window.gtag('config', gaMeasurementId);
  }

  try {
    const config = await api('/api/config');
    siteKey = config.recaptchaSiteKey;
    if (config.gaMeasurementId && /^G-[A-Z0-9]+$/.test(config.gaMeasurementId)) {
      gaMeasurementId = config.gaMeasurementId;
      cookieSettingsButton.classList.remove('hidden');
      const consent = localStorage.getItem('cortala-ga-consent');
      const banner = document.getElementById('cookie-banner');
      if (consent === 'accepted') enableAnalytics();
      if (!consent) banner.classList.remove('hidden');
      document.getElementById('cookie-accept').addEventListener('click', () => {
        localStorage.setItem('cortala-ga-consent', 'accepted');
        banner.classList.add('hidden');
        enableAnalytics();
      });
      document.getElementById('cookie-reject').addEventListener('click', () => {
        localStorage.setItem('cortala-ga-consent', 'rejected');
        if (window.gtag) window.gtag('consent', 'update', { analytics_storage: 'denied' });
        banner.classList.add('hidden');
      });
      document.getElementById('cookie-settings').addEventListener('click', () => banner.classList.remove('hidden'));
    }
  } catch { /* The app remains usable if optional analytics config is absent. */ }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const url = input.value.trim();
    const code = aliasInput.value.trim();
    if (code && !aliasRegex.test(code)) return showMessage(aliasMsg, 'Alias inválido. Usa 4–64 letras, números, guiones o guiones bajos.');
    try {
      let recaptchaToken;
      if (siteKey) {
        await loadRecaptcha(siteKey);
        await new Promise((resolve) => grecaptcha.ready(resolve));
        recaptchaToken = await grecaptcha.execute(siteKey, { action: 'shorten' });
      }
      const data = await api('/api/shorten', { method: 'POST', body: JSON.stringify({ url, code: code || undefined, recaptchaToken }) });
      shortLink.href = data.shortUrl;
      shortLink.textContent = data.shortUrl;
      expiryNote.textContent = `Enlace gratuito · vence ${dateLabel(data.expiresAt)}${data.owner ? ' · guardado en tu cuenta' : ' · crea una cuenta para organizar tus enlaces'}`;
      result.classList.remove('hidden');
      showMessage(aliasMsg, '');
      if (window.gtag && localStorage.getItem('cortala-ga-consent') === 'accepted') window.gtag('event', 'shorten_url', { event_category: 'engagement' });
      if (currentUser) await refreshAccount();
    } catch (error) {
      showMessage(aliasMsg, error.message);
    }
  });

  document.getElementById('copy-btn').addEventListener('click', async (event) => {
    try {
      await navigator.clipboard.writeText(shortLink.href);
      event.currentTarget.textContent = 'Copiado';
      setTimeout(() => { event.currentTarget.textContent = 'Copiar'; }, 1800);
    } catch { showMessage(aliasMsg, 'No se pudo copiar el enlace.'); }
  });

  document.getElementById('check-alias').addEventListener('click', async () => {
    const code = aliasInput.value.trim();
    if (!aliasRegex.test(code)) return showMessage(aliasMsg, 'El alias debe tener entre 4 y 64 caracteres.');
    try {
      const data = await api(`/api/check/${encodeURIComponent(code)}`);
      showMessage(aliasMsg, data.available ? 'Alias disponible ✓' : 'Alias no disponible.', data.available ? 'success' : 'error');
    } catch (error) { showMessage(aliasMsg, error.message); }
  });

  document.getElementById('auth-toggle').addEventListener('click', () => {
    isRegistering = !isRegistering;
    document.getElementById('auth-submit').textContent = isRegistering ? 'Crear cuenta' : 'Iniciar sesión';
    document.getElementById('auth-toggle').textContent = isRegistering ? 'Ya tengo cuenta' : 'Crear cuenta';
    document.getElementById('password-input').autocomplete = isRegistering ? 'new-password' : 'current-password';
    document.getElementById('auth-message').textContent = '';
  });

  document.getElementById('auth-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const authMessage = document.getElementById('auth-message');
    const email = document.getElementById('email-input').value.trim();
    const password = document.getElementById('password-input').value;
    try {
      const registering = isRegistering;
      const endpoint = registering ? '/api/auth/register' : '/api/auth/login';
      const data = await api(endpoint, { method: 'POST', body: JSON.stringify({ email, password }) });
      if (window.gtag && localStorage.getItem('cortala-ga-consent') === 'accepted') window.gtag('event', registering ? 'sign_up' : 'login', { method: 'email' });
      if (registering) {
        document.getElementById('password-input').value = '';
        showMessage(authMessage, data.message, 'success');
      } else {
        await refreshAccount();
      }
    } catch (error) { showMessage(authMessage, error.message); }
  });

  document.getElementById('resend-verification').addEventListener('click', async () => {
    const authMessage = document.getElementById('auth-message');
    try {
      const data = await api('/api/auth/resend-verification', { method: 'POST', body: JSON.stringify({ email: document.getElementById('email-input').value.trim() }) });
      showMessage(authMessage, data.message, 'success');
    } catch (error) { showMessage(authMessage, error.message); }
  });

  document.getElementById('forgot-password').addEventListener('click', async () => {
    const authMessage = document.getElementById('auth-message');
    try {
      const data = await api('/api/auth/forgot-password', { method: 'POST', body: JSON.stringify({ email: document.getElementById('email-input').value.trim() }) });
      showMessage(authMessage, data.message, 'success');
    } catch (error) { showMessage(authMessage, error.message); }
  });

  const resetPasswordForm = document.getElementById('reset-password-form');
  resetPasswordForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const data = await api('/api/auth/reset-password', { method: 'POST', body: JSON.stringify({ token: resetToken, password: document.getElementById('new-password-input').value }) });
      resetPasswordForm.classList.add('hidden');
      document.getElementById('auth-form').classList.remove('hidden');
      isRegistering = false;
      document.getElementById('auth-submit').textContent = 'Iniciar sesión';
      document.getElementById('auth-toggle').textContent = 'Crear cuenta';
      showMessage(document.getElementById('auth-message'), data.message, 'success');
    } catch (error) { showMessage(document.getElementById('reset-message'), error.message); }
  });

  document.getElementById('back-to-login').addEventListener('click', () => {
    resetPasswordForm.classList.add('hidden');
    document.getElementById('auth-form').classList.remove('hidden');
    history.replaceState(null, '', `${location.pathname}${location.search}`);
  });

  document.getElementById('logout-btn').addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST' });
    await refreshAccount();
  });

  if (verificationToken) {
    try {
      const data = await api('/api/auth/verify-email', { method: 'POST', body: JSON.stringify({ token: verificationToken }) });
      showMessage(document.getElementById('auth-message'), data.message, 'success');
    } catch (error) { showMessage(document.getElementById('auth-message'), error.message); }
  } else if (resetToken) {
    document.getElementById('auth-form').classList.add('hidden');
    resetPasswordForm.classList.remove('hidden');
  }

  if (!resetToken) await refreshAccount();
});
