# corta.la — URL shortener (scaffold)

Proyecto mínimo para un acortador de URLs con landing page, API y estadísticas.

Instalación (Windows PowerShell):

1) Proveer variables de ambiente para MySQL (puedes crear `.env` con los valores, ejemplo: `.env.example`)

```powershell
cd 'c:\Projects\Corta.la'
npm install
npm start
```

Variables de entorno requeridas (ejemplo — ver `.env.example`):

- `DB_HOST` — host de la base de datos
- `DB_USER` — usuario
- `DB_PASSWORD` — contraseña
- `DB_NAME` — nombre de la base de datos
- `DB_PORT` — puerto (opcional, default 3306)

Puntos principales:
- `POST /api/shorten` { url } => `{ code, shortUrl }`
- `POST /api/shorten` { url, code? } => `{ code, shortUrl }` (opcional `code` para alias personalizado)
- `GET /api/check/:code` => `{ available: true|false }` comprobar disponibilidad de alias
 - `GET /api/config` => `{ recaptchaSiteKey: string | null }` devuelve config pública para el frontend

Admin endpoints (protegidos):
- `GET /api/admin/urls` => lista de URLs (protegido por `ADMIN_TOKEN` via header `x-admin-token` o ?token=)

Protección contra abuso:
- La creación de URLs requiere reCAPTCHA v3 por defecto. Define `RECAPTCHA_SECRET` y `RECAPTCHA_SITE_KEY`; si falta alguna, `POST /api/shorten` responde `503` y no crea enlaces.
- El token debe corresponder a la acción `shorten` y superar `RECAPTCHA_MIN_SCORE` (por defecto `0.7`). Ajusta este valor solo después de revisar falsos positivos.
- Cada IP puede crear 10 URLs por hora por defecto. Configura `SHORTEN_RATE_LIMIT` y `SHORTEN_RATE_WINDOW_MINUTES` para cambiar la cuota y su ventana.
- Define `BLOCKED_URL_HOSTS` como una lista de dominios separada por comas para denegar campañas conocidas, por ejemplo: `BLOCKED_URL_HOSTS=spam.example,baddomain.test`. Los subdominios también se bloquean.
- Durante pruebas locales sin CAPTCHA, establece `REQUIRE_CAPTCHA=false`. No uses ese valor en el servidor público.
- El limitador en memoria es adecuado para una instancia. Con varias instancias o reinicios frecuentes, configura un almacenamiento compartido (por ejemplo Redis) para que el límite por IP sea efectivo en todo el despliegue.
- `GET /:code` => redirección 302 a la URL original (registra click)
- `GET /api/stats/:code` => devuelve metadatos y clicks recientes

Archivos creados:
- `server.js` — servidor Express
- `db.js` — MySQL inicializador y helpers (lee credenciales desde env)
- `public/` — landing: `index.html`, `app.js`, `style.css`

Siguientes pasos sugeridos:
- Protecciones anti-abuso (rate limit, captchas)
- Panel de administración para ver estadísticas y monetizar
- Integración con proveedor de anuncios o banners en el landing
- Dominio y certificados TLS en producción
