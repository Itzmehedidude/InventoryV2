# StockFlow (InventoryV2) v4
Original StockFlow design + Supabase login, shared cloud inventory, realtime sync and offline queue.

## Upgrade steps (IMPORTANT)
1. Supabase → SQL Editor → paste ALL of `supabase/schema.sql` → Run. Safe to run again; keeps your data.
2. Upload every file in this folder to the GitHub repo root (replace old ones).
3. Hard-refresh the site.

## New in v4
- Delete products (past sales are kept in history)
- Inventory: In Stock / Stock Out tabs (a product moves to Stock Out automatically at 0 units)
- Return a sale: restores stock, keeps the record, excluded from revenue
- Optional customer name + contact on sales
- Dashboard: bigger recent-sales table, eye icon to hide/show figures
- Reports: today / yesterday / all-time revenue, returns
