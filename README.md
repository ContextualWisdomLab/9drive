# 9Drive

[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/ContextualWisdomLab/9drive)

**A self-hosted storage gateway for managing Google Drive and S3-compatible accounts from one virtual workspace.**

9Drive gives operators one place to connect storage accounts, see available capacity, organize files through virtual folders, and route uploads to an eligible backing account. The application keeps provider credentials and upload-routing logic on the backend while exposing a React dashboard and an API-key-backed upload surface.

> **Fork status:** `ContextualWisdomLab/9drive` is a fork of [`zenhosta/9drive`](https://github.com/zenhosta/9drive). Upstream remains the original product and copyright authority. Fork-local behavior, verification, and release status must be evaluated from this repository rather than inferred from the upstream service or README.

## What 9Drive does

- Connects multiple Google Drive accounts and S3-compatible storage providers.
- Aggregates quota and storage visibility behind one dashboard.
- Routes uploads with most-available, round-robin, or priority-order policies.
- Streams uploads through the backend without exposing provider credentials to the browser.
- Maintains virtual folders and application metadata independently of provider folder layout.
- Supports preview, download, rename, move, delete, and provider synchronization workflows.
- Exposes an external upload API with revocable, hashed API keys.
- Supports email/password authentication and Google sign-in.

9Drive is a storage gateway, not a replacement for Google Drive, S3, an identity provider, or a database. Those systems retain authority over their own accounts, objects, credentials, availability, and policies.

## Quick start

The most reproducible repository-owned path is Docker Compose.

```bash
git clone https://github.com/ContextualWisdomLab/9drive.git
cd 9drive
cp .env.docker.example .env
# Edit .env with strong secrets and the provider settings you actually use.
docker compose up -d --build
```

The stack exposes the frontend and backend according to `docker-compose.yml` and applies the backend's production Prisma migrations before serving the API. Google Drive sign-in/connect flows require a Google Cloud OAuth client and the Drive API; S3-compatible providers require their own endpoint and credentials.

For source development, run the backend and frontend independently:

```bash
cd backend
npm install
npm run prisma:generate
npm run prisma:migrate
npm run dev
```

```bash
cd frontend
npm install
npm run dev
```

The backend currently provides `build`, `start`, `start:deploy`, Prisma migration, Google-config seeding, and focused provider/API test scripts. The frontend provides `dev`, `build`, and `preview` scripts. Keep all provider credentials, JWT secrets, encryption keys, and deployment-specific values out of source control.

## Architecture and integration boundary

```text
Browser / API client
        │
        ▼
React + Vite frontend
        │
        ▼
Express + TypeScript backend
   ├── authentication / API keys
   ├── virtual storage metadata
   ├── upload routing
   ├── Google Drive adapter
   └── S3-compatible adapter
        │
        ├────────► Google Drive
        ├────────► S3-compatible object storage
        └────────► Prisma-backed database
```

`backend/` owns the application API, authentication, routing, provider adapters, and persistence integration. `frontend/` owns the operator-facing dashboard. Google, S3 providers, OAuth infrastructure, and the database remain external authorities; 9Drive should fail visibly when those dependencies are unavailable rather than presenting provider state as application-owned truth.

## Operational and security notes

For any non-local deployment, use HTTPS, production OAuth origins/redirect URIs, strong randomly generated application secrets, restricted database exposure, backups, and provider credentials scoped to the intended account or bucket. Vite embeds selected frontend environment values at build time, so rebuild the frontend when those values change.

The upstream homepage and preview belong to the upstream project. They are **not** evidence that this ContextualWisdomLab fork is deployed from its current revision. This fork currently has no GitHub Release; bind any deployment to an exact reviewed commit and its current verification evidence.

## Verification

Before integrating or deploying a fork change, at minimum run the repository-owned build/migration checks relevant to the changed surface:

```bash
cd backend
npm install
npm run build
```

```bash
cd frontend
npm install
npm run build
```

Provider-specific test scripts require real, appropriately scoped credentials and should not be treated as safe offline unit tests. GitHub Checks on the exact commit remain the authoritative hosted verification for a pull request.

## Documentation

- [`docs/index.md`](docs/index.md) — concise product and integration landing page.
- [`backend/package.json`](backend/package.json) — backend scripts and current dependency surface.
- [`frontend/package.json`](frontend/package.json) — frontend scripts and current dependency surface.
- [`docker-compose.yml`](docker-compose.yml) — repository-owned container topology.
- [`AGENTS.md`](AGENTS.md) — maintainer/automation guidance; not customer-facing product behavior.
- [Upstream `zenhosta/9drive`](https://github.com/zenhosta/9drive) — original project, upstream history, and upstream service information.

## Contribution and support

Keep changes inside 9Drive's storage-gateway boundary and preserve provider credential isolation. Open issues or pull requests in this fork for fork-specific defects and integrations; upstream product questions and upstream release support belong to `zenhosta/9drive`.

When changing provider behavior, document which system owns the authoritative state, how credentials are handled, how failure is surfaced, and what evidence verifies the integration. Do not present an open PR, source version, upstream preview, or passing predecessor check as a fork release.

## License and provenance

This fork inherits the upstream **Apache License 2.0** grant and preserves the upstream copyright notice, `Copyright 2026 Zenhosta`. See [`LICENSE`](LICENSE).

The fork was created before upstream commit `811d4a2` added the root Apache-2.0 file, so this documentation lane restores that upstream license text rather than inventing a new ContextualWisdomLab-exclusive grant. `backend/package.json` still carries the upstream `ISC` package metadata; that metadata is not used here to relicense the repository or third-party dependencies and should be reconciled before any standalone backend-package publication.

npm dependencies, Google APIs, S3-compatible services, databases, container images, and other third-party software or services retain their own licenses and terms. The repository license does not override them.
