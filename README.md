# setup-local-ydb

[![GitHub Marketplace](https://img.shields.io/badge/Marketplace-setup--local--ydb-blue?logo=github)](https://github.com/marketplace/actions/setup-local-ydb)
[![Action users](https://img.shields.io/endpoint?url=https://astandrik.github.io/setup-local-ydb/endpoints/setup-local-ydb.json)](https://github.com/search?q=%22astandrik%2Fsetup-local-ydb%22+path%3A.github%2Fworkflows+language%3AYAML&type=code)

Provision local YDB in GitHub Actions CI.

This action starts Docker-based `local-ydb` on a Linux runner and exports connection settings for later workflow steps. The default `tenant` topology preserves the static + dynamic-node stack; the opt-in `root` topology starts only the static `/local` database.

```yaml
steps:
  - uses: actions/checkout@v6

  - uses: astandrik/setup-local-ydb@v1
    id: ydb
    with:
      version: 26.1.1.6
      topology: tenant
      tenant: /local/test

  - run: |
      echo "$LOCAL_YDB_ENDPOINT"
      echo "$LOCAL_YDB_DATABASE"
```

The action starts `ghcr.io/ydb-platform/local-ydb`, waits until the selected database is reachable, and exports connection settings for later steps.

Use the root-only topology when tests need the embedded `/local` database without a CMS tenant, GraphShard, or dynamic node:

```yaml
- uses: astandrik/setup-local-ydb@v1
  id: ydb
  with:
    version: 26.1.1.6
    topology: root

- run: |
    test "${{ steps.ydb.outputs.database }}" = "/local"
    test "${{ steps.ydb.outputs.endpoint }}" = "${{ steps.ydb.outputs.static-endpoint }}"
```

Enable native YDB auth when your tests need authenticated behavior:

```yaml
- uses: astandrik/setup-local-ydb@v1
  with:
    version: 26.1.1.6
    topology: root
    auth: true
```

In root auth mode the action hardens and restarts only the static node, verifies authenticated access to `/local`, and confirms anonymous viewer access returns HTTP 401.

## Examples

- [Basic local YDB workflow](examples/basic.yml)
- [Native auth workflow](examples/auth.yml)
- [Root-only local YDB workflow](examples/root.yml)
- [Node.js integration tests](examples/node-tests.yml)

## Versioning

Use `astandrik/setup-local-ydb@v1` to receive compatible v1 updates. Pin an immutable release such as `astandrik/setup-local-ydb@v1.1.0` when a workflow needs fully reproducible action code.

## Inputs

| Name | Default | Description |
| --- | --- | --- |
| `version` | `26.1.1.6` | Exact `ghcr.io/ydb-platform/local-ydb` tag, or `latest` to resolve the newest numeric tag. |
| `topology` | `tenant` | `tenant` starts static + dynamic nodes; `root` starts only static `/local`. |
| `tenant` | `/local/test` | Tenant database path for `tenant` topology. Ignored for `root`. |
| `auth` | `false` | Enable native YDB auth after bootstrapping the selected topology. |
| `cleanup` | `true` | Remove action-created containers, network, volume, and auth directory in the post step. |
| `static-grpc-port` | auto | Host port for `/local` root/static gRPC. |
| `dynamic-grpc-port` | auto | Host port for the tenant dynamic-node gRPC endpoint. Not applicable to `root`. |
| `monitoring-port` | auto | Host port for monitoring. |
| `container-prefix` | auto | Prefix for Docker resource names. |

## Outputs

| Name | Description |
| --- | --- |
| `endpoint` | Application gRPC endpoint: dynamic for `tenant`, static for `root`. |
| `static-endpoint` | Static/root gRPC endpoint. |
| `database` | Effective database path: the tenant input for `tenant`, `/local` for `root`. |
| `monitoring-url` | Monitoring URL for host steps. In `root` topology the same port is reachable from sibling Docker containers through the runner host. |
| `image` | Full Docker image reference used by the action. |
| `resolved-version` | Concrete image tag used by the action. |
| `username` | `root` when `auth: true`. |
| `password-file` | Root password file path when `auth: true`. |

The same values are also exported as `LOCAL_YDB_ENDPOINT`, `LOCAL_YDB_DATABASE`, and `LOCAL_YDB_MONITORING_URL`. When auth is enabled, `LOCAL_YDB_USER` and `LOCAL_YDB_PASSWORD_FILE` are exported too. The password value is never written as an output.

## Notes

- Linux runners with Docker are required.
- Static gRPC and all `tenant` topology ports are bound to `127.0.0.1`.
- `root` monitoring is published on all runner interfaces so sibling Docker containers can connect through `host.docker.internal:<monitoring-port>`; use `auth: true` on untrusted runners.
- `root` topology does not create a CMS tenant, GraphShard, dynamic node, or dynamic-node token.
- Prefer exact image tags for reproducible CI.
- SSH profiles, MCP tools, storage migration, version upgrades, dump/restore, and remote-host operations are outside v1 scope.

## Support

- Questions, bugs, and feature requests: [GitHub Issues](https://github.com/astandrik/setup-local-ydb/issues).
- Security reports: see [SECURITY.md](SECURITY.md).
- Related project: [`local-ydb-toolkit`](https://github.com/astandrik/local-ydb-toolkit).
