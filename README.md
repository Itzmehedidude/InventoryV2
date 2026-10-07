# StockFlow — Supabase Edition

GitHub Pages frontend + Supabase Auth/Postgres + IndexedDB offline cache.

## Setup
1. Create a Supabase project.
2. Open Supabase SQL Editor and run `supabase_schema.sql`.
3. Copy `config.example.js` to `config.js`.
4. Put your Supabase Project URL and Publishable Key into `config.js`.
5. In Supabase Authentication settings, configure the Site URL and redirect URL to your GitHub Pages URL.
6. Upload the files to GitHub Pages.

Use only the Supabase **Publishable** key in the browser. Never put a service-role/secret key in `config.js`.

## Authentication
Email/password sign-up, email/password sign-in, persistent sessions and sign-out are included.

## Data model
Each product and sale belongs to the signed-in user. Row Level Security prevents one account from reading another account's data.

## Offline
The app keeps a local IndexedDB cache. If a cloud write fails, it remains locally queued and retries when the device is online.

## Multiple phones
Sign into the same StockFlow account on each phone. The same cloud inventory is then available on all those phones.

This starter syncs when the app opens, when it comes online, and from Settings -> Sync Now. Instant realtime subscriptions can be added next.


## Realtime
The app subscribes to Supabase Postgres Changes for the signed-in user's `products` and `sales` rows. Changes made on another phone are synced into the local cache and the current screen refreshes automatically. Run the updated `supabase/schema.sql` so both tables are in the `supabase_realtime` publication. Supabase notes that Postgres Changes respects RLS for subscribed rows. citeturn0search7turn0search2
