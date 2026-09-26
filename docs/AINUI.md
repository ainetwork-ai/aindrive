# AIN-UI integration

The canonical protocol, catalog, builders and renderers are maintained in
[ainetwork-ai/AIN-UI](https://github.com/ainetwork-ai/AIN-UI) and published as
[`ain-ui`](https://www.npmjs.com/package/ain-ui). See its
[protocol specification](https://github.com/ainetwork-ai/AIN-UI/blob/main/docs/AINUI.md).

Aindrive's `web/shared/a2ui/` modules re-export the package for existing callers.
`web/lib/ainui.ts` injects storage, permission and MIME callbacks. MCP, AG-UI
and A2A negotiate AIN-UI as before. The package's upload action checks the
allow-list and write capability before `write_file`; uploads are limited to
8 MiB on JSON transports. Larger files use aindrive's resumable upload routes.

`GET /api/s/:token` accepts `X-AINUI: 1` and includes the package's payment
surface in `messages`, alongside the unchanged x402 header. Both aindrive's
checkout and ainmem render this surface; wallet signing stays in the host.
`GET /ainui/v1/catalog.json` serves the package's generated catalog.

AIN-UI release changes must be made in the package repository, published,
and then consumed by updating `web/package.json` and its lockfile.
