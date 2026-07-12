# ⚡ Kairos Pokémon

A clean, self-hosted **Pokémon TCG inventory manager** with **live TCGplayer market pricing** and **AI camera card scanning**.

- 🔍 **Search to add** — type a card name (e.g. `Charizard`, `Pikachu 025/165`) and add it in a click.
- 📷 **Scan to add** — point your camera at a card (or upload a photo). Cloud OCR reads the card's **name + collector number**, then auto-matches it to the exact TCGplayer printing (with an on-device Tesseract fallback when offline).
- 💵 **Live market value** — every card shows TCGplayer market / median / lowest prices. Your whole collection's value is totaled at the top.
- 🗂️ **Organize cleanly** — quantities, conditions, sorting and filtering. Click any card for a full detail view (image, prices, HP, attacks, set, rarity, listings count).
- ↻ **Refresh prices** — re-pull current market prices for everything you own.

Your collection is stored locally in `data/inventory.json`.

## How it works

The browser can't call TCGplayer's marketplace API directly (it only allows the
`tcgplayer.com` origin), so a small **Express server proxies** the public
search/pricing endpoints and serves the front-end. Card recognition runs fully
**in your browser** via [Tesseract.js](https://tesseract.projectnaptha.com/) OCR —
the recognized text is matched against TCGplayer's catalog.

## Card scanning, auto-capture & AI

The camera **auto-captures**: line the card up inside the on-screen frame and it
snaps automatically once the card is detected, steady and in focus (a ring fills
to show progress). You can also tap **Capture**, toggle **Auto** off, or upload a
photo.

Scanning then identifies the card. By default the server runs OCR via
[OCR.space](https://ocr.space) (engine 2), parses the card **name**, **collector
number** (e.g. `039/217`) and **HP**, searches TCGplayer, and ranks the exact
printing first with a **confidence score**. The number is the key to pinning the
right card/set.

### Better AI vision (optional)

For the most robust recognition (foil, angled, damaged cards), set an AI vision
key and the server will use a vision model instead of OCR, returning the name,
set, number and HP directly:

```powershell
# OpenAI (gpt-4o-mini by default)
$env:OPENAI_API_KEY = "sk-..."; npm start
# …or Google Gemini (gemini-1.5-flash by default)
$env:GEMINI_API_KEY = "..."; npm start
```

It automatically falls back to OCR.space, then to on-device Tesseract, if a key
isn't set or a call fails.

By default it uses OCR.space's shared demo key, which is rate-limited. For real
use, grab a **free key** (25k scans/month) at
<https://ocr.space/ocrapi/freekey> and set it before starting:

```powershell
$env:OCRSPACE_API_KEY = "your_key_here"; npm start
```

If the server/OCR is unreachable, the app falls back to on-device Tesseract OCR.

## Run it

Requires **Node.js 18+**.

```bash
npm install
npm start
```

Then open **http://localhost:3000**.

> Camera scanning needs `localhost` or HTTPS (a browser requirement for webcam access).
> If no camera is available, use **Upload photo** instead.

## Install it on your phone (same Wi-Fi)

The server runs on both HTTP and **HTTPS**. On startup it prints addresses, e.g.:

```
On this computer:  http://localhost:3000
On your phone (same Wi-Fi) — use HTTPS for camera + install:
   https://192.168.1.168:3443
```

On your phone (same Wi-Fi as the computer), open the **`https://…:3443`** address.

1. It uses a **self-signed certificate**, so you'll see a "Not secure / privacy"
   warning the first time → tap **Advanced → Proceed/Continue**.
2. Tap **⬇ Install app** in the app, or use the browser:
   - **Android / Chrome:** menu ⋮ → *Install app* / *Add to Home screen*.
   - **iPhone / Safari:** Share → *Add to Home Screen*.
3. Launch it from your home screen — full-screen, with a working **camera scan**.

> The HTTPS address is what unlocks both the **camera** and **installing** the
> app — browsers require a secure context for these. The plain `http://…:3000`
> address still works for everything except the camera.

> If the page won't load from the phone, allow Node through Windows Firewall
> (private networks):
> `New-NetFirewallRule -DisplayName "Kairos" -Direction Inbound -LocalPort 3000,3443 -Protocol TCP -Action Allow`

## Project structure

```
server.js          Express server: TCGplayer proxy + inventory API
public/index.html  App shell
public/styles.css  UI styling
public/app.js      Front-end logic (search, scan, collection)
data/inventory.json  Your saved collection (auto-created)
```

## Ship to iOS (TestFlight)

The app is wrapped with [Capacitor](https://capacitorjs.com) so the existing web
UI runs as a native iOS app. Getting it onto TestFlight has three parts.

### Prerequisites (only you can provide these)

- **Apple Developer Program** membership ($99/year) — required for TestFlight.
- **A macOS build** — iOS apps are signed/uploaded from macOS. Either use a Mac
  with Xcode, or a cloud-Mac CI (e.g. **Codemagic**, **Expo EAS**) so you can
  build from Windows.

### 1. Deploy the backend (must be public, not localhost)

A shipped app can't talk to your PC. Host `server.js` somewhere public:

- Push this repo to GitHub.
- On [Render](https://render.com): **New → Blueprint**, select the repo
  (`render.yaml` is included). Set `OCRSPACE_API_KEY` in the dashboard.
- Note the URL, e.g. `https://kairos-pokemon.onrender.com`.

The included blueprint mounts a persistent disk at `/data` (via `DATA_DIR`) so
accounts/inventory survive restarts. (Disks need a paid Render instance; on the
free tier data is wiped on each spin-down.)

### Persistent accounts & collections on the free tier (MongoDB Atlas)

The free Render tier wipes its filesystem when the instance sleeps, which logs
everyone out and deletes collections. Fix it with a free MongoDB Atlas database:

1. Create a free account at [mongodb.com/cloud/atlas](https://www.mongodb.com/cloud/atlas/register)
   (no credit card) and create a **Free (M0)** cluster.
2. Under **Database Access**, add a database user (username + password).
3. Under **Network Access**, add IP `0.0.0.0/0` (allow from anywhere — Render's
   IPs rotate).
4. Click **Connect → Drivers** and copy the connection string, e.g.
   `mongodb+srv://USER:PASSWORD@cluster0.xxxxx.mongodb.net/`.
5. In the Render dashboard → your service → **Environment**, add
   `MONGODB_URI` with that string. Render redeploys automatically.

With `MONGODB_URI` set the server stores users, sessions, and collections in
Atlas — logins survive restarts and the same account works from any device.
Without it, the server falls back to local JSON files (fine for local dev).

### 2. Point the app at the backend

Edit `public/config.js` and set your deployed URL:

```js
window.KAIROS_API_BASE = "https://kairos-pokemon.onrender.com";
```

### 3. Build & submit the iOS app

#### Option A — Codemagic (recommended on Windows, no Mac needed)

A ready-to-use `codemagic.yaml` is included. It builds on a cloud Mac and pushes
straight to TestFlight.

One-time setup:

1. In **App Store Connect → Users and Access → Integrations**, create an
   **App Store Connect API key** (App Manager role). Note the Issuer ID, Key ID,
   and download the `.p8`.
2. In **App Store Connect → Apps**, create the app (pick bundle id
   `com.kairos.pokemon`). Copy its numeric **Apple ID** (App Information →
   General).
3. In **Codemagic**, connect this GitHub repo. Add an **App Store Connect
   integration** (using the API key) and name it `KairosASC` (matches
   `codemagic.yaml`). Edit `codemagic.yaml`: set `APP_STORE_APP_ID` to the
   numeric Apple ID from step 2.
4. Start the **ios-testflight** workflow. The build appears in
   **App Store Connect → TestFlight** when done; add testers there.

The pipeline auto-generates the `ios/` project, syncs the web assets, injects the
camera/photo permission strings, signs, increments the build number, and uploads.

#### Option B — A Mac with Xcode

```bash
npm install
npx cap add ios       # generates the ios/ Xcode project (first time only)
npx cap sync ios      # copies public/ + config into the app
npx cap open ios      # opens Xcode
```

In Xcode: set your **Team** (signing) and the **Bundle Identifier**
(`com.kairos.pokemon`), add a **Privacy – Camera Usage Description** under the
target's *Info* tab, then **Product → Archive → Distribute App → App Store
Connect → Upload**. The build then appears in **TestFlight**.

## Notes

- Data comes from TCGplayer's public marketplace endpoints. This is an unofficial,
  personal-use tool and is not affiliated with or endorsed by TCGplayer.
- Searches are scoped to the **Pokémon** product line, including sealed products.
