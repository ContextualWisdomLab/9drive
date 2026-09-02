# 9Drive

[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/ContextualWisdomLab/9drive)

9Drive is a storage-gateway web application that combines multiple Google Drive and S3-compatible accounts behind one virtual storage dashboard. It tracks capacity, organizes files independently of provider layout, and routes uploads to an eligible backing account while keeping provider credentials on the backend.

## Product responsibility

9Drive owns the user-facing virtual storage layer: account connections, quota visibility, virtual folders, file operations, upload routing, API-key-backed uploads, and synchronization between provider state and application metadata. Google Drive, S3-compatible object stores, OAuth identity, and database infrastructure remain external systems integrated through explicit provider boundaries.

This repository is a fork of `zenhosta/9drive`. Upstream remains the original product and copyright authority; the upstream live preview is not evidence that this ContextualWisdomLab fork is deployed from its current revision.

## Architecture

The repository contains a TypeScript full-stack application:

- `backend/`: Express API, Prisma persistence, authentication, Google Drive and S3-compatible provider integrations, upload routing, and synchronization.
- `frontend/`: React/Vite dashboard for storage, quota, file operations, account connections, and upload workflows.
- Docker Compose provides the repository-owned local deployment topology.

## Getting started

For the concise source and Docker onboarding path, use the [repository README](https://github.com/ContextualWisdomLab/9drive/blob/develop/README.md). Provider credentials and encryption/authentication secrets belong in local or deployment configuration and must not be committed.

## Operational boundaries

Before production use, configure HTTPS, production OAuth redirect/origin settings, durable secrets, database backup/migration procedures, and provider-specific access policies. Bind deployments to an exact reviewed fork commit and its current verification evidence; this fork currently has no GitHub Release.

## License and provenance

The fork restores the upstream Apache License 2.0 grant and upstream `Copyright 2026 Zenhosta` notice in the repository root. Third-party packages, provider APIs, storage services, databases, and container images remain under their own terms. The backend's inherited `ISC` package metadata is not treated as a replacement repository license.

## Documentation and support

- [Repository README](https://github.com/ContextualWisdomLab/9drive/blob/develop/README.md) — product, onboarding, architecture, verification, and fork provenance.
- [Root license](https://github.com/ContextualWisdomLab/9drive/blob/develop/LICENSE) — inherited Apache-2.0 source grant once this branch integrates.
- [Ask DeepWiki](https://deepwiki.com/ContextualWisdomLab/9drive) — repository-aware code and documentation navigation.
- [Upstream project](https://github.com/zenhosta/9drive) — original project and upstream service information.

This page is a GitHub Pages source prerequisite only. It is not evidence that Pages is published; publication is complete only after protected integration, repository settings reconciliation, successful deployment, and live HTTPS verification.
