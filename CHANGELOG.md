# Changelog

## Unreleased

- Rework the fork README and documentation around executable onboarding, product authority, release truth, and upstream Apache-2.0/ISC provenance.
- Align the Compose topology with MySQL, loopback-only host ports, and fail-closed secret inputs.
- Keep Google Drive uploads private by default and make server-database backup paths fail closed.
- Require 128-bit AES-GCM authentication tags and run both application images as non-root users; the frontend now serves its container-local Nginx endpoint on port 8080 while retaining host port 5173.
- Refresh compatible locked dependencies: backend `undici`, `brace-expansion`, `body-parser`, and `qs`, plus frontend `react-router`/`react-router-dom`; the remaining Prisma/deepmerge advisory requires a separately validated owner transition.
