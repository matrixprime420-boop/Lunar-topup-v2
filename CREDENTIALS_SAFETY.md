# Credential safety and Firebase project selection

The user selected Firebase project `lunar-topup`. This package now validates that `FIREBASE_SERVICE_ACCOUNT_JSON.project_id` is exactly `lunar-topup` and requires `FIREBASE_DATABASE_URL` to be explicitly set.

The service-account private key pasted into chat is compromised. Revoke/delete that key in Google Cloud Console → IAM & Admin → Service Accounts → the `firebase-adminsdk-fbsvc@lunar-topup.iam.gserviceaccount.com` account → Keys. Generate a fresh key from project `lunar-topup`; never put the JSON in GitHub or chat.

Copy the exact Realtime Database URL and Storage bucket shown in Firebase Console for `lunar-topup`. Do not guess the database hostname or bucket. Set them in Render Environment. The service account JSON must have `project_id: lunar-topup`.
