# LUNAR TOPUP — Render deployment package

> **Credential safety notice (2026-11-14):** The service-account private key previously pasted in chat is compromised. Revoke/delete that key in Google Cloud IAM and generate a fresh key from Firebase project `lunar-topup`. The old key is intentionally not included in this ZIP. Never commit service-account JSON or a populated `.env` file to GitHub.

A mobile-first Free Fire top-up storefront and admin dashboard based on the supplied LUNAR TOPUP HTML files. The browser pages are served by an Express backend; authentication, order/payment mutations, API credentials and Firebase access are handled server-side.

## Included

- `public/index.html` — storefront, login/signup, categories, diamond packages, live recent orders, account profile editor, wallet top-up UI, My Orders, codes and Lunar Topup (AI) chat.
- `public/admin.html` — protected admin login, dashboard metrics, package stock in/out, categories and account-field settings, user search/detail/ban/unban/profile edit, wallet adjustments, deposits, orders, notice and secret settings.
- `server.js` — Express API, server-side bcrypt password hashes, secure sessions stored in Firebase RTDB, encrypted API secrets, GamesKinbo UID proxy, order and wallet transactions, payment gateway adapter, AI proxy and server-sent live updates.
- `database.rules.json` — deny public browser access to Realtime Database. Firebase Admin SDK on the server uses a service account and bypasses client rules.
- `render.yaml` — Render Blueprint service definition.
- `.env.example` — environment variable reference. Do not upload an actual `.env` or service-account JSON file.

## Before deployment

**This ZIP is source-complete, but one external integration is intentionally not marked live:** ZR PAY BD did not expose a readable create/verify API contract during preparation. The supplied endpoints responded to GET requests with 404 and the merchant portal requires sign-in. Therefore, the adapter is present but requires the exact request/response contract from ZR PAY support before it can safely create and verify payments. It will return `ZRPAY_SETUP_INCOMPLETE` instead of pretending a deposit was paid. Do not enable live customer deposits until this section is configured and tested.

GamesKinbo's documented lookup is proxied on the server. Add the API key through Admin → Settings → GamesKinbo; it is encrypted in RTDB and is never sent to the browser. The public free tier can be rate-limited and is controlled by GamesKinbo.

AI chat also requires a provider key. Add the key through Admin → Settings → AI Chat. This is an OpenAI-compatible chat-completions endpoint; choose a provider/model you are authorized to use.

## 1. Firebase setup

This package is now configured for the Firebase project you selected:

- Project ID: `lunar-topup`
- Realtime Database URL: **must be copied from the `lunar-topup` Firebase Console** (the exact URL may be regional)
- Existing application data root: `/nbh`

1. Open Firebase Console → project `lunar-topup` → Realtime Database and copy the exact database URL shown there.
2. In Project Settings → Service accounts, revoke/delete the previously exposed key, then generate a fresh private key for the server. Confirm its `project_id` is `lunar-topup`. Keep the downloaded JSON private.
3. In Realtime Database → Rules, use the rules from `database.rules.json` (deny direct client reads/writes). The Express server uses Firebase Admin credentials, so it can access the DB while public browser clients cannot.
4. Do not commit the service-account JSON to GitHub. Paste the full JSON string into Render's `FIREBASE_SERVICE_ACCOUNT_JSON` environment variable.
5. Back up the database before first deployment. The application keeps its existing `/nbh` data structure and adds server-managed session records under `/_lunarSessions`.

Example rules are in `database.rules.json`:

```json
{
  "rules": {
    ".read": false,
    ".write": false
  }
}
```

## 2. GitHub and Render

1. Extract the ZIP on your computer.
2. Create a **private** GitHub repository (recommended because this is a payment/admin application).
3. Upload the contents of this folder to the repository root. The root must contain `package.json`, `server.js`, `render.yaml`, and `public/`.
4. In Render, choose **New → Blueprint** and connect that repository, or create a **New Web Service** from the repository.
5. Use:
   - Runtime: Node
   - Build command: `npm install`
   - Start command: `npm start`
   - Health check path: `/health`
6. Configure the environment variables listed below, then deploy.
7. Open `https://YOUR-RENDER-SERVICE.onrender.com/` for the storefront and `/admin` for the admin dashboard.

## 3. Required Render environment variables

Set these in Render → Service → Environment. Do not add secrets to source files.

| Variable | Required | Value |
|---|---:|---|
| `NODE_ENV` | yes | `production` |
| `SESSION_SECRET` | yes | Random secret at least 32 characters |
| `APP_ENCRYPTION_KEY` | yes | Separate random secret at least 32 characters; keep stable after saving encrypted keys |
| `ADMIN_USERNAME` | yes | Your chosen admin username |
| `ADMIN_PASSWORD` | yes | Strong unique password, minimum 12 characters |
| `FIREBASE_DATABASE_URL` | yes | Exact Realtime Database URL copied from Firebase Console → `lunar-topup` → Realtime Database |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | yes | Complete service-account JSON from the matching Firebase project |
| `FIREBASE_STORAGE_BUCKET` | optional | Exact Storage bucket shown in Firebase Console for `lunar-topup` (optional if Storage is unused) |
| `PORT` | no | Render injects this automatically |

Generate random values in PowerShell:

```powershell
[Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(48))
[Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(48))
```

Use a different output for `SESSION_SECRET` and `APP_ENCRYPTION_KEY`. Save the encryption key in a password manager and do not rotate it after storing encrypted API keys unless you first decrypt/re-encrypt those values. Losing it makes those saved secrets unreadable.

`FIREBASE_SERVICE_ACCOUNT_JSON` must be the **full private service-account JSON**, not `{}` and not the public Firebase web config. Keep it private.

## 4. First admin login

1. Open `/admin`.
2. Sign in with `ADMIN_USERNAME` and `ADMIN_PASSWORD` from Render environment variables.
3. Open Settings and save your branding, notices and minimum deposit amount.
4. Under GamesKinbo, paste a freshly rotated API key and save. The backend encrypts it in Firebase.
5. Under AI Chat, set the endpoint/model, paste an API key and save if you want the AI support chat enabled.
6. Under ZR PAY BD, the Brand Key field is stored encrypted. However, a Brand Key by itself is not sufficient: ZR PAY must confirm its API contract first (see below).

## 5. GamesKinbo Free Fire player name/region verification

The server calls the GamesKinbo endpoint over HTTPS with the key in the `x-api-key` header. The storefront only calls `/api/game/lookup?uid=...`; the key stays server-side. The admin can change the key live in Settings without redeploying. The key you placed in chat is **not embedded in this ZIP**; after deployment, enter a newly rotated key through Admin Settings.

The documented service may enforce a free-tier request quota/rate limit. The server also rate-limits the public lookup route. If verification is unavailable or the provider quota is exhausted, the storefront does not treat the ID as verified and the top-up order is blocked for categories requiring UID verification.

## 6. ZR PAY BD — exact information still required

The code contains a safe adapter for these endpoints:

- Create: `https://pay.zrpaybd.xyz/api/payment/create`
- Verify: `https://pay.zrpaybd.xyz/api/payment/verify`

Before live payments are enabled, obtain the following from ZR PAY BD support or the merchant dashboard's API documentation. **Do not send your live Brand Key in chat, GitHub or this document.**

1. Exact authentication header name and format (for example `Authorization: Bearer ...` or a provider-specific header).
2. Exact create-payment HTTP method and JSON request body, including required fields for amount, merchant order ID, customer, return URL and callback URL.
3. A redacted successful create response showing the checkout URL and provider payment ID field names.
4. Exact verify-payment HTTP method and JSON body, including which identifier is used to look up a payment.
5. A redacted successful verify response showing the paid status, exact paid amount, merchant order ID and transaction ID fields.
6. The exact success status value (for example `success`, `paid` or another value).

The adapter's Render variables support JSON templates and response paths. Placeholders in request templates include `{{amount}}`, `{{amount_text}}`, `{{order_id}}`, `{{user_id}}`, `{{name}}`, `{{email}}`, `{{phone}}`, `{{method}}`, `{{payment_method}}`, `{{success_url}}`, `{{cancel_url}}`, `{{callback_url}}` and `{{brand_key}}`. Customers can select one of the payment-method labels configured in Admin Settings; map the selected method to the exact field required by ZR PAY's create API. The create/verify templates, auth header and response mapping must be filled from the provider's actual API contract. Do not guess these names.
After ZR PAY supplies the contract, configure these Render variables from its exact documentation:

| Render variable | Meaning |
|---|---|
| `ZR_PAY_AUTH_HEADER` | Exact auth header name required by ZR PAY |
| `ZR_PAY_AUTH_PREFIX` | Optional prefix (for example, `Bearer `) |
| `ZR_PAY_CREATE_TEMPLATE_JSON` | Exact create-payment JSON body with supported placeholders |
| `ZR_PAY_VERIFY_TEMPLATE_JSON` | Exact verify-payment JSON body with supported placeholders |
| `ZR_PAY_VERIFY_METHOD` | `POST` or the provider-confirmed method |
| `ZR_PAY_REDIRECT_PATH` | Dot path to the HTTPS checkout URL in create response |
| `ZR_PAY_PAYMENT_ID_PATH` | Dot path to payment/invoice ID in create response |
| `ZR_PAY_STATUS_PATH` | Dot path to payment status in verify response |
| `ZR_PAY_AMOUNT_PATH` | Dot path to amount actually paid in verify response |
| `ZR_PAY_TRANSACTION_ID_PATH` | Dot path to provider transaction reference |
| `ZR_PAY_ORDER_ID_PATH` | Dot path to the merchant order ID echoed by the provider |
| `ZR_PAY_SUCCESS_VALUE` | Exact successful status value returned by provider |

`ZR_PAY_CREATE_URL` and `ZR_PAY_VERIFY_URL` default to the two URLs above; override them only if the provider gives you different production/test endpoints. All gateway calls are HTTPS-only.

The wallet is credited only after the server verifies the exact successful status, amount, merchant order reference and transaction ID; repeated verification cannot credit the same pending deposit twice. The callback endpoint only acknowledges receipt until a provider-authenticated webhook contract is supplied. This avoids treating an unverified browser redirect as proof of payment.

## 7. Admin operations and live updates

- Package create/edit/delete and stock in/out are stored in Realtime Database and broadcast to connected storefronts through server-sent events.
- Recent orders are refreshed from the live order feed; public names/IDs are masked.
- Admin user ban blocks login and blocks authenticated API calls for that account. It cannot guarantee that a person cannot register a new account with a different email; that requires a verified identity/phone/anti-abuse policy.
- Admin wallet adjustments and manual deposit approvals are audited and protected against repeat processing. Never manually approve a deposit without independently confirming the money was received.
- Category Account Info fields are JSON. Example:

```json
[
  {"key":"playerId","label":"Player ID","type":"text","placeholder":"Enter Free Fire UID","required":true},
  {"key":"whatsapp","label":"WhatsApp Number","type":"text","placeholder":"01XXXXXXXXX","required":false}
]
```

For categories that are not Free Fire UID top-ups, disable UID verification and define only the fields that category actually needs. If UID verification is enabled, include a numeric `playerId`/`uid` field.

## 8. Existing user migration

The backend supports a one-time migration from the prior client-side SHA-256 password field to bcrypt after a user's first successful login. Do not delete the existing `/nbh/users` records before migration. Admin PIN `NBH` from the old HTML is no longer used; the new admin login is server-side and uses Render credentials.

## 9. QA / readiness checklist

Before accepting real money:

- [ ] Firebase service account is from the same project as the Realtime Database URL.
- [ ] Database rules deny public `.read` and `.write`.
- [ ] `SESSION_SECRET`, `APP_ENCRYPTION_KEY`, `ADMIN_USERNAME`, `ADMIN_PASSWORD` are set.
- [ ] `/health`, storefront `/`, and admin `/admin` load.
- [ ] Test account signup, login, logout and legacy-user password migration.
- [ ] Test admin login and user ban/unban.
- [ ] Test GamesKinbo lookup with a valid UID, invalid UID and rate-limit response.
- [ ] Test package stock in/out and see it update in another browser.
- [ ] Test order creation, completion and rejection/refund exactly once.
- [ ] Complete ZR PAY test-mode create and verify tests with provider-confirmed API mapping.
- [ ] Verify a declined/failed or mismatched-amount payment never increases wallet balance.
- [ ] Configure AI provider and test support chat.
- [ ] Use test credentials/payment mode before production customer funds.

## Known limitations

- Live ZR PAY checkout is not production-enabled until the missing provider API contract is supplied and configured.
- No code can guarantee that a banned person cannot create a new identity/account without a verified identity policy.
- The Admin UI supports a profile picture URL for admin-edited user accounts; end users can upload a compressed image to their own profile.
- The package was statically validated in this environment. It was not connected to your Firebase project, your GamesKinbo key, or your ZR PAY merchant account, so a live end-to-end payment test has not been performed.
