import { createServer } from "node:net";
import type { ActionInputs, RuntimePorts } from "./config";

export async function resolveRuntimePorts(inputs: ActionInputs): Promise<RuntimePorts> {
  const used = new Set<number>();
  const staticGrpc = inputs.staticGrpcPort ?? await findOpenPort(used);
  used.add(staticGrpc);
  const dynamicGrpc = inputs.topology === "tenant"
    ? inputs.dynamicGrpcPort ?? await findOpenPort(used)
    : undefined;
  if (dynamicGrpc !== undefined) {
    used.add(dynamicGrpc);
  }
  const monitoring = inputs.monitoringPort ?? await findOpenPort(used);
  used.add(monitoring);

  const publishedPorts = [staticGrpc, dynamicGrpc, monitoring].filter((port): port is number => port !== undefined);
  const duplicates = publishedPorts.filter((port, index, ports) => ports.indexOf(port) !== index);
  if (duplicates.length > 0) {
    throw new Error(`Published ports must be unique. Duplicate: ${duplicates.join(", ")}`);
  }

  const ports: RuntimePorts = {
    staticGrpc,
    monitoring
  };
  if (inputs.topology === "tenant") {
    ports.dynamicGrpc = dynamicGrpc;
    ports.dynamicMonitoring = 8766;
    ports.dynamicIc = 19002;
  }
  return ports;
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
