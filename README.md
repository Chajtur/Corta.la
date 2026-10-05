# corta.la

Acortador de URLs con cuentas, panel privado, estadísticas agregadas por enlace y vencimiento configurable.

## Ejecutar localmente

1. Copia `.env.example` a `.env` y configura una base de datos MySQL.
2. Instala dependencias con `npm install`.
3. Inicia con `npm start` (o `npm run dev`).

En desarrollo se puede usar `REQUIRE_CAPTCHA=false`. En producción, configura reCAPTCHA, `SESSION_SECRET` aleatorio y estable, `BASE_URL` y una conexión MySQL persistente. `FREE_URL_TTL_DAYS` determina la duración del plan gratuito (30 días por defecto). El servidor migra las tablas al iniciar; los enlaces gratuitos que ya existían reciben un periodo de gracia completo contado desde esa primera migración para no romperlos de inmediato.

## Funciones disponibles

- `POST /api/shorten` — crea un enlace gratuito; si hay sesión, lo guarda en la cuenta. Responde con `code`, `shortUrl`, `expiresAt` y `owner`.
- `POST /api/auth/register`, `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/me` — registro, acceso y sesión protegida por cookie HttpOnly.
- `GET /api/my/urls` — enlaces, clics, plan y vencimiento del usuario autenticado.
- `GET /api/my/urls/:id/stats` — total de clics y serie diaria, solo para propietario.
- `DELETE /api/my/urls/:id` — elimina el enlace del propietario y sus clics asociados.
- `GET /:code` — redirige con HTTP 302 y registra clics; devuelve HTTP 410 al vencer.
- `GET /api/check/:code` — disponibilidad de alias.
- `GET /api/config` — claves públicas para CAPTCHA/GA4 y duración del plan gratuito.
- `GET /api/admin/urls` — inventario con `x-admin-token`.
- `POST /api/admin/urls/:id/plan` con `{ "plan": "paid" }` o `{ "plan": "free" }` — concesión administrativa del plan. Paid elimina el vencimiento; free vuelve a aplicar el periodo configurado.

El endpoint legado `GET /api/stats/:code` requiere ahora una sesión y propiedad del enlace. Las estadísticas no devuelven IP ni agente de usuario. Las filas históricas todavía contienen esos campos en la base de datos; antes de ofrecer estadísticas detalladas o vender reportes, define retención y elimina/anónimiza esos datos heredados.

## Preparar monetización

- **Suscripción pagada:** el modelo distingue enlaces gratuitos con vencimiento de enlaces pagados indefinidos. Por ahora, el plan pagado solo se concede desde el endpoint de administración; aún no hay checkout, cobros, webhooks, facturación ni cancelaciones. El siguiente paso es elegir el procesador que pueda liquidar en Honduras, implementar webhooks idempotentes y conceder/revocar `paid` desde eventos verificados.
- **Google Analytics 4:** `GA_MEASUREMENT_ID=G-...` habilita Analytics en la página pública y registra carga y evento `shorten_url`. Mide adquisición y conversión del sitio; las visitas a enlaces cortos se miden con la base propia. No se ejecuta Analytics en la redirección, así que la redirección no se demora ni se presenta falsamente como una vista de página.
- **Publicidad:** primero mide visitas y creación de enlaces. Banners en la página principal son de bajo impacto; una página intermedia con anuncios por cada clic podría producir más impresiones, pero cambia la experiencia del producto y requiere reglas claras de exclusión para el plan pagado. No se sirve publicidad hasta integrar un proveedor y definir privacidad, consentimiento y controles contra enlaces maliciosos.
- **Otras opciones:** dominio personalizado, más volumen, métricas y retención extendidas, QR con marca, exportación y equipo son beneficios que se pueden probar con usuarios antes de fijar precios.

GA4 es opcional y solo agrega analítica del sitio cuando se configura la propiedad; el script no se carga hasta que la persona acepta las cookies de analítica. La preferencia se puede cambiar desde el pie de página. Publica una política de privacidad antes de activarlo. Los nuevos registros de clic ya no guardan IP ni agente de usuario; registros históricos pueden contenerlos. Los datos de clic de primera parte tampoco son una medición perfecta de personas únicas: bots, previsualizaciones y escáneres pueden generar clics.

Como punto de partida para Honduras, **Tilopay merece una consulta comercial**: publica una solución regional de suscripciones, reintentos de cobro y webhooks ([producto](https://tilopay.com/en/producto/suscripciones)). Confirma por escrito onboarding de comercios hondureños, banco/liquidación, comisiones, acceso API y condiciones del producto antes de construir la integración. Stripe no incluye Honduras en su [lista actual de países con disponibilidad para pagos](https://stripe.com/global), por lo que no conviene depender de una cuenta local de Stripe sin una estructura comercial elegible en otro país.

## Pendiente antes de cobrar a usuarios

1. Escoger proveedor según disponibilidad de cuenta comercial, liquidación local, moneda y cargos recurrentes en Honduras.
2. Implementar checkout y webhooks firmados con estados de suscripción, reintentos, cancelación, reembolso y periodo de gracia.
3. Añadir verificación de correo, recuperación de contraseña y una política de privacidad/retención de datos.
4. Usar almacenamiento compartido para rate limits al escalar a más de una instancia, y configurar alertas, backups y limpieza de datos vencidos.

## Pruebas

`npm test` ejecuta pruebas de API con una base simulada en memoria. No escribe en la base configurada en `.env`.

Desarrollado por Hondutech.
