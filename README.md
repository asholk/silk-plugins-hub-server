# Silk Plugins Hub server

Server of [Silk Plugins Hub](https://github.com/asholk/silk-plugins-hub): a private catalog of Obsidian plugins for companies. Administrators decide which plugins each company gets, plugin repositories publish releases from CI, and users install and update the plugins from Obsidian with a changelog for every release.

| Part | What it does |
| --- | --- |
| **Silk Plugins Hub server** (this repository) | Companies, users, plugins, releases, sign-in, update checks, publishing from CI. |
| [**Silk Plugins Hub**](https://github.com/asholk/silk-plugins-hub) | Obsidian plugin for users: catalog, install, updates, changelog, rollback. |
| **Silk Plugins Hub Admin** | Obsidian plugin for administrators: companies, users, access, publish tokens, releases. |

## How it works

1. An administrator adds a plugin in Silk Plugins Hub Admin and issues a **publish token** for it.
2. The plugin repository's CI builds the plugin and runs [`ci/publish.mjs`](ci/publish.mjs) with the token. The server checks every file's SHA-256 and the manifest, and stores the release with the changelog from the commit message.
3. The administrator gives companies access to the plugin: **Available** or **Required**.
4. Users sign in with Google in Silk Plugins Hub, connect their companies by code and install plugins. Files are downloaded by short-lived signed links and checked against their SHA-256 before installation.

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

In Obsidian, set the server address in Silk Plugins Hub and in Silk Plugins Hub Admin to `http://127.0.0.1:8787`.

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

## Deploy to Yandex Cloud

The server runs as a Cloud Function behind API Gateway, with serverless YDB and Object Storage. With little traffic it fits in the free tier.

1. Create a folder, a serverless YDB database, a private bucket with a lifecycle rule that deletes `staging/` after a day, two service accounts (function: `ydb.editor`, `storage.editor`, `lockbox.payloadViewer`; gateway: `functions.functionInvoker`), a static access key for the function's account and a Lockbox secret with `SESSION_SECRET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` and `GOOGLE_CLIENT_SECRET`.
2. Copy `deploy/cloud.env.example` to `deploy/cloud.env` and fill in the ids.
3. Run `bash deploy/deploy.sh`. It creates the function and the gateway, uploads a new version with secrets from Lockbox, sets the scaling limits and prints the server address and the Google redirect URI.
4. Create an administrator against the cloud database: `STORE=ydb YDB_CONNECTION_STRING=… YDB_ACCESS_TOKEN=$(yc iam create-token) npm run admin -- admin`.

To move a local installation to the cloud, run `npm run migrate` with the cloud variables.

### Protection against traffic floods

- Requests per IP are limited in each instance's memory, before any database or storage access.
- Sign-in attempts per IP and signed download links per user are limited in the database.
- After 5 wrong administrator passwords from one address, sign-in is locked for 15 minutes.
- The function's scaling policy caps instances and concurrent requests: extra requests get `429` instead of new instances.
- YDB throttling and the bucket's maximum size cap storage costs; staging uploads expire after a day.
- Set a budget with alerts in Yandex Cloud Billing.

## Publish plugins from CI

Copy [`ci/publish.mjs`](ci/publish.mjs) into the plugin repository and run it after the build with two secrets:

- `HUB_URL`: the server address.
- `HUB_PUBLISH_TOKEN`: the token from the plugin's page in Silk Plugins Hub Admin. The server keeps only its hash.

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
| `/auth/*` | Silk Plugins Hub | Google sign-in with PKCE; refresh tokens are stored hashed. |
| `/api/*` | Silk Plugins Hub | User access token. |
| `/admin-api/*` | Silk Plugins Hub Admin | Administrator token from login and password. |
| `/publish/:id/*` | CI | Publish token of the plugin. |

## Privacy

The server stores users' email addresses and names from Google, their companies, and the plugin releases. Update checks send the versions of company plugins installed in a vault; they are used to answer the check and aren't stored. Request logs (IP address, path, status) go to the hosting's logs. Notes and other vault content never reach the server.

## License

[MIT](LICENSE)
