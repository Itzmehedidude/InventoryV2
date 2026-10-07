# InventoryV2 — Supabase Realtime Final

## Included
- Supabase email/password authentication
- One-time auth initialization using Supabase INITIAL_SESSION
- Clear signup/login errors
- PostgreSQL shared inventory
- Row Level Security
- Realtime product and sales updates
- IndexedDB offline cache
- Offline product/sale queue
- Atomic PostgreSQL stock sale transaction
- Dashboard, inventory, sales history and reports
- GitHub Pages compatible PWA

## Supabase setup
1. Open Supabase Dashboard → SQL Editor.
2. Run `supabase/schema.sql` completely.
3. In Authentication → URL Configuration, set the Site URL to your GitHub Pages URL, for example:
   `https://YOUR_USERNAME.github.io/InventoryV2/`
4. Add the same URL as an allowed redirect URL.
5. Put your project URL and Publishable key in `config.js`.
6. Upload the project files to the GitHub repository root.

## Important
Use the Publishable key in `config.js`, never a secret/service-role key. RLS protects the database.

## Refresh/request behavior
The app no longer calls `getSession()` plus an auth listener. It uses Supabase's `INITIAL_SESSION` event as the single startup auth path. Realtime events update the local cache directly instead of re-downloading both tables after every event.

## Realtime
The SQL adds `products` and `sales` to `supabase_realtime`. Realtime is scoped by `user_id` and RLS.
