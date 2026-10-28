use std::path::{Component, Path};
use std::sync::OnceLock;

const IGNORED_DIRECTORY_NAMES_JSON: &str =
    include_str!("../../../shared/workspace-ignored-directories.json");

fn ignored_directory_names() -> &'static [&'static str] {
    static NAMES: OnceLock<Vec<&'static str>> = OnceLock::new();
    NAMES
        .get_or_init(|| {
            serde_json::from_str(IGNORED_DIRECTORY_NAMES_JSON)
                .expect("workspace ignored-directory list must be valid JSON")
        })
        .as_slice()
}

pub(crate) fn is_ignored_directory(name: &str) -> bool {
    ignored_directory_names()
        .iter()
        .any(|ignored| name.eq_ignore_ascii_case(ignored))
}

pub(crate) fn path_contains_ignored_directory(path: &Path) -> bool {
    path.components().any(|component| match component {
        Component::Normal(name) => name.to_str().is_some_and(is_ignored_directory),
        _ => false,
    })
}
