# Running Stellwerk in Docker

The Docker setup is for people who'd rather not keep a Python virtualenv around. It doesn't sandbox anything. Read [What the container can do](#what-the-container-can-do) before you use it.

> **Status:** the `Dockerfile` and `compose.yaml` are new. Please [open an issue](../README.md#contributing) if something doesn't work on your machine.

## Why it looks the way it does

Hermes and Pi install themselves into your home folder: `~/.local/bin/hermes` is a small wrapper around `~/.hermes`, which brings its own Python, and `~/.local/bin/pi` is a launcher into `~/.pi/agent`, which brings its own Node. Neither belongs in an image, and both need your configuration, your API keys and your sessions.

So the image contains only Stellwerk, and `compose.yaml` runs it like a normal install would:

| Setting | Why |
|---|---|
| `user: "${UID}:${GID}"` | The agents run as you, and files they write stay yours. |
| Your home mounted at the same path | Paths inside and outside the container match: the agents, their sessions, your projects and `~/.config/stellwerk`. |
| `HOME` and `PATH` (with `$HOME/.local/bin`), from `HOST_HOME` in `.env` | So Stellwerk finds `hermes` and `pi` where a normal install does. |
| `network_mode: host` | The Hermes gateway only listens on the host's `127.0.0.1`. |
| `/etc/passwd` and `/etc/group` mounted read-only | So your uid has a name inside the container. `ssh` and `git` want one. |
| `init: true` | Reaps the Pi processes Stellwerk starts and stops. |

This works on Linux with the regular (rootful) Docker Engine. Docker Desktop on macOS and Windows can't share the host's loopback network this way.

## Setup

1. **Start the Hermes gateway on the host** (skip this if you only use Pi):

   ```sh
   hermes gateway install      # a systemd user service that starts on login
   hermes gateway status       # check that it's running
   ```

   See [Hermes and the gateway](#hermes-and-the-gateway) for why.

2. **Tell compose who you are:**

   ```sh
   printf 'UID=%s\nGID=%s\nHOST_USER=%s\nHOST_HOME=%s\n' "$(id -u)" "$(id -g)" "$USER" "$HOME" > .env
   ```

   Run this as yourself, not with `sudo`. It writes your uid, gid, user name and home folder to `.env` (see `.env.example`). Compose reads them from there instead of from your shell, so `sudo docker compose …` works too.

3. **Build and start it:**

   ```sh
   docker compose up -d --build
   docker compose logs -f
   ```

   Then open <http://127.0.0.1:7777>.

To change the address or port, set `STELLWERK_HOST` or `STELLWERK_PORT` in `.env`. All the variables in the [configuration table](../README.md#configuration) work.

The password commands work through compose too. Stop the server first, because it keeps its settings in memory and would overwrite the change:

```sh
docker compose stop
docker compose run --rm stellwerk python -m server.app --set-password
docker compose start
```

## Hermes and the gateway

Stellwerk talks to Hermes through its gateway. For each browser tab it runs `hermes gateway attach --json --start`, which finds the gateway through a control socket at `~/.hermes/gateway.sock` and hands back a loopback WebSocket URL plus a one-time ticket.

- **If the gateway is already running on the host**, this just works. The socket is in your mounted home, the gateway checks that the caller has the same uid (it does), and the WebSocket URL is on `127.0.0.1`, which the container shares thanks to host networking.
- **If it isn't running**, `--start` tries to start it. When a `hermes-gateway` systemd unit is installed, Hermes asks `systemctl --user` to start it. That fails inside the container, because there's no systemd there. When no unit is installed, Hermes starts the gateway as a background process *inside the container*, so it stops whenever the container does, and it runs with the container's tools instead of the host's.

That's why step 1 says to run the gateway on the host. `hermes gateway install` is the easiest way; keeping `hermes gateway run` going in a terminal also works.

## Pi runs inside the container

Stellwerk starts each Pi session as `pi --mode rpc`, in the session's folder, from inside the container. Pi's own files come from your home, but every command Pi's bash tool runs, runs in the container. It only finds the programs installed in the image.

The image includes `bash`, `git`, `curl`, `ripgrep`, `less`, `openssh-client` and `procps`. Add whatever your projects need when you build:

```sh
docker compose build --build-arg EXTRA_PACKAGES="build-essential nodejs make"
```

Hermes isn't affected: its tools run in the gateway, which runs on the host.

## What the container can do

Everything your user can. It runs as you, it can read and write your whole home folder, and it shares the host's network. That's on purpose: Stellwerk exists to run coding agents that edit files and run commands for you. Treat it exactly like running Stellwerk directly, and keep the same [security advice](../README.md#security) in mind.

## Troubleshooting

- **`required variable UID is missing a value`** (or `HOST_HOME`): create `.env` as in step 2.
- **`PermissionError: … '/root/.config/stellwerk/config.json'`**: `HOST_HOME` is missing or set to `/root`. This happens with an older `.env` under `sudo`, which sets `HOME=/root`. Recreate `.env` as in step 2, as yourself, then `docker compose up -d`.
- **"gateway not ready" or `service_manager_unavailable` in the Hermes view**: the gateway isn't running on the host. Run `hermes gateway status` on the host, then `hermes gateway install` or `hermes gateway start`.
- **Hermes or Pi shows as not installed**: check that they're in `~/.local/bin` on the host, or set the full path under **Settings → Agents**.
- **Files end up owned by the wrong user**: `UID` and `GID` in `.env` don't match `id -u` and `id -g`.
- **Rootless Docker or Podman**: user ids are remapped, so `user: "${UID}:${GID}"` doesn't mean "you" there. With Podman, replace the `user:` line with `userns_mode: keep-id`. With rootless Docker, try `user: "0:0"` (which maps to your user). Neither is tested yet.
- **Your user isn't in `/etc/passwd`** (LDAP, systemd-homed): remove the two `/etc/passwd` and `/etc/group` mounts and set `HOST_USER` in `.env`. `ssh` from inside the container may complain.
