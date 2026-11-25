# Inventorize

A household supplies and chores app for the whole family. It runs as a PWA on phones and on a wall-mounted touchscreen. Every device keeps its own copy of the data and syncs through a free Cloudflare relay when online, or through a Raspberry Pi hub on the home network when the internet is down. See [PLAN.md](PLAN.md) for the full design.

**Status:** Phase 0 (setup and spikes). Inventory basics and sync work end to end; chores, the wall dashboard and sign-in come in later phases.

## Layout

| Path | What it is |
|---|---|
| `packages/core` | Operations, hybrid logical clock, and the reducer that applies the conflict rules |
| `packages/sync` | Sync protocol, op stores (memory, SQLite), and the convergence tests |
| `apps/web` | The PWA (React + Vite), deployed to GitHub Pages |
| `apps/cloud` | Cloud relay: Cloudflare Worker + one Durable Object per household |
| `apps/hub` | Home hub server for the Raspberry Pi (Node + SQLite) |

## Develop

Requires Node 22.18 or newer (the hub runs TypeScript directly).

```powershell
npm install
npm test            # unit + property-based convergence tests
npm run typecheck
npm run dev         # web app on http://localhost:5173
```

Full local stack, in three terminals:

```powershell
npm run relay:dev -- --port 8788                    # local Cloudflare relay
$env:CLOUD_URL='ws://localhost:8788'; npm run hub   # hub on ws://localhost:8787
npm run dev                                         # set VITE_CLOUD_URL=ws://localhost:8788 in apps/web/.env.local
```

In the app, open ⚙ and set the hub address to `ws://localhost:8787`.

### Testing on the iPad

A service worker only runs over HTTPS, so for the dev server use a free Cloudflare quick tunnel (no account needed):

```powershell
npx cloudflared tunnel --url http://localhost:5173
```

Open the printed `https://….trycloudflare.com` address in Safari. For the installed-app experience, use the GitHub Pages site and choose Share → **Add to Home Screen**.

## Deploy

1. **GitHub Pages.** Create a public repository, push `main`, then under *Settings → Pages* set the source to **GitHub Actions**. Every push to `main` tests, builds and deploys to `https://<user>.github.io/<repo>/`.
2. **Cloud relay.** Run `npx wrangler login`, then `npm run relay:deploy`. Note the `https://inventorize-relay.<subdomain>.workers.dev` address.
3. **Connect them.** In the repository, add a variable under *Settings → Secrets and variables → Actions → Variables*: `CLOUD_URL` = `wss://inventorize-relay.<subdomain>.workers.dev`. Re-run the deploy workflow.
4. **Invite family.** Open ⚙ in the app and share the invite link.

> Phase 0 has no sign-in: the household code in the invite link is the only secret. Phase 2 replaces this with QR pairing and signed device tokens.
