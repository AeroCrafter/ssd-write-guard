# Security policy

SSD Write Guard is local-first. The scanner reads the machine that runs `npm start`, and the cleanup API can move selected stale logs to that machine's Trash. Do not expose `server.mjs` directly to the public internet.

## Public deployment boundary

Deploy only the `public/` directory to a public web server. In public/static mode:

- the browser can import a privacy-filtered JSON report;
- the browser cannot read or modify a visitor's files;
- cleanup controls remain disabled until a local helper is running on the same origin.

The included `deploy/nginx-codextest.conf` denies access to source files, hidden files, and server-side modules.

## Local helper boundary

The local server binds to `127.0.0.1` by default. Remote binding is rejected unless `SSD_GUARD_ALLOW_REMOTE=1` is set explicitly. Remote binding is not a supported public deployment mode because `/api/scan` and cleanup endpoints operate on the host filesystem.

## Reporting a vulnerability

Please do not publish sensitive paths, reports, credentials, or exploit details in a public issue. Contact the repository owner privately with reproduction steps and the affected version.

