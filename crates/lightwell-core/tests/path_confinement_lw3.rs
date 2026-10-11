use lightwell_core::{discover_cargo_workspace, extract_cargo_map, FactBlock};
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

fn temporary_directory(label: &str) -> PathBuf {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    std::env::temp_dir().join(format!("lightwell-{label}-{}-{unique}", std::process::id()))
}

#[test]
fn cargo_discovery_scopes_to_opened_workspace_member() {
    let root = temporary_directory("lw3-member");
    fs::create_dir_all(&root).expect("root");
    let parent = root.join("parent-ws");
    let sibling = parent.join("sibling");
    let child = parent.join("child");
    fs::create_dir_all(sibling.join("src")).expect("sibling");
    fs::create_dir_all(child.join("src")).expect("child");
    fs::write(
        parent.join("Cargo.toml"),
        r#"
[workspace]
members = ["child", "sibling"]
resolver = "2"

[workspace.package]
version = "0.1.0"
edition = "2021"
"#,
    )
    .expect("workspace manifest");
    fs::write(
        sibling.join("Cargo.toml"),
        r#"
[package]
name = "sibling-pkg"
version.workspace = true
edition.workspace = true
description = "sibling-marker-lw3"
"#,
    )
    .expect("sibling manifest");
    fs::write(sibling.join("src/lib.rs"), "pub fn sibling_only() {}\n").expect("sibling lib");
    fs::write(
        child.join("Cargo.toml"),
        r#"
[package]
name = "child-pkg"
version.workspace = true
edition.workspace = true
"#,
    )
    .expect("child manifest");
    fs::write(child.join("src/lib.rs"), "pub fn child_only() {}\n").expect("child lib");

    let workspace = discover_cargo_workspace(&child).expect("discover");
    assert_eq!(workspace.root, child.canonicalize().expect("canonical child"));
    assert_eq!(workspace.packages.len(), 1);
    assert_eq!(workspace.packages[0].name, "child-pkg");

    let map = extract_cargo_map(&child, None).expect("extract");
    let sibling_leak = map.blocks.iter().any(|block| match block {
        FactBlock::Crate(crate_block) => crate_block.package_name == "sibling-pkg",
        _ => false,
    });
    assert!(!sibling_leak, "sibling crates must not appear when opening a member folder");
}
