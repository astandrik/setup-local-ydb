import * as core from "./core";
import { buildRuntimeConfig, parseActionInputs } from "./config";
import { CommandRunner } from "./exec";
import { resolveRuntimePorts } from "./ports";
import { saveRuntimeState } from "./state";
import { resolveLocalYdbVersion } from "./version";
import { collectDiagnostics, setupLocalYdb } from "./ydb";

async function run(): Promise<void> {
  const runner = new CommandRunner();
  let runtimeConfig: ReturnType<typeof buildRuntimeConfig> | undefined;
  try {
    const inputs = parseActionInputs(core.getInput, process.env);
    const resolvedVersion = await resolveLocalYdbVersion(inputs.version);
    const ports = await resolveRuntimePorts(inputs);
    runtimeConfig = buildRuntimeConfig(inputs, ports, resolvedVersion, process.env);
    saveRuntimeState(runtimeConfig);

    core.info(`Starting ${runtimeConfig.image} for ${runtimeConfig.tenantPath}`);
    await setupLocalYdb(runtimeConfig, runner);

    core.setOutput("endpoint", runtimeConfig.endpoint);
    core.setOutput("static-endpoint", runtimeConfig.staticEndpoint);
    core.setOutput("database", runtimeConfig.tenantPath);
    core.setOutput("monitoring-url", runtimeConfig.monitoringUrl);
    core.setOutput("image", runtimeConfig.image);
    core.setOutput("resolved-version", runtimeConfig.version);
    core.exportVariable("LOCAL_YDB_ENDPOINT", runtimeConfig.endpoint);
    core.exportVariable("LOCAL_YDB_DATABASE", runtimeConfig.tenantPath);
    core.exportVariable("LOCAL_YDB_MONITORING_URL", runtimeConfig.monitoringUrl);

    if (runtimeConfig.auth) {
      core.setOutput("username", runtimeConfig.rootUser);
      core.setOutput("password-file", runtimeConfig.rootPasswordFile);
      core.exportVariable("LOCAL_YDB_USER", runtimeConfig.rootUser);
      core.exportVariable("LOCAL_YDB_PASSWORD_FILE", runtimeConfig.rootPasswordFile);
    }
  } catch (error) {
    if (runtimeConfig) {
      await collectDiagnostics(runtimeConfig, runner).catch((diagnosticError: unknown) => {
        core.warning(diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError));
      });
    }
    core.setFailed(error instanceof Error ? error.message : String(error));
  }
}

void run();
