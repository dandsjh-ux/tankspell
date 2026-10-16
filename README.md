# Word Tanks

A multiplayer 2D tank battle for the browser. Drive across a huge grassland, collect scattered letters, spell words to load your cannon, and blast the other tanks. Longer words hit exponentially harder.

Works with keyboard + mouse and on touch-screen tablets. No dependencies: the server is plain Node.js (built-in WebSocket server in `ws.js`).

## Run locally

```
node server.js
```
Open http://localhost:3000 in two browser tabs to play against yourself.

## Deploy on Render

1. Put this folder in a GitHub repository (upload all files, keeping the `public` and `data` folders).
2. In Render, choose **New → Web Service**, connect the repo, and use:
   - **Runtime:** Node
   - **Build command:** `npm install`
   - **Start command:** `node server.js`
   - **Region:** Singapore (lowest latency for South-East Asia)
   - **Health check path:** `/healthz` (optional)
   
   Or choose **New → Blueprint** and Render will read `render.yaml` automatically.
3. Share the `https://…onrender.com` link. Everyone opens it, picks a tank, and joins from the lobby.

Free Render services sleep after ~15 minutes idle; the first visit afterwards takes 30–60 seconds to wake up. Open the link a minute before class.

## How it plays

- **Tank select:** Scout (fast), Striker (balanced), Titan (heavy), Longshot (long range, +20% damage), Lexicon (+3 letter slots, wider letter pickup).
- **Lobby:** shows every active battle (waiting or in progress) with player count, mode and map size. Private rooms ask for a password.
- **Words → ammo:** a 3-letter word does the base damage (default 10); each extra letter multiplies it (default ×2): 3→10, 4→20, 5→40, 6→80, 7→160. Each word loads several shells (default 3). Tap an ammo chip to choose which word is loaded.
- **Power-ups** (collected into slots, deployed when you choose): Shield, Speed Boost, Repair Kit, Double Damage, Rapid Fire, Letter Magnet, Wildcard Tile (any letter), Land Mine (hidden from enemies), Camouflage.
- **Destroyed tanks** spill their letters onto the field.

### Host settings
Room name, password, max players (2–16), late joining · Free-for-all or Red vs Blue, kill limit, time limit, respawn delay, spawn protection, friendly fire · map size (small → huge), rocks, trees, letter density, vowel frequency, letter respawn · dictionary (all word forms or root words only), minimum word length, tray size, base damage, damage growth, shells per word, basic cannon (or off), no-repeat words, letter dropping · tank health/speed/reload/shell speed, allowed tanks · power-up frequency, duration, inventory slots, which power-ups are enabled.

### Controls
| | Keyboard & mouse | Touch |
|---|---|---|
| Drive | WASD / arrows | Left-thumb stick |
| Aim / fire | Mouse, click or Space | Right-thumb stick (drag fires, tap = one shot) |
| Spell | Click tiles, or Enter → type → Enter | Tap tiles |
| Drop a letter | Right-click tile | Hold tile |
| Power-ups | 1–5 or click slot | Tap slot |
| Scores | Tab | 🏆 button |

## Files
- `server.js` — HTTP + WebSocket server, rooms/lobby, authoritative game simulation
- `ws.js` — tiny WebSocket implementation (no npm packages needed)
- `public/shared.js` — tanks, power-ups, settings and collision shared by server and browser
- `public/game.js` — rendering, input, HUD, sound; `public/app.js` — screens and lobby; `public/art.js` — procedural tank/rock/tree art
- `data/words_*.txt` — English dictionaries (derived from the Hunspell en_US list, with offensive words removed)
