# ZR PAY BD integration contract — pending provider documentation

The service already has a server-side adapter for the supplied create and verify endpoints. Live payments must stay disabled until ZR PAY BD confirms this information.

Please obtain from ZR PAY BD support:

- Create request HTTP method, auth header, exact JSON body and successful response JSON (redacted).
- Verify request HTTP method, auth header, exact JSON body and successful response JSON (redacted).
- Exact JSON paths for checkout URL, payment ID, payment status, amount paid, merchant order ID and transaction ID.
- The exact successful status value and whether callbacks are HMAC-signed (including signature header and canonical signing string).
- Whether the create endpoint requires a callback URL and whether server-to-server webhook retries are supported.

Never add the live Brand Key to this file, a Git repository, screenshots or support conversations. Enter it through Admin → Settings or a protected Render environment variable.

Do not rely on a browser redirect or a user-entered TrxID to credit a wallet. The backend only credits after a server-side verify request confirms the expected amount, order reference, success status and transaction reference.
