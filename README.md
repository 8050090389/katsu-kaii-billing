# Masala Mafia Billing (v1.2)

Billing, kitchen slips, stock, expenses, monthly bills planner and reports for Katsu Kaii by Masala Mafia.
Runs in the browser on the counter tablet and on admin phones. All devices share one server.

## Start it (Windows)
1. Install Node.js LTS from nodejs.org (version 22.13 or newer). Skip the optional "Tools for Native Modules" step.
2. Right-click the zip, **Extract All**, open the new folder.
3. **Double-click `start.bat`.** A black window opens, the browser opens by itself.
4. Log in with `admin` / `admin123`. The red banner will ask you to change the password. Do it first.
5. Keep the black window open while the shop is working. Closing it stops the software.

The black window also prints the address phones should use on the same Wi-Fi, for example `http://192.168.1.5:3000`.

## Load your menu (first time)
1. Log in as admin, open **Menu**.
2. Press **Load my menu**. It adds all 43 Katsu Kaii dishes in 8 sections and hides the 6 sample dishes.
3. In **Set prices**, type a price for each dish (Enter jumps to the next box), check Veg / Non-veg, press **Save all prices**.
A dish only appears on the counter once it has a price, so nothing can be sold at Rs 0. You can come back to this table any time to change prices.

## Update to a new version
1. Close the black window.
2. Extract the new zip **into the same folder** and choose **Replace all files**. Your bills are in `data.db` and the zip does not contain it, so nothing is lost.
3. Double-click `start.bat`, then press **Ctrl + Shift + R** in the browser.

## What it does
- **Counter**: dine-in tables, takeaway, Zomato/Swiggy/other platform orders, split payments (cash, UPI, card, platform)
- **GST**: 5% as 2.5% CGST + 2.5% SGST, discount, round-off, bill numbers like `KK/2026-27/0001` (restart each April)
- **KOT**: kitchen slip prints only new items when you add to a running table
- **Printing**: 58 mm or 80 mm thermal receipts (Settings), reprint any bill
- **Dashboard**: today and month sales, 7-day chart, bills due, low stock, unbilled orders
- **Inventory + recipes**: stock in and out; tell it what one plate uses and stock drops by itself when a bill is paid
- **Expenses**: rent, electricity, water, staff and chef salary, raw material and more, with CSV export
- **Monthly planner**: list your fixed monthly costs with due days, see what is still to pay, how much to keep aside per day, mark paid (adds to Expenses)
- **Day close**: count the cash drawer, see if it matches, note the money set aside for bills
- **Reports**: daily and monthly sales, payment split, channel split, GST summary, top items, profit, CSV, financial-year pack
- **Income-tax estimate**: shows the Sec 44AD presumptive figure (6% of digital receipts, 8% of cash) next to your actual profit, for your CA
- **Logins**: Admin sees everything. Cashier can only bill and use stock.
- **Backups**: a copy is saved every day in the `backups` folder (last 14 days), plus a Download backup button in Settings

The software prepares numbers for your CA. It does not file GST returns or income-tax returns.

## Printer
- Windows PC with a USB or LAN 80 mm thermal printer: install the printer driver, set it as default. In the print window set margins to *None* and turn off headers and footers. Chrome started with `--kiosk-printing` prints without the window.
- Android tablet with a Bluetooth 58 mm printer: install the printer's print app (or RawBT) and pick it in the print window.
- Set the paper width in **Settings**, then press **Test print**.

## Restore from a backup
Close the black window. Copy a file from the `backups` folder (or a downloaded backup), rename it to `data.db`, put it in the main folder (delete `data.db-wal` and `data.db-shm` there), then run `start.bat`.

## Put it online later (all devices from anywhere)
Run it on a small always-on Linux server (a VPS with a persistent disk) with Node 22.13+: `npm install --omit=dev`, then `node server.js` under `pm2`, with HTTPS in front (Caddy). Set `ADMIN_PASSWORD`, `DB_PATH` and `PORT` as environment variables. Keep `data.db` on the persistent disk.

## Tests
`npm test` runs end-to-end checks of GST math, payments, KOT, stock, planner, day close, tax estimate, backup and role permissions.
