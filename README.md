# setup-local-ydb

GitHub Action for starting a Docker-based `local-ydb` stack in CI.

```yaml
steps:
  - uses: actions/checkout@v6

  - uses: astandrik/setup-local-ydb@v1
    id: ydb
    with:
      version: 26.1.1.6
      tenant: /local/test
      auth: true

  - run: |
      echo "$LOCAL_YDB_ENDPOINT"
      echo "$LOCAL_YDB_DATABASE"
```

The action starts `ghcr.io/ydb-platform/local-ydb`, creates a CMS tenant database such as `/local/test`, waits until the tenant metadata is reachable, and exports connection settings for later steps.

## Inputs

| Name | Default | Description |
| --- | --- | --- |
| `version` | `26.1.1.6` | Exact `ghcr.io/ydb-platform/local-ydb` tag, or `latest` to resolve the newest numeric tag. |
| `tenant` | `/local/test` | Tenant database path to create. |
| `auth` | `false` | Enable native YDB auth after bootstrapping the tenant. |
| `cleanup` | `true` | Remove action-created containers, network, and volume in the post step. |
| `static-grpc-port` | auto | Host port for `/local` root/static gRPC. |
| `dynamic-grpc-port` | auto | Host port for the tenant dynamic-node gRPC endpoint. |
| `monitoring-port` | auto | Host port for monitoring. |
| `container-prefix` | auto | Prefix for Docker resource names. |

## Outputs

| Name | Description |
| --- | --- |
| `endpoint` | Dynamic tenant gRPC endpoint. |
| `static-endpoint` | Static/root gRPC endpoint. |
| `database` | Tenant database path. |
| `monitoring-url` | Loopback monitoring URL. |
| `image` | Full Docker image reference used by the action. |
| `resolved-version` | Concrete image tag used by the action. |
| `username` | `root` when `auth: true`. |
| `password-file` | Root password file path when `auth: true`. |

The same values are also exported as `LOCAL_YDB_ENDPOINT`, `LOCAL_YDB_DATABASE`, and `LOCAL_YDB_MONITORING_URL`. When auth is enabled, `LOCAL_YDB_USER` and `LOCAL_YDB_PASSWORD_FILE` are exported too. The password value is never written as an output.

## Notes

- Linux runners with Docker are required.
- All host ports are bound to `127.0.0.1`.
- Prefer exact image tags for reproducible CI.
- SSH profiles, MCP tools, storage migration, version upgrades, dump/restore, and remote-host operations are outside v1 scope.

