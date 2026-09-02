# 9Drive

[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/ContextualWisdomLab/9drive)

9Drive is a storage-gateway web application that combines multiple Google Drive and S3-compatible accounts behind one virtual storage dashboard. It tracks capacity, organizes files independently of provider layout, and routes uploads to an eligible backing account while keeping provider credentials on the backend.

## Product responsibility

9Drive owns the user-facing virtual storage layer: account connections, quota visibility, virtual folders, file operations, upload routing, API-key-backed uploads, and synchronization between provider state and application metadata. Google Drive, S3-compatible object stores, OAuth identity, and database infrastructure remain external systems integrated through explicit provider boundaries.

## Architecture

The repository contains a TypeScript full-stack application:

- `backend/`: Express API, Prisma persistence, authentication, Google Drive and S3-compatible provider integrations, upload routing, and synchronization.
- `frontend/`: React/Vite dashboard for storage, quota, file operations, account connections, and upload workflows.
- Docker Compose and setup scripts provide local deployment paths around the application and database.

## Getting started

Use the repository setup documentation for platform-specific installation. A typical source workflow installs the backend/frontend dependencies, configures local environment files, applies Prisma migrations, and starts both development services. Provider credentials and encryption/authentication secrets belong in local/deployment configuration and must not be committed.

## Operational boundaries

Before production use, configure HTTPS, production OAuth redirect/origin settings, durable secrets, database backups/migrations, and provider-specific access policies. Treat the upstream live preview as an upstream service reference rather than evidence that this ContextualWisdomLab fork is itself deployed from the current revision.

## Documentation and support

- [Repository README](../README.md) — full setup, provider, API, and deployment instructions.
- [Ask DeepWiki](https://deepwiki.com/ContextualWisdomLab/9drive) — repository-aware code and documentation navigation.

This page is suitable as a minimal GitHub Pages source. It is not evidence that Pages is published; publication is complete only after repository settings and the live HTTPS site are verified.
