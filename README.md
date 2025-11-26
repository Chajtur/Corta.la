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
