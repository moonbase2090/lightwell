use lightwell_core::{BlockBase, FactBlock, FactGroup, FactMap, MapStats, Project, WorkspaceBlock};

fn main() -> Result<(), serde_json::Error> {
    let map = FactMap::schema_v1(
        Project {
            id: "workspace:example".to_owned(),
            name: "Example".to_owned(),
            root_path: ".".to_owned(),
        },
        vec![FactBlock::Workspace(WorkspaceBlock {
            base: BlockBase {
                id: "workspace:example".to_owned(),
                label: "Example".to_owned(),
                parent_id: None,
                children: Vec::new(),
                source_path: Some("Cargo.toml".to_owned()),
                fingerprint: "0".repeat(64),
            },
            member_count: 0,
        })],
        Vec::new(),
        vec![FactGroup {
            id: "group:crates".to_owned(),
            label: "Workspace crates".to_owned(),
            member_ids: Vec::new(),
        }],
        MapStats {
            blocks: 1,
            ..MapStats::default()
        },
    );

    println!("{}", serde_json::to_string_pretty(&map)?);
    Ok(())
}
