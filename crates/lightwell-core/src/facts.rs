use serde::Serialize;

pub const MAP_SCHEMA_VERSION: u32 = 1;

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub root_path: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockBase {
    pub id: String,
    pub label: String,
    pub parent_id: Option<String>,
    pub children: Vec<String>,
    pub source_path: Option<String>,
    pub fingerprint: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceBlock {
    #[serde(flatten)]
    pub base: BlockBase,
    pub member_count: usize,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CrateBlock {
    #[serde(flatten)]
    pub base: BlockBase,
    pub package_name: String,
    pub version: String,
    pub description: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppBlock {
    #[serde(flatten)]
    pub base: BlockBase,
    pub package_name: String,
    pub target_name: String,
    pub entry_path: String,
    pub target_kind: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModuleBlock {
    #[serde(flatten)]
    pub base: BlockBase,
    pub package_name: String,
    pub module_path: String,
    pub declared_by_path: String,
    pub cfg_attributes: Vec<String>,
    pub unresolved: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CargoFeatureBlock {
    #[serde(flatten)]
    pub base: BlockBase,
    pub package_name: String,
    pub feature_name: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum FactBlock {
    Workspace(WorkspaceBlock),
    Crate(CrateBlock),
    App(AppBlock),
    Module(ModuleBlock),
    CargoFeature(CargoFeatureBlock),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DependencyScope {
    Normal,
    Build,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Connection {
    Contains {
        id: String,
        source: String,
        target: String,
    },
    DependsOn {
        id: String,
        source: String,
        target: String,
        #[serde(rename = "dependencyScope")]
        dependency_scope: DependencyScope,
    },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FactGroup {
    pub id: String,
    pub label: String,
    pub member_ids: Vec<String>,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MapStats {
    pub blocks: usize,
    pub connections: usize,
    pub crates: usize,
    pub apps: usize,
    pub modules: usize,
    pub cargo_features: usize,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FactMap {
    pub schema_version: u32,
    pub project: Project,
    pub blocks: Vec<FactBlock>,
    pub connections: Vec<Connection>,
    pub groups: Vec<FactGroup>,
    pub stats: MapStats,
}

impl FactMap {
    pub fn schema_v1(
        project: Project,
        blocks: Vec<FactBlock>,
        connections: Vec<Connection>,
        groups: Vec<FactGroup>,
        stats: MapStats,
    ) -> Self {
        Self {
            schema_version: MAP_SCHEMA_VERSION,
            project,
            blocks,
            connections,
            groups,
            stats,
        }
    }
}
