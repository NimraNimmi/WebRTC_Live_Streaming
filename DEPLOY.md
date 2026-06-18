# Deploying to Fly.io

This project is ready to deploy as-is — `Dockerfile`, `fly.toml`, and `.dockerignore` are already configured for it.

## 1. Install the Fly CLI (one-time)

**Mac/Linux:**
```bash
curl -L https://fly.io/install.sh | sh
```

**Windows (PowerShell):**
```powershell
pwsh -Command "iwr https://fly.io/install.ps1 -useb | iex"
```

## 2. Log in

```bash
fly auth login
```
Opens a browser to sign up/log in (free account, no credit card required for the free allowance).

## 3. Launch the app

From inside the project folder (where `Dockerfile` and `fly.toml` live):

```bash
fly launch
```

- It will detect the existing `fly.toml` and ask if you want to use it — say **yes**.
- It will ask to pick an app name — either accept the default or type your own (must be globally unique across all Fly users).
- It will ask about a Postgres/Redis database — say **no** (not needed for this project).
- It will ask to deploy now — say **yes**.

This builds the Docker image and deploys it. Takes 1-3 minutes.

## 4. Open your live app

```bash
fly open
```
This prints/opens your live URL, e.g. `https://live-commerce-demo.fly.dev`

## 5. For future updates

Whenever you change `server.js` or `public/index.html`, redeploy with:

```bash
fly deploy
```

## Notes specific to this project

- `fly.toml` sets `min_machines_running = 1` and `auto_stop_machines = false` — this is intentional and important: it keeps the server always running so Socket.io WebSocket connections stay alive and there's no cold-start delay if you're demoing this live to an interviewer.
- `server.js` already reads `process.env.PORT`, so no code changes are needed for Fly.io — it works the same as it does locally.
- Test with multiple users by opening the `fly.dev` URL in 2-3 separate browser windows/profiles, exactly like local testing.

## Troubleshooting

**"app name already taken"** — pick a different name when `fly launch` prompts you, or edit `app = "..."` in `fly.toml` before running `fly launch` again.

**WebSocket connection fails after deploy** — check `fly logs` for errors. Make sure `internal_port = 3000` in `fly.toml` matches the port `server.js` actually listens on (it does, via `process.env.PORT`).

**Camera/mic doesn't work on the deployed site** — browsers only allow `getUserMedia()` (camera/mic access) over HTTPS or `localhost`. Fly.io serves over HTTPS by default (`force_https = true` is already set), so this should work automatically.
