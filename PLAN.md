# Inventorize: Household Supplies & Chores PWA (build plan)

> Status: **Revision 2, approved.** All decisions are in §13. Phase 0 is in progress.

---

## 1. Goals and non-goals

**Goals**
1. **Accurate.** Inventory counts and chore status match reality, even when two people edit at once or a phone is offline.
2. **Very easy to use.** Most interactions take one tap. Nobody has to fill in a form to record that they used the last of the milk.
3. **Transparent.** Everyone in the household can see what needs doing, who is responsible, and by when.
4. **Glanceable.** A wall or counter display shows the household's status, readable from across the room.
5. **Resilient.** It keeps working when the internet is down. Changes reach other devices over home Wi‑Fi or a hotspot, then sync to the cloud when the internet returns.
6. **Historical.** It learns how fast things run out and how chores get shared, and uses that to predict *when* something will be needed.

**Non-goals for v1**: price comparison, grocery-delivery integrations, recipe planning, native app-store apps, multiple households per account. Each can be added later.

---

## 2. Core concepts (user vocabulary)

| Concept | What it means to the user |
|---|---|
| **Household** | Your family's shared space. Everyone invited sees the same data. |
| **Member** | A person: name, colour, avatar or emoji, role (Admin / Member / Viewer). |
| **Item** | A supply you track, e.g. "Milk 1L" in Fridge. It has a count, a **minimum** (reorder point), and a **par** (the full level to restock to). |
| **Location / Category** | Where it lives (Pantry, Bathroom, Garage) and what it is (Dairy, Cleaning). |
| **Shopping list** | Generated automatically from items below their minimum, plus anything added by hand. |
| **Chore** | A routine task with a schedule, e.g. "Take bins out, every Tue 8pm". |
| **Task** | A one-off to-do with a due date, e.g. "Replace HVAC filter by Dec 1". |
| **Responsibility** | Who owns a chore, task, item, or category: one or more members. |
| **Due / Needed-by** | The date by which something must be addressed. For supplies, this is set by hand or **predicted** from how fast the item is used. |

### Status model (applies everywhere)
- 🔴 **Act now**: overdue, out of stock, or needed today.
- 🟠 **Soon**: due or predicted to run out within N days (default 3; configurable).
- 🟢 **OK**: nothing to do.

The dashboard, lists, and notifications all use this three-level status.

---

## 3. Feature specification

### 3.1 Inventory
- **Quick log.** Type into a single box, e.g. `2 milk`, `+6 eggs`, `used dish soap`, `out of rice`. A small parser turns this into an action and shows what it understood before saving.
- **Quick edits.** Every item row and tile has **−1 / +1**, **Out**, and **Restock to par**. Long-press opens a full-screen stepper with large buttons.
- **Stocktake mode.** Walk through one location ("Pantry") and set exact counts item by item. This records "set to X" operations (see §6 for why that matters).
- **Requirements.** Each item has a minimum, a par, and an optional *needed-by date*, e.g. "need 2 cakes of soap before guests arrive Dec 20".
- **Units and packs.** The base unit is configurable (count, L, kg, rolls), with optional pack size so "+1 pack" adds 12 eggs.
- **Barcode scan** (phase 6). Uses the `BarcodeDetector` API where it exists (Android Chrome) and ZXing WASM elsewhere, because iPhone/iPad Safari has no `BarcodeDetector`. Scanning a known barcode increments that item. For a new barcode, the name and photo are pre-filled from the free Open Food Facts database.
- **Archive, not delete.** Removed items are archived and can be restored.

### 3.2 Shopping
- The auto-list holds items below their minimum, sorted by urgency and grouped by store or category.
- **Shopping mode** on a phone shows large checkboxes. Ticking an item asks "Bought how many?" and defaults to the amount needed to reach par. Items restock when the trip is finished.
- Each item or category can have a **"who buys this"** owner, e.g. Dad does groceries and Mom does pharmacy.
- **Multiple stores.** Items can have preferred stores. The list can be grouped by store, or filtered to one store with "I'm at Costco".
- **Prices and spend.** Shopping mode can optionally ask for the price paid, pre-filled with the last price at that store. This builds a price history per store, a "cheapest at" hint, and monthly spend by category, store, and member.

### 3.3 Chores and tasks
- Schedules use RRULE recurrence: daily, weekly on specific days, every N days, monthly on a set day, or **"N days after last done"** for floating chores like "clean the fridge".
- **Assignment to one or more members**, with three modes:
  - **Any of**: shared. The first person to finish it closes it.
  - **Each of**: everyone assigned must complete it, e.g. "make your bed".
  - **Rotate**: the assignee changes round-robin with each occurrence. Skips and swaps are allowed.
- Optional due time, grace period, and effort points, which feed a fairness view.
- **Done / Skip / Snooze / Hand off** buttons. Completing a chore records **who** did it, which might not be the assignee.
- One-off tasks use the same model without recurrence.

### 3.4 Dashboard (wall display)
Designed to be read from about 3 m away and used by touch:

```
┌──────────────────────────────────────────────────────────────────────┐
│  Tue 25 Nov · 6:42 pm            ● Synced (Home hub)    [👤 Who?]    │
├───────────────────────┬───────────────────────┬──────────────────────┤
│  🔴 ACT NOW (3)       │  🟠 THIS WEEK (5)     │  🛒 SHOPPING (7)     │
│  Milk — out      [+]  │  Dish soap ~Thu  [−][+]│  Milk, Eggs, Rice…  │
│  Bins out 8pm  (R)[✓] │  Laundry  Sat (A,P)[✓]│  [Open list]         │
│  Meds refill (M) [✓]  │  Filter by Dec 1 (D)  │                      │
├───────────────────────┴───────────────────────┴──────────────────────┤
│  NEXT 7 DAYS  Tue ▓▓  Wed ▓  Thu ▓▓▓  Fri ▓  Sat ▓▓  Sun  Mon ▓       │
│  🟢 42 items OK · 12 chores on track                     [Inventory] │
└──────────────────────────────────────────────────────────────────────┘
```
- Each tile has one primary tap action and a long-press for detail. The large stepper and undo toast appear on every edit: *"Milk +1 by Priya · Undo"* (10 s).
- **"Who's doing this?"** The display is shared, so completing or editing something shows a row of avatars to pick from. The last choice is remembered for 2 minutes. An optional 4-digit PIN protects admin actions such as deleting or managing members.
- **Ambient mode.** Dims after inactivity and at night on a schedule. A slow pixel shift protects against burn-in. It wakes on touch or motion if the hardware supports it.
- **Kiosk-safe.** No browser chrome, no accidental navigation, auto-reload on crash, and a watchdog.
- A "Join household" QR code on the display lets a phone install the PWA and join in one scan.

### 3.5 Phone and remote PWA
- Tabs: **Home** (my items and chores, plus everything 🔴/🟠), **Inventory**, **Shopping**, **Chores**, **History**.
- A **quick-log button** is reachable from every screen.
- **Push notifications** (Web Push), configurable per member: "Your chore is due in 1h", "Milk ran out", "Daily digest 8am". On iOS, push requires iOS 16.4+ and the PWA installed to the home screen.
- A sync status pill is always visible: `Synced · Cloud`, `Synced · Home hub`, or `Offline · 3 changes pending`.

### 3.6 History and insights
- **Activity feed.** A complete, filterable log of every change: who, what, when, from which device. Any entry can be undone.
- **Consumption rate** per item, calculated as an exponentially weighted average of usage over time, ignoring restocks. This gives a **predicted run-out date**, which drives 🟠 "Soon" automatically.
- **Charts:** stock level over time per item, monthly usage, monthly spend by category and store, and a chore completion calendar heatmap.
- **Fairness view:** effort points per member over 4 weeks, framed as a balance check rather than a leaderboard.
- **Export:** CSV or JSON of everything, plus automatic nightly backups (see §8).

### 3.7 Members and permissions
| Role | View | Quick edits (±, done) | Edit items/chores | Manage members/settings |
|---|---|---|---|---|
| Admin | ✓ | ✓ | ✓ | ✓ |
| Member | ✓ | ✓ | ✓ | — |
| Viewer | ✓ | — | — | — |

There are no restricted kid accounts, per your decision.

---

## 4. System architecture

### 4.1 Principle: local-first
**Every device keeps a full copy of the household data** in IndexedDB and works completely offline. Servers relay and store changes; the app never waits on them. This is what makes the internet and hotspot fallback reliable instead of fragile: when connectivity is lost, sync is delayed but no functionality is lost.

```
   GitHub Pages ── serves the app itself (static files, free HTTPS)

                 ┌──────────────────────────────┐
                 │ Cloud relay: Cloudflare      │  ← remote access when away
                 │ Worker + Durable Object      │    (free *.workers.dev URL)
                 └───────────▲──────────────────┘
                             │ WSS (when internet is up)
        ┌────────────────────┼──────────────────────┐
        │ HOME LAN           │                      │
        │        ┌───────────┴───────────┐          │
        │        │  Home Hub (Raspberry  │──HDMI──► Touch display
        │        │  Pi 5): sync server,  │          │   (Chromium kiosk)
        │        │  DNS, hotspot         │          │
        │        └───▲───────────▲───────┘          │
        │      WSS   │           │  WSS             │
        │   📱 Phone A       📱 iPad   (on Wi‑Fi or hub hotspot)
        └───────────────────────────────────────────┘
          📱 Phone C (away, cellular) ──► Cloud relay only
```

Each device's service worker caches the app itself, so it opens even when GitHub Pages can't be reached.

### 4.2 Connectivity modes
| Mode | Situation | Path |
|---|---|---|
| **1. Normal** | Internet up | Phones ↔ cloud, hub ↔ cloud. Phones at home *also* connect directly to the hub, which is faster and on the LAN. |
| **2. Internet down** | Router up, ISP down | Phones at home ↔ hub over Wi‑Fi. Remote phones keep changes queued locally. The hub forwards everything to the cloud when the internet returns. |
| **3. Router down** | No Wi‑Fi | The hub turns on its **own Wi‑Fi hotspot** (`hostapd` + `dnsmasq`). Phones join the "HomeHub" network and sync with the hub. |
| **4. Isolated** | A device with no connection at all | Works on its local copy. Changes sync whenever any path returns. |

Each client keeps a list of sync endpoints (`hub`, `cloud`) and connects to all reachable ones at once. Because operations are idempotent (§6), receiving the same change from both paths is harmless.

### 4.3 The hard technical problem: HTTPS on the LAN without buying a domain
The app is served from GitHub Pages over HTTPS. A secure page can't open an unencrypted `ws://` connection, so the hub also needs HTTPS, with a certificate phones trust without extra setup. GitHub Pages can't provide that because the hub isn't on GitHub. The plan, to be confirmed in a Phase 0 spike:
- **Get a free DuckDNS subdomain for the hub**, e.g. `yourhome-hub.duckdns.org`. It's free and isn't a domain purchase.
- **Get a real Let's Encrypt certificate.** DuckDNS lets the hub set DNS TXT records through its API, so the hub can pass a DNS-01 challenge without being reachable from the internet.
  - Renewal is automatic every 60 days while the internet is up.
  - The certificate is valid for 90 days, so outages of up to about a month have no effect.
- **The DuckDNS record points at the hub's LAN IP**, e.g. 192.168.1.50.
- **Name resolution when the internet is down:**
  - *Mode 3 (hub hotspot).* The hub runs `dnsmasq` and answers for its own name. This is reliable.
  - *Mode 2 (router up, ISP down).* Phones ask the router for the hub's address, and the router can't reach DuckDNS. The recommended fix is to set the router's DHCP DNS server to the hub, Pi-hole style; the hub forwards every other lookup upstream. If you'd rather not touch the router, phones join the HomeHub hotspot during outages instead.
- **Browser permission.** Chrome asks for "local network access" when a public site (github.io) connects to a LAN device. Each Android phone accepts this once, and the hub sends the matching CORS and Private-Network headers. Safari doesn't currently prompt.
- **Known risks.**
  - Some routers block DNS answers that point at private IPs (DNS-rebind protection).
  - Android "Private DNS" and iCloud Private Relay can bypass local DNS.
  - The spike tests these on your iPad, an Android phone, and an iPhone.
- **Fallback if DuckDNS doesn't work.** The hub runs its own small certificate authority, and each device installs its root certificate once (a profile on iOS, a certificate file on Android). This works fully offline but adds an onboarding step.

Remote access when away doesn't involve the hub at all. Phones talk to the Cloudflare relay on `*.workers.dev`, which has HTTPS built in.

### 4.4 Tech stack
| Layer | Choice | Why |
|---|---|---|
| Language | **TypeScript everywhere** | One domain model shared by client, hub, and cloud |
| Repo | npm workspaces monorepo: `apps/web`, `apps/hub`, `apps/cloud`, `packages/core`, `packages/sync` | `core` holds operations, the reducer, and conflict rules, so every node runs the same logic. `sync` holds the protocol, and hub and cloud are thin adapters around it |
| Frontend | React + Vite + `vite-plugin-pwa` (Workbox) + Tailwind | Mature PWA tooling; fast |
| Local DB | IndexedDB via Dexie | Reliable, queryable, works offline |
| App hosting | **GitHub Pages**, deployed by GitHub Actions on every push to `main` | Free HTTPS, no domain needed |
| Cloud relay | **Cloudflare Workers + Durable Objects**: one SQLite-backed object per household, using WebSocket hibernation, on a free `*.workers.dev` URL | The free tier easily covers a household; HTTPS included; no server to maintain |
| Hub server | Node + Fastify + `ws` + SQLite (`better-sqlite3`) on the Pi | Tiny footprint; same sync code as the cloud |
| Charts | Recharts or uPlot | Lightweight |
| Auth | **QR pairing.** An existing device or the wall display shows a one-time invite QR code; the new device gets a long-lived device token signed by the household key. No email, no passwords | Simple for families; the hub can verify tokens offline; any member can re-pair a lost phone |
| Push | Web Push (VAPID) sent from the Worker; scheduled reminders use Durable Object alarms | Standard; works on Android, and on iOS 16.4+ once the app is added to the home screen |
| Barcode | `BarcodeDetector`, with `zxing-wasm` fallback; Open Food Facts lookup | iOS Safari has no `BarcodeDetector` |
| Hub OS | Raspberry Pi OS Lite + Chromium kiosk (cage/labwc) + systemd services | Boots straight into the dashboard |
| Tests | Vitest, **fast-check property tests** for convergence, Playwright e2e with multi-client and offline scenarios | Correctness is the product |

**Alternatives considered:** Firebase or Supabase (simplest, but no real LAN fallback and weak offline conflict semantics); Yjs or Automerge CRDTs (good for text, but they obscure domain meaning such as "used 1" vs "counted 5" and make history analytics harder); Replicache, Zero, or PowerSync (viable, but each adds a vendor-shaped server that is awkward to run on a Pi with a LAN peer). A small custom op log is the best fit because the data is small and the semantics are domain-specific.

### 4.5 Development and iPad testing
- **Day to day.** Run `npm run dev` on your PC. A service worker needs HTTPS, so to open the dev build on the iPad, run a free Cloudflare quick tunnel: `cloudflared tunnel --url http://localhost:5173` (no account needed). It gives a temporary `https://….trycloudflare.com` address.
- **Installed-app testing.** Every push to `main` deploys to GitHub Pages. On the iPad, open the site in Safari, then Share → **Add to Home Screen**.
- **Dashboard.** The wall dashboard is a route (`/#/display`) that scales from iPad landscape (1024–1366 px) up to the Pi touchscreen, so the iPad stands in for the display until the Pi arrives.
- **GitHub Pages details.** The app lives under `/inventorize/` and uses hash routes (`/#/…`), because Pages has no fallback for single-page-app routes.

---

## 5. Data model (event-sourced)

The **source of truth is an append-only operation log**. Current state is a pure function of that log, computed by `reduce(ops)`. History, undo, and audit come with this design at no extra cost.

```ts
Op {
  id: ULID                 // globally unique, used for dedupe
  hlc: HybridLogicalClock  // wall-clock + counter + nodeId → total order
  household: Id
  actor: MemberId          // who (picked on wall display)
  device: DeviceId         // from where
  type: OpType
  payload: {...}
}
```

**Entities (materialised views):** `Household, Member, Device, Location, Category, Item, Chore, Task, Occurrence, ShoppingEntry, NotificationPref`.

**Op types (examples):**
- Inventory: `item.create`, `item.update{field,value}`, `item.archive/restore`, `stock.adjust{delta, reason: used|bought|wasted|correction}`, `stock.set{qty, reason: stocktake}`
- Chores: `chore.create/update/archive`, `occurrence.complete{by[]}`, `occurrence.skip`, `occurrence.snooze{until}`, `occurrence.reassign{to[]}`
- People: `member.invite/join/update/remove`, `assignment.set{target, members[], mode}`
- Meta: `op.undo{targetOpId}`

Occurrences of recurring chores are **derived** from the RRULE and the completion ops, not stored as rows. This removes a whole class of sync conflicts.

---

## 6. Sync and conflict resolution

### 6.1 Sync protocol
- Each node (phone, display, hub, cloud) stores ops and a **version vector** `{nodeId → highest seq seen}`.
- On connect, both sides exchange vectors, send the ops the other side is missing, and then stream new ops live.
- Ops are **immutable and idempotent** (deduplicated by ULID), so retries and multi-path delivery are safe.
- The hub and cloud use exactly the same protocol: the hub is simply another peer that is always on.
- When several clients are connected, the server echoes each op to the others within about 100 ms on the LAN.

### 6.2 Conflict rules (deterministic, identical on every node)
| Scenario | Rule | Result |
|---|---|---|
| Two people each tap "used 1" on milk at the same time, one offline | `stock.adjust` is **additive** (counter CRDT) | Both count: 5 → 3. Nothing is lost. |
| A stocktake sets 4 while someone else concurrently adds +1 | **Quantity = latest `stock.set` (by HLC) + sum of `adjust`s ordered after it** | Correct whether or not the +1 happened before the count. Edge case: an adjust before the set but delivered late is ignored, which is correct because the count already reflects it. |
| Two people rename an item or change its minimum at the same time | **Field-level last-writer-wins** by HLC | One value wins. The losing edit is **shown in the activity feed as "conflict resolved, kept X; [use Y instead]"**, never silently dropped. |
| Two people mark the same chore occurrence done | Completion is a **set union** | Done once, with both credited. |
| "Each of" chore | Completion tracked per assignee | Done when every assignee is done. |
| One person edits an item while another archives it | **Archive wins, edits preserved** | The item is archived; restoring it shows the latest edits. |
| Reassignment conflicts | LWW on the assignment, with a feed notice | Same as field edits. |
| A device's clock is badly wrong | HLC bounds skew, and the server rejects ops more than 24 h in the future | Prevents a broken clock from "winning" every conflict. |
| Undo | `op.undo` is itself an op; the reducer skips the target | Undo syncs like everything else and can itself be undone. |

**Testing guarantee:** property-based tests generate random op sets and deliver them in random orders and partitions to N simulated nodes. They assert all nodes converge to identical state, and that no `adjust` is ever lost.

### 6.3 Log growth
Logs are compacted nightly into snapshots older than 90 days, while the raw history needed for analytics is kept, and a new device bootstraps from the latest snapshot. Expected volume is tiny, roughly 50–200 ops a day for a household, so a Pi holds years of data.

---

## 7. UX principles (the "incredibly easy" part)
1. **One tap for 80% of actions** (±1, done, restock). Anything with more steps has a sensible default.
2. **Undo instead of confirmation dialogs.** Every action shows an undo toast; only real deletion asks first.
3. **Large touch targets.** At least 56 px on phone and 88 px on the wall display, with high contrast and a dark-mode wall theme.
4. **Smart defaults.** Restocking defaults to par, new items guess location and category from the name, and the quick-log parser accepts natural phrasing.
5. **Near-zero setup.** Starter templates such as "Typical kitchen", "Bathroom", and "Weekly chores" pre-fill items and chores, so you only delete what doesn't apply.
6. **Clear about state.** The sync pill is always visible, and pending changes show a small dot.
7. **Accessible.** WCAG AA contrast, screen-reader labels, and reduced-motion support. Colour is never the only signal: icons and text accompany every status.

---

## 8. Security, privacy, and backup
- All traffic uses TLS, including on the LAN (§4.3). Device tokens are revocable per device, e.g. for a lost phone.
- Household data sits on your hub plus the cloud relay. The relay can optionally store ops **encrypted end-to-end** with a household key; this is noted as a phase 7 stretch goal because it complicates server-side push digests.
- The wall display runs as a "device member" that can't manage members; admin actions need a PIN.
- The GitHub repository holds code only, never household data. Free GitHub Pages requires a public repository; GitHub Pro allows Pages from a private one.
- Backups: every device, the hub, and the Cloudflare relay each hold the full history, so losing any one copy loses nothing. In addition, the hub writes a nightly snapshot to its SD card (and optionally a USB stick), and an Export button produces a full JSON/CSV file.

---

## 9. Hardware options for the display

| Option | Pros | Cons | Approx cost |
|---|---|---|---|
| **A. Raspberry Pi 5 (4 GB) + touchscreen (recommended)** | One box is hub, server, hotspot, and display; always on; full control | Some setup; screen choice matters (Pi Touch Display 2 at 7", or a 10–15" HDMI+USB touch panel) | $150–300 |
| B. Android tablet in kiosk mode + separate Pi hub | Polished screen, cheap, wall mounts available | Two devices; a tablet on constant charge needs battery care (charge limiter); kiosk app needed (e.g. Fully Kiosk) | $120–250 + Pi |
| C. Tablet only, no hub | Cheapest, simplest | **No LAN fallback** without a hub: when the internet is down, devices work offline but don't sync with each other | $100–200 |
| D. Mini PC + portable touch monitor | Powerful, bigger screens | More power, more cost, overkill | $300+ |

**Decision:** option A, a Raspberry Pi 5 with an attached touchscreen as both hub and display. During development the iPad stands in for the display (§4.5). For the screen, I suggest a 10–15" HDMI + USB touch panel so it's readable across a kitchen, or the official Pi Touch Display 2 (7") if space is tight.

---

## 10. Delivery phases

Each phase ends with something usable. Estimates assume one developer working with me, part-time.

| # | Phase | Deliverables | Exit criteria | Est. |
|---|---|---|---|---|
| **0** | **Setup and spikes** | Repo and GitHub Pages deploy pipeline; Cloudflare Worker hello-world; sync-engine prototype with convergence property tests; **HTTPS-on-LAN spike** (DuckDNS + Let's Encrypt, on the Pi or a PC standing in for it) tested on iPad, Android, and iPhone; order the Pi and screen | The installed PWA on the iPad syncs a test change through the Cloudflare relay, and to the stand-in hub with the internet unplugged | 1 wk |
| **1** | **Local-first core and inventory** | Monorepo, `core` op log and reducer, Dexie store, inventory CRUD, quick edits, quick-log parser, locations, categories and stores, templates, installable PWA, offline | Usable on the iPad, fully offline | 2 wk |
| **2** | **Cloud sync and members** | Cloudflare relay, sync protocol, HLC, conflict rules, QR pairing, roles, activity feed and undo, sync pill | iPad, an Android phone, and an iPhone edit the same item offline, reconnect, and converge correctly; conflict notices appear | 2–3 wk |
| **3** | **Chores, tasks, and responsibilities** | RRULE schedules, floating chores, Any/Each/Rotate assignment, item/category owners, Done/Skip/Snooze/Hand-off, "My stuff" view | A week of real household chores runs in the app | 2 wk |
| **4** | **Wall dashboard and kiosk** | Dashboard route, "Who?" picker, PIN, ambient/night mode, burn-in shift. Built and tested on the iPad first; Pi kiosk image and setup script at the end | Display runs 72 h unattended on the Pi; family uses it daily | 1–2 wk |
| **5** | **Home hub and hotspot fallback** | Hub server on the Pi, DuckDNS + automatic certificate renewal, LAN DNS, hub↔cloud relay, multi-endpoint client, **automatic hotspot when the router disappears**, health page | All 4 connectivity modes in §4.2 pass a scripted test (unplug WAN, switch off router) | 2 wk |
| **6** | **Shopping, stores, prices, barcode** | Shopping mode, multiple stores, price capture and history, barcode scanning with Open Food Facts lookup | A real shopping trip done entirely in the app | 2 wk |
| **7** | **History and insights** | Consumption rates, run-out predictions feeding 🟠, stock and spend charts, fairness view, CSV/JSON export | Predictions within ±2 days for regularly used items after 3 weeks of data | 2 wk |
| **8** | **Polish** | Web Push and daily digest, accessibility audit, onboarding, hub snapshots, optional E2E encryption | Family-ready v1.0 | 1–2 wk |

**MVP = phases 0–4** (about 8–10 weeks part-time): inventory, chores, multi-member cloud sync, and the wall display. As you asked, chores (phase 3) come before the hub work (phase 5). Phase 0 still includes a small LAN spike, because HTTPS on the LAN without a domain is the riskiest assumption in the plan and it's cheaper to find out early.

---

## 11. Testing strategy
- **Unit:** reducer, conflict rules, RRULE expansion, quick-log parser, consumption estimator.
- **Property-based:** convergence under random op order and partitions (the most important test in the project).
- **E2E (Playwright):** two or three browser contexts, with `context.setOffline()` toggles, covering edit, reconnect, and assert-identical scenarios.
- **Network chaos (phase 5):** a scripted test on the real hub that unplugs WAN, stops the router, and confirms the hotspot appears and phones sync.
- **Dogfooding:** your household uses each phase for at least 1 week before the next one starts.

---

## 12. Risks and mitigations
| Risk | Impact | Mitigation |
|---|---|---|
| HTTPS on the LAN fails without a domain (router DNS-rebind protection, phone Private DNS, a DuckDNS outage) | LAN fallback fails on some phones | Phase 0 spike; hub acts as LAN DNS; the 90-day certificate rides out short DuckDNS outages; fallback to a hub-issued certificate installed once per device |
| Free-tier terms change (GitHub Pages, Cloudflare, DuckDNS) | Hosting has to move | All three are replaceable: the app is static files, the relay is a thin adapter, and the hub keeps working without the cloud |
| Barcode scanning is slower on iPhone and iPad (no native API) | Scans take a moment longer | ZXing WASM is fast enough; manual search is always available |
| Phones don't auto-join the hub hotspot | Mode 3 needs a manual step | Save the hotspot network on each phone during onboarding; QR-to-join on the display |
| iOS push and PWA limitations | Fewer notifications on iPhones | Install-to-home-screen onboarding; daily digest; the display is the main channel anyway |
| People stop logging, so counts drift | Data stops reflecting reality | One-tap edits, a weekly 2-minute stocktake prompt, and predictions that flag implausible counts |
| Display burn-in or always-on wear | Hardware damage | Ambient dimming, pixel shift, night-off schedule |
| Custom sync engine bugs | Data loss or divergence | Pure reducer, property tests, the append-only log can always be replayed, backups |

---

## 13. Decisions (from review, 25 Nov 2026)
| # | Question | Decision |
|---|---|---|
| 1 | Display | Raspberry Pi 5 with touchscreen; iPad as the test display during development |
| 2 | Hotspot | The hub creates its own Wi‑Fi hotspot when the router is down |
| 3 | Remote access | Yes, through the free Cloudflare relay |
| 4 | Domain | None purchased. The app is hosted on GitHub Pages; the hub uses a free DuckDNS subdomain only for its certificate (§4.3) |
| 5 | Phones | Mix of Android and iPhone |
| 6 | Accounts | No restricted accounts; roles are Admin / Member / Viewer |
| 7 | Extras | All included: barcode scanning, prices and spend, multiple stores (phase 6) |
| 8 | Priority | Chores (phase 3) before the hub and fallback (phase 5) |

### Confirmed (25 Nov 2026)
1. Public GitHub repository: **yes**.
2. Free Cloudflare and DuckDNS accounts: **yes**.
3. Router DNS pointed at the hub for internet outages: **yes**.
