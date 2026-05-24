import { createServer } from "node:net";
import type { ActionInputs, RuntimePorts } from "./config";

export async function resolveRuntimePorts(inputs: ActionInputs): Promise<RuntimePorts> {
  const used = new Set<number>();
  const staticGrpc = inputs.staticGrpcPort ?? await findOpenPort(used);
  used.add(staticGrpc);
  const dynamicGrpc = inputs.dynamicGrpcPort ?? await findOpenPort(used);
  used.add(dynamicGrpc);
  const monitoring = inputs.monitoringPort ?? await findOpenPort(used);
  used.add(monitoring);

  const duplicates = [staticGrpc, dynamicGrpc, monitoring].filter((port, index, ports) => ports.indexOf(port) !== index);
  if (duplicates.length > 0) {
    throw new Error(`static-grpc-port, dynamic-grpc-port, and monitoring-port must be unique. Duplicate: ${duplicates.join(", ")}`);
  }

  return {
    staticGrpc,
    dynamicGrpc,
    monitoring,
    dynamicMonitoring: 8766,
    dynamicIc: 19002
  };
}

async function findOpenPort(excluded: Set<number>): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const port = await listenOnRandomPort();
    if (!excluded.has(port)) {
      return port;
    }
  }
  throw new Error("Could not allocate a free localhost port");
}

function listenOnRandomPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Could not read allocated port")));
        return;
      }
      const port = address.port;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

