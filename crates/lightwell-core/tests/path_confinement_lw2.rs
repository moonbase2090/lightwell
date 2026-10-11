use lightwell_core::{extract_cargo_map, FactBlock};
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
fn extraction_does_not_read_rust_sources_outside_opened_folder() {
    let root = temporary_directory("lw2-path");
    fs::create_dir_all(&root).expect("root");
    let outside = root.join("outside");
    let workspace = root.join("ws-path");
    fs::create_dir_all(&outside).expect("outside");
    fs::create_dir_all(workspace.join("src")).expect("workspace src");
    fs::write(
        outside.join("secret.rs"),
        "#[doc = \"outside-marker-9f3a\"]\nmod inner {}\n",
    )
    .expect("outside source");
    fs::write(
        workspace.join("Cargo.toml"),
        "[package]\nname = \"ws-path\"\nversion = \"0.1.0\"\nedition = \"2021\"\n",
    )
    .expect("manifest");
    fs::write(
        workspace.join("src/lib.rs"),
        &format!(
            "#[path = \"{}\"]\nmod stolen;\n",
            outside.join("secret.rs").display()
        ),
    )
    .expect("lib");

    let map = extract_cargo_map(&workspace, None).expect("extract");
    let leaked = map
        .blocks
        .iter()
        .filter_map(|block| match block {
            FactBlock::Module(module) => Some(module.cfg_attributes.join(" ")),
            _ => None,
        })
        .any(|attributes| attributes.contains("outside-marker-9f3a"));
    assert!(
        !leaked,
        "outside source attributes must not appear in the map"
    );
}
