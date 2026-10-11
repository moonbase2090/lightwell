use lightwell_core::discover_cargo_workspace_manifest_only;
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

fn write_manifest(path: &PathBuf, contents: &str) {
    fs::write(path, contents).expect("write manifest");
}

#[test]
fn manifest_discovery_stays_within_opened_folder_without_cargo() {
    let root = temporary_directory("lw1-ws-nocargo");
    fs::create_dir_all(&root).expect("root");
    let parent = root.join("parent-ws");
    let sibling = parent.join("sibling");
    let child = parent.join("child");
    fs::create_dir_all(sibling.join("src")).expect("sibling tree");
    fs::create_dir_all(child.join("src")).expect("child tree");
    write_manifest(
        &parent.join("Cargo.toml"),
        r#"
[workspace]
members = ["child", "sibling"]
resolver = "2"

[workspace.package]
version = "0.1.0"
edition = "2021"
"#,
    );
    write_manifest(
        &sibling.join("Cargo.toml"),
        r#"
[package]
name = "sibling-pkg"
version.workspace = true
edition.workspace = true
description = "sibling-marker"
"#,
    );
    fs::write(sibling.join("src/lib.rs"), "pub fn sibling_only() {}\n").expect("sibling source");
    write_manifest(
        &child.join("Cargo.toml"),
        r#"
[package]
name = "child-pkg"
version.workspace = true
edition.workspace = true
"#,
    );
    fs::write(child.join("src/lib.rs"), "pub fn child_only() {}\n").expect("child source");

    let ws_nocargo = root.join("ws-nocargo");
    fs::create_dir_all(ws_nocargo.join("src")).expect("ws-nocargo");
    write_manifest(
        &ws_nocargo.join("Cargo.toml"),
        r#"
[package]
name = "ws-nocargo"
version = "0.1.0"
edition = "2021"
workspace = "../parent-ws"
"#,
    );
    fs::write(ws_nocargo.join("src/lib.rs"), "pub fn local_only() {}\n").expect("ws source");

    let workspace = discover_cargo_workspace_manifest_only(&ws_nocargo).expect("discover");
    assert_eq!(
        workspace.root,
        ws_nocargo.canonicalize().expect("canonical")
    );
    assert_eq!(workspace.packages.len(), 1);
    assert_eq!(workspace.packages[0].name, "ws-nocargo");
}

#[test]
fn manifest_discovery_rejects_absolute_workspace_members_outside_opened_folder() {
    let root = temporary_directory("lw1-glob");
    fs::create_dir_all(&root).expect("root");
    let victim = root.join("victim");
    fs::create_dir_all(victim.join("src")).expect("victim tree");
    write_manifest(
        &victim.join("Cargo.toml"),
        r#"
[package]
name = "victim-pkg"
version = "0.1.0"
edition = "2021"
description = "victim-marker"
"#,
    );
    fs::write(victim.join("src/lib.rs"), "pub fn victim_only() {}\n").expect("victim source");

    let globroot = root.join("globroot");
    fs::create_dir_all(&globroot).expect("globroot");
    write_manifest(
        &globroot.join("Cargo.toml"),
        &format!(
            r#"
[workspace]
members = ["{}"]
resolver = "2"
"#,
            victim.display()
        ),
    );

    let workspace = discover_cargo_workspace_manifest_only(&globroot).expect("discover");
    assert_eq!(workspace.root, globroot.canonicalize().expect("canonical"));
    assert!(
        workspace
            .packages
            .iter()
            .all(|package| package.name != "victim-pkg"),
        "victim package must not load from outside the opened folder"
    );
}

#[test]
fn manifest_discovery_inherits_workspace_metadata_for_opened_member() {
    let root = temporary_directory("lw1-member-inherit");
    fs::create_dir_all(&root).expect("root");
    let parent = root.join("parent-ws");
    let child = parent.join("child");
    fs::create_dir_all(child.join("src")).expect("child tree");
    write_manifest(
        &parent.join("Cargo.toml"),
        r#"
[workspace]
members = ["child"]
resolver = "2"

[workspace.package]
version = "2.0.0"
edition = "2021"
"#,
    );
    write_manifest(
        &child.join("Cargo.toml"),
        r#"
[package]
name = "child-pkg"
version.workspace = true
edition.workspace = true
"#,
    );
    fs::write(child.join("src/lib.rs"), "pub fn child_only() {}\n").expect("child lib");

    let workspace = discover_cargo_workspace_manifest_only(&child).expect("discover");
    assert_eq!(workspace.root, child.canonicalize().expect("canonical"));
    assert_eq!(workspace.packages.len(), 1);
    assert_eq!(workspace.packages[0].name, "child-pkg");
    assert_eq!(workspace.packages[0].version, "2.0.0");
}

#[test]
fn manifest_discovery_inherits_workspace_dependencies_for_opened_member() {
    let root = temporary_directory("lw1-member-ws-deps");
    fs::create_dir_all(&root).expect("root");
    let parent = root.join("parent-ws");
    let child = parent.join("child");
    let shared = parent.join("crates").join("shared");
    fs::create_dir_all(child.join("src")).expect("child tree");
    fs::create_dir_all(shared.join("src")).expect("shared tree");
    write_manifest(
        &parent.join("Cargo.toml"),
        r#"
[workspace]
members = ["child", "crates/shared"]
resolver = "2"

[workspace.package]
version = "0.1.0"
edition = "2021"

[workspace.dependencies]
shared = { path = "crates/shared", version = "1.0.0" }
"#,
    );
    write_manifest(
        &shared.join("Cargo.toml"),
        r#"
[package]
name = "shared"
version.workspace = true
edition.workspace = true
"#,
    );
    fs::write(shared.join("src/lib.rs"), "pub fn shared_only() {}\n").expect("shared lib");
    write_manifest(
        &child.join("Cargo.toml"),
        r#"
[package]
name = "child-pkg"
version.workspace = true
edition.workspace = true

[dependencies]
shared.workspace = true
"#,
    );
    fs::write(child.join("src/lib.rs"), "pub fn child_only() {}\n").expect("child lib");

    let workspace = discover_cargo_workspace_manifest_only(&child).expect("discover");
    assert_eq!(workspace.packages.len(), 1);
    assert_eq!(workspace.packages[0].name, "child-pkg");
    let shared_dep = workspace.packages[0]
        .dependencies
        .iter()
        .find(|dependency| dependency.name == "shared")
        .expect("workspace dependency");
    assert_eq!(
        shared_dep.path.as_deref(),
        Some(shared.canonicalize().expect("canonical").as_path())
    );
}
