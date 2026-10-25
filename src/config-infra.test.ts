import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { configInfraFactBlocks, discoverConfigInfra } from "./extract/config-infra.js";
import { extractCargoMap } from "./extract/cargo.js";
import { CONFIG_INFRA_LANGUAGE_PACK } from "./languages/packs/config-infra.js";
import { languagePackForPath, monacoLanguageIdForPath } from "./languages/registry.js";

const fixtureRoot = fileURLToPath(new URL("../crates/lightwell-core/fixtures/config-infra-sample/", import.meta.url));

test("config/infra discovery extracts services, resources, jobs, Terraform and Docker stages", () => {
  const workspace = discoverConfigInfra(fixtureRoot);
  const compose = workspace.files.find((file) => file.path === "compose.yaml");
  assert.ok(compose);
  assert.ok(compose.entities.some((entity) => entity.kind === "service" && entity.name === "api"));
  assert.ok(compose.entities.some((entity) => entity.kind === "service" && entity.name === "db"));
  assert.ok(compose.entities.some((entity) => entity.kind === "resource" && entity.name === "volumes/data"));
  assert.ok(compose.entities.some((entity) => entity.kind === "resource" && entity.name === "networks/backend"));
  const workflow = workspace.files.find((file) => file.path === ".github/workflows/deploy.yml");
  assert.ok(workflow?.entities.some((entity) => entity.kind === "job" && entity.name === "deploy"));
  const kubernetes = workspace.files.find((file) => file.path === "k8s.yml");
  assert.ok(kubernetes?.entities.some((entity) => entity.kind === "deployment" && entity.name === "deployment/api"));
  assert.ok(kubernetes?.entities.some((entity) => entity.kind === "resource" && entity.name === "service/api"));
  const terraform = workspace.files.find((file) => file.path === "main.tf");
  assert.ok(terraform?.entities.some((entity) => entity.kind === "resource" && entity.name === "aws_instance.app"));
  const dockerfile = workspace.files.find((file) => file.path === "Dockerfile");
  assert.ok(dockerfile?.entities.some((entity) => entity.kind === "stage" && entity.name === "runtime"));
});

test("config/infra map connects service dependencies, build files, workflow needs, and Terraform modules", () => {
  const workspace = discoverConfigInfra(fixtureRoot);
  const facts = configInfraFactBlocks({ workspace, rootPath: fixtureRoot, workspaceId: "workspace:config" });
  const apiId = "module:config-infra:compose_2e_yaml:service:api";
  const dbId = "module:config-infra:compose_2e_yaml:service:db";
  const dockerfileId = "module:config-infra:Dockerfile";
  assert.ok(facts.connections.some((edge) => edge.kind === "depends_on" && edge.source === apiId && edge.target === dbId));
  assert.ok(facts.connections.some((edge) => edge.kind === "depends_on" && edge.source === apiId && edge.target === dockerfileId));
  assert.ok(facts.connections.some((edge) => edge.kind === "depends_on" && edge.source === apiId
    && edge.target === "module:config-infra:compose_2e_yaml:resource:volumes_2f_data"));
  assert.ok(facts.connections.some((edge) => edge.kind === "depends_on" && edge.source === apiId
    && edge.target === "module:config-infra:compose_2e_yaml:resource:networks_2f_backend"));
  const workflowDeploy = "module:config-infra:_2e_github_2f_workflows_2f_deploy_2e_yml:job:deploy";
  const workflowTest = "module:config-infra:_2e_github_2f_workflows_2f_deploy_2e_yml:job:test";
  assert.ok(facts.connections.some((edge) => edge.kind === "depends_on" && edge.source === workflowDeploy && edge.target === workflowTest));
  const terraformModule = "module:config-infra:main_2e_tf:terraform_2d_module:network";
  const terraformModuleFile = "module:config-infra:modules_2f_network_2f_main_2e_tf";
  assert.ok(facts.connections.some((edge) => edge.kind === "depends_on" && edge.source === terraformModule && edge.target === terraformModuleFile));
});

test("config/infra is available without Cargo and routes source highlighting by file name", () => {
  const map = extractCargoMap({ repositoryPath: fixtureRoot, projectName: "Infra" });
  assert.equal(map.project.name, "Infra");
  assert.ok(map.blocks.some((block) => block.type === "module" && block.language === "terraform" && block.modulePath === "main.tf#resource:aws_instance.app"));
  assert.ok(map.connections.some((edge) => edge.kind === "depends_on"
    && edge.source === "module:config-infra:compose_2e_yaml:service:api"
    && edge.target === "module:config-infra:compose_2e_yaml:service:db"));
  assert.equal(languagePackForPath("infra/main.tf")?.id, "config-infra");
  assert.equal(monacoLanguageIdForPath("infra/main.tf"), "terraform");
  assert.equal(monacoLanguageIdForPath("infra/compose.yaml"), "yaml");
  assert.equal(monacoLanguageIdForPath("infra/Dockerfile.dev"), "dockerfile");
  assert.equal(CONFIG_INFRA_LANGUAGE_PACK.extractor?.kind, "config-infra-module");
});
