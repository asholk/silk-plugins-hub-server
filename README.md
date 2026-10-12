# Silk Hub server

Server of [Silk Hub](https://github.com/asholk/silk-plugins-hub): a private catalog of Obsidian plugins for companies. Administrators decide which plugins each company gets, plugin repositories publish releases from CI, and users install and update the plugins from Obsidian with a changelog for every release.

| Part | What it does |
| --- | --- |
| **Silk Hub server** (this repository) | Companies, users, plugins, releases, sign-in, update checks, publishing from CI. |
| [**Silk Hub**](https://github.com/asholk/silk-plugins-hub) | Obsidian plugin for users: catalog, install, updates, changelog, rollback. |
| **Silk Hub Admin** | Obsidian plugin for administrators: companies, users, access, publish tokens, releases. |

## How it works

1. An administrator adds a plugin in Silk Hub Admin and issues a **publish token** for it.
2. The plugin repository's CI builds the plugin and runs [`ci/publish.mjs`](ci/publish.mjs) with the token. The server checks every file's SHA-256 and the manifest, and stores the release with the changelog from the commit message.
3. The administrator gives companies access to the plugin: **Available** or **Required**.
4. Users sign in with Google in Silk Hub, connect their companies by code and install plugins. Files are downloaded by short-lived signed links and checked against their SHA-256 before installation.

Nothing is pulled from plugin repositories: releases only arrive through publishing, so the server needs no access to your Git hosting.

## Run locally

Requires Node.js 22.13 or later.

```bash
npm install
cp .env.example .env        # set SESSION_SECRET; DEV_LOGIN=1 allows email sign-in without Google
npm run admin -- admin      # create an administrator, prints a generated password
npm start                   # http://127.0.0.1:8787
npm test
```

Locally, data is kept in `data/store.db` (SQLite) and files in `data/files`.

In Obsidian, set the server address in Silk Hub and in Silk Hub Admin to `http://127.0.0.1:8787`.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `BASE_URL` | `http://localhost:8787` | Public address of the server; used in sign-in and file links. |
| `SESSION_SECRET` | — | Signs tokens and links. At least 32 characters. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | — | Google sign-in. Redirect URI: `<BASE_URL>/auth/google/callback`. |
| `DEV_LOGIN` | `0` | `1` enables email sign-in without Google. Local use only. |
| `STORE` | `sqlite` | `sqlite` or `ydb` (Yandex Database). |
| `FILES` | `local` | `local` or `s3` (Yandex Object Storage or any S3). |
| `YDB_CONNECTION_STRING`, `YDB_TABLE_PREFIX` | —, `hub_` | YDB database and table prefix. |
| `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | — | Bucket for release files. |
| `REQUESTS_PER_MINUTE` | `300` | Requests per IP per minute. |
| `DOWNLOADS_PER_HOUR` | `300` | Signed file links per user per hour. |
| `AUTH_PER_10_MIN` | `30` | Sign-in attempts per IP per 10 minutes. |
| `ADMIN_ALLOWED_IPS` | — | If set, the admin API answers only these IPs. |

## Deploy to a server

The simplest production setup is one small Ubuntu 24.04 server (1 vCPU, 1–2 GB RAM is plenty): the service with SQLite and local files, Caddy for HTTPS, nightly backups. A fixed-price server can't run up a bill under a traffic flood. Any VPS provider works; the commands below use [Timeweb Cloud](https://timeweb.cloud) and its CLI `twc`.

1. Create the server with your SSH key:

   ```bash
   twc ssh-key new ~/.ssh/id_ed25519.pub --name silk-hub-admin
   twc server create --name silk-hub --image ubuntu-24.04 --cpu 1 --ram 1G --disk 15G      --ssh-key silk-hub-admin --disable-ssh-password-auth
   ```

2. Optionally create a key for CI deploys: `ssh-keygen -t ed25519 -N "" -f deploy/server/ci_deploy_key`. The server lets this key run only the deploy command.
3. Install everything and deploy: `DEPLOY_HOST=<server ip> bash deploy/server/install.sh [domain]`. Without a domain the server gets `<ip>.sslip.io` with a working HTTPS certificate. Google sign-in settings are copied from your `.env`.
4. Create an administrator on the server:

   ```bash
   ssh root@<server ip> 'cd /opt/silk-hub/current && set -a && . /etc/silk-hub.env && sudo -u hub -E node scripts/admin.js admin'
   ```

5. Add the redirect URI `https://<domain>/auth/google/callback` to your Google OAuth client.

Later deploys: `DEPLOY_HOST=<server ip> bash deploy/server/deploy.sh`, or from CI on every push (see [`.sourcecraft/ci.yaml`](.sourcecraft/ci.yaml): secrets `DEPLOY_HOST` and `DEPLOY_SSH_KEY` with the private CI key). A failed health check rolls back to the previous release.

On the server:

| Path | What |
| --- | --- |
| `/etc/silk-hub.env` | Settings, including the generated `SESSION_SECRET` |
| `/opt/silk-hub/data` | SQLite store and release files |
| `/opt/silk-hub/backups` | Nightly copies of the store (14 days) and release files |
| `/opt/silk-hub/releases` | The last 5 deployed versions; `current` points to the running one |

### Protection against traffic floods

- Requests per IP are limited in memory, before any database or storage access.
- Sign-in attempts per IP and signed download links per user are limited in the database.
- After 5 wrong administrator passwords from one address, sign-in is locked for 15 minutes.
- Caddy drops forged `X-Forwarded-For` headers, so the IP limits can't be bypassed.
- The firewall allows only SSH, HTTP and HTTPS; SSH accepts keys only.
- For volumetric attacks, ask your provider for a DDoS-protected IP (`twc server create --ddos-protection`).

### Yandex Cloud (serverless)

The server can also run as a Cloud Function behind API Gateway with serverless YDB and Object Storage (`STORE=ydb`, `FILES=s3`): see [`deploy/yandex`](deploy/yandex). Copy `deploy/yandex/cloud.env.example` to `deploy/yandex/cloud.env`, fill in the resource ids and run `bash deploy/yandex/deploy.sh`.

## Publish plugins from CI

Copy [`ci/publish.mjs`](ci/publish.mjs) into the plugin repository and run it after the build with two secrets:

- `HUB_URL`: the server address.
- `HUB_PUBLISH_TOKEN`: the token from the plugin's page in Silk Hub Admin. The server keeps only its hash.

It uploads `main.js`, `manifest.json`, `styles.css` and the `hub/` folder: `card.md` (plugin page), `guide.md` (step-by-step instructions) and screenshots. A version that's already published is skipped, so the script can run on every push.

GitHub Actions:

```yaml
on:
  push:
    branches: [main]
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci && npm run build
      - run: node scripts/publish.mjs
        env:
          HUB_URL: ${{ secrets.HUB_URL }}
          HUB_PUBLISH_TOKEN: ${{ secrets.HUB_PUBLISH_TOKEN }}
```

### Changelog

The changelog comes from the commit message. Add a `Changelog:` block with typed items; text after a dash explains why:

```text
Add PDF export

Changelog:
- New: export to PDF — to share notes with colleagues
- Fixed: tag sorting
```

Types: `New`, `Improved`, `Fixed` (or `Новое`, `Улучшено`, `Исправлено`); other items are shown as changes.

## API

| Prefix | Who | Auth |
| --- | --- | --- |
| `/auth/*` | Silk Hub | Google sign-in with PKCE; refresh tokens are stored hashed. |
| `/api/*` | Silk Hub | User access token. |
| `/admin-api/*` | Silk Hub Admin | Administrator token from login and password. |
| `/publish/:id/*` | CI | Publish token of the plugin. |

## Privacy

The server stores users' email addresses and names from Google, their companies, and the plugin releases. Update checks send the versions of company plugins installed in a vault; they are used to answer the check and aren't stored. Request logs (IP address, path, status) go to the hosting's logs. Notes and other vault content never reach the server.

## License

[MIT](LICENSE)
