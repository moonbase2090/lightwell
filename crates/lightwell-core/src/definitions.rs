use crate::editor::{EditorError, SourcePosition};
use crate::extract::block_base;
use crate::facts::FactMap;
use crate::jvm_source::JvmLanguage;
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use syn::ext::IdentExt;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SourceDefinition {
    pub name: String,
    pub block_id: String,
    pub position: SourcePosition,
}

/// Declarations in mapped files, with every source read confined to the opened workspace.
pub fn definitions_for_map(
    root: &Path,
    map: &FactMap,
) -> Result<Vec<SourceDefinition>, EditorError> {
    let root = root
        .canonicalize()
        .map_err(|source| EditorError::SourcePath {
            path: root.to_owned(),
            source,
        })?;
    let mut files = BTreeMap::new();
    for block in &map.blocks {
        let base = block_base(block);
        let Some(relative) = base.source_path.as_deref() else {
            continue;
        };
        let extension = Path::new(relative)
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if !matches!(
            extension.as_str(),
            "rs" | "ts"
                | "tsx"
                | "mts"
                | "cts"
                | "js"
                | "jsx"
                | "mjs"
                | "cjs"
                | "py"
                | "pyi"
                | "go"
                | "cs"
                | "vb"
                | "php"
                | "rb"
                | "java"
                | "kt"
                | "kts"
                | "swift"
                | "c"
                | "h"
                | "cc"
                | "cpp"
                | "cxx"
                | "hpp"
                | "hh"
                | "hxx"
        ) {
            continue;
        }
        let path =
            root.join(relative)
                .canonicalize()
                .map_err(|source| EditorError::SourcePath {
                    path: root.join(relative),
                    source,
                })?;
        if !path.starts_with(&root) {
            return Err(EditorError::SourceOutsideWorkspace(path));
        }
        files.entry(path).or_insert((base.id.clone(), extension));
    }
    let mut definitions = Vec::new();
    for (path, (block_id, extension)) in files {
        let source = fs::read_to_string(&path).map_err(|source| EditorError::SourcePath {
            path: path.clone(),
            source,
        })?;
        for (name, line, column) in declarations(&extension, &source) {
            let position =
                SourcePosition::new(line, column).expect("source parsers return one-based lines");
            definitions.push(SourceDefinition {
                name,
                block_id: block_id.clone(),
                position,
            });
        }
    }
    Ok(definitions)
}

fn declarations(extension: &str, source: &str) -> Vec<(String, usize, usize)> {
    macro_rules! symbols {
        ($symbols:expr) => {
            $symbols
                .into_iter()
                .map(|symbol| (symbol.name, symbol.line, 1))
                .collect()
        };
    }
    match extension {
        "rs" => {
            let Ok(file) = syn::parse_file(source) else {
                return Vec::new();
            };
            let mut names = Vec::new();
            rust_items(&file.items, source, &mut names);
            names
        }
        "ts" | "tsx" | "mts" | "cts" | "js" | "jsx" | "mjs" | "cjs" => {
            symbols!(crate::typescript_source::parse_typescript_source(source).1)
        }
        "py" | "pyi" => symbols!(crate::python_source::parse_python_source(source).1),
        "go" => symbols!(crate::go_source::parse_go_source(source).1),
        "cs" => symbols!(crate::dotnet_source::parse_csharp_source(source).1),
        "vb" => symbols!(crate::dotnet_source::parse_vb_source(source).1),
        "php" => symbols!(crate::php_source::parse_php_source(source).2),
        "rb" => symbols!(crate::ruby_source::parse_ruby_source(source).1),
        "java" => symbols!(crate::jvm_source::parse_jvm_source(source, JvmLanguage::Java).1),
        "kt" | "kts" => {
            symbols!(crate::jvm_source::parse_jvm_source(source, JvmLanguage::Kotlin).1)
        }
        "swift" => symbols!(crate::swift_source::parse_swift_source(source).1),
        "c" | "h" | "cc" | "cpp" | "cxx" | "hpp" | "hh" | "hxx" => {
            symbols!(crate::cpp_source::parse_cpp_source(source).1)
        }
        _ => Vec::new(),
    }
}

fn rust_items(items: &[syn::Item], source: &str, names: &mut Vec<(String, usize, usize)>) {
    for item in items {
        let ident = match item {
            syn::Item::Fn(item) => Some(&item.sig.ident),
            syn::Item::Struct(item) => Some(&item.ident),
            syn::Item::Enum(item) => Some(&item.ident),
            syn::Item::Union(item) => Some(&item.ident),
            syn::Item::Trait(item) => Some(&item.ident),
            syn::Item::TraitAlias(item) => Some(&item.ident),
            syn::Item::Type(item) => Some(&item.ident),
            syn::Item::Const(item) => Some(&item.ident),
            syn::Item::Static(item) => Some(&item.ident),
            syn::Item::Mod(item) => {
                if let Some((_, items)) = &item.content {
                    rust_items(items, source, names);
                }
                None
            }
            _ => None,
        };
        if let Some(ident) = ident {
            let start = ident.span().start();
            let column = source
                .lines()
                .nth(start.line - 1)
                .expect("span line exists")
                .chars()
                .take(start.column)
                .map(char::len_utf16)
                .sum::<usize>()
                + 1;
            names.push((ident.unraw().to_string(), start.line, column));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::extract::extract_cargo_map;

    fn fixture(source: &str) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("src")).unwrap();
        fs::write(
            dir.path().join("Cargo.toml"),
            "[package]\nname = \"definitions-fixture\"\nversion = \"0.1.0\"\nedition = \"2021\"\n",
        )
        .unwrap();
        fs::write(dir.path().join("src/lib.rs"), source).unwrap();
        dir
    }

    #[test]
    fn indexes_real_files_once_and_returns_declaration_positions() {
        let dir = fixture(
            "pub mod external;\npub mod inline { pub fn inner() {} }\npub fn caller() {}\n",
        );
        fs::write(dir.path().join("src/external.rs"), "// Not a declaration: fn fake() {}\npub fn calculate() -> i32 { 7 }\npub struct Widget;\n").unwrap();
        let map = extract_cargo_map(dir.path(), None).unwrap();
        let definitions = definitions_for_map(dir.path(), &map).unwrap();
        let mut locations: Vec<_> = definitions
            .into_iter()
            .map(|definition| {
                let block = map
                    .blocks
                    .iter()
                    .map(block_base)
                    .find(|block| block.id == definition.block_id)
                    .unwrap();
                (
                    definition.name,
                    block.source_path.clone().unwrap(),
                    definition.position.line(),
                    definition.position.column(),
                )
            })
            .collect();
        locations.sort();
        assert_eq!(
            locations,
            vec![
                ("Widget".to_owned(), "src/external.rs".to_owned(), 3, 12),
                ("calculate".to_owned(), "src/external.rs".to_owned(), 2, 8),
                ("caller".to_owned(), "src/lib.rs".to_owned(), 3, 8),
                ("inner".to_owned(), "src/lib.rs".to_owned(), 2, 25),
            ]
        );
    }

    #[test]
    fn rust_uses_syntax_instead_of_comment_or_string_matches() {
        assert_eq!(declarations("rs", "// fn fake() {}\nconst TEXT: &str = \"fn quoted() {}\";\npub fn actual() { fn local() {} }\n"), vec![("TEXT".to_owned(), 2, 7), ("actual".to_owned(), 3, 8)]);
        assert!(declarations("rs", "pub fn unfinished(").is_empty());
    }

    #[test]
    fn reuses_the_builtin_code_language_parsers() {
        for (extension, source, name) in [
            (
                "ts",
                "// comment\nexport function value() { return 7; }\n",
                "value",
            ),
            ("py", "# comment\ndef value():\n    return 7\n", "value"),
            (
                "go",
                "package demo\nfunc Value() int { return 7 }\n",
                "Value",
            ),
            ("php", "<?php\nfunction value() { return 7; }\n", "value"),
            ("rb", "# comment\ndef value\n  7\nend\n", "value"),
            ("cpp", "// comment\nint value() { return 7; }\n", "value"),
            ("kt", "// comment\nfun value(): Int = 7\n", "value"),
            (
                "swift",
                "// comment\nfunc value() -> Int { return 7 }\n",
                "value",
            ),
            ("java", "// comment\nclass Example {}\n", "Example"),
            ("cs", "// comment\npublic class Example {}\n", "Example"),
            (
                "vb",
                "' comment\nPublic Class Example\nEnd Class\n",
                "Example",
            ),
        ] {
            assert_eq!(
                declarations(extension, source),
                vec![(name.to_owned(), 2, 1)],
                "{extension}"
            );
        }
    }

    #[test]
    fn rust_columns_use_the_identifier_span_and_monaco_utf16_units() {
        assert_eq!(
            declarations("rs", "#[doc = \"calculate\"] pub fn calculate() {}\n"),
            vec![("calculate".to_owned(), 1, 29)]
        );
        assert_eq!(
            declarations("rs", "#[doc = \"🐈\"] pub fn calculate() {}\n"),
            vec![("calculate".to_owned(), 1, 22)]
        );
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_mapped_file_that_now_resolves_outside_the_workspace() {
        let dir = fixture("pub mod external;\n");
        let path = dir.path().join("src/external.rs");
        fs::write(&path, "pub fn inside() {}\n").unwrap();
        let map = extract_cargo_map(dir.path(), None).unwrap();
        let outside = tempfile::tempdir().unwrap();
        let external = outside.path().join("external.rs");
        fs::write(&external, "pub fn outside_secret() {}\n").unwrap();
        fs::remove_file(&path).unwrap();
        std::os::unix::fs::symlink(external, path).unwrap();
        assert!(matches!(
            definitions_for_map(dir.path(), &map),
            Err(EditorError::SourceOutsideWorkspace(_))
        ));
    }
}
