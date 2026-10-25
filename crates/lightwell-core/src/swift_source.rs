use crate::metadata::CargoDiscoveryError;
use crate::path_confinement::{confined_canonical, opened_root};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct SwiftTarget {
    pub name: String,
    pub package_name: String,
    pub directory: PathBuf,
    pub files: Vec<SwiftFile>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct SwiftFile {
    pub path: PathBuf,
    pub unreadable: bool,
    pub imports: Vec<SwiftImport>,
    pub symbols: Vec<SwiftSymbol>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct SwiftImport {
    pub line: usize,
    pub module: String,
    pub statement: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum SwiftSymbolKind {
    Struct,
    Class,
    Enum,
    Protocol,
    Actor,
    Typealias,
    Func,
    Init,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct SwiftSymbol {
    pub name: String,
    pub kind: SwiftSymbolKind,
    pub line: usize,
}

impl SwiftSymbol {
    pub(crate) fn outline_label(&self) -> &'static str {
        match self.kind {
            SwiftSymbolKind::Struct => "struct",
            SwiftSymbolKind::Class => "class",
            SwiftSymbolKind::Enum => "enum",
            SwiftSymbolKind::Protocol => "protocol",
            SwiftSymbolKind::Actor => "actor",
            SwiftSymbolKind::Typealias => "typealias",
            SwiftSymbolKind::Func => "func",
            SwiftSymbolKind::Init => "init",
        }
    }
}

/// Discover SwiftPM / Xcode targets under `repository_path`.
/// Returns an empty list when neither `Package.swift` nor a `*.xcodeproj` is present.
pub(crate) fn discover_swift_targets(
    repository_path: &Path,
) -> Result<Vec<SwiftTarget>, CargoDiscoveryError> {
    let canonical_root = opened_root(repository_path)?;
    let package_swift = repository_path.join("Package.swift");
    if package_swift.is_file() {
        return discover_swiftpm(repository_path, &canonical_root, &package_swift);
    }
    if let Some(project) = find_xcodeproj(repository_path) {
        return discover_xcode(repository_path, &canonical_root, &project);
    }
    Ok(Vec::new())
}

pub(crate) fn parse_swift_source(source: &str) -> (Vec<SwiftImport>, Vec<SwiftSymbol>) {
    let source = source.strip_prefix('\u{feff}').unwrap_or(source);
    let stripped = strip_swift_comments(source);
    let imports = parse_imports(&stripped);
    let symbols = parse_symbols(&stripped);
    (imports, symbols)
}

fn discover_swiftpm(
    root: &Path,
    canonical_root: &Path,
    package_swift: &Path,
) -> Result<Vec<SwiftTarget>, CargoDiscoveryError> {
    let contents = fs::read_to_string(package_swift).map_err(|source| {
        CargoDiscoveryError::RepositoryPath {
            path: package_swift.to_owned(),
            source,
        }
    })?;
    let package_name = parse_package_name(&contents).unwrap_or_else(|| {
        root.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("SwiftPackage")
            .to_owned()
    });
    let target_names = parse_target_names(&contents);
    if target_names.is_empty() {
        return Ok(Vec::new());
    }
    let sources_root = root.join("Sources");
    let mut targets = Vec::new();
    let mut claimed = HashSet::new();
    for target_name in &target_names {
        let target_dir = sources_root.join(target_name);
        let tests_dir = root.join("Tests").join(target_name);
        let mut files = Vec::new();
        if target_dir.is_dir() {
            collect_swift_files(&target_dir, canonical_root, &mut files)?;
        }
        if tests_dir.is_dir() {
            collect_swift_files(&tests_dir, canonical_root, &mut files)?;
        }
        let directory = if target_dir.is_dir() {
            target_dir
        } else if tests_dir.is_dir() {
            tests_dir
        } else {
            sources_root.clone()
        };
        for path in &files {
            claimed.insert(path.clone());
        }
        files.sort();
        let swift_files = load_swift_files(&files)?;
        targets.push(SwiftTarget {
            name: target_name.clone(),
            package_name: package_name.clone(),
            directory,
            files: swift_files,
        });
    }
    // Single-module layout: Sources/*.swift (not in a target subfolder).
    if sources_root.is_dir() {
        let mut loose = Vec::new();
        collect_swift_files_shallow(&sources_root, canonical_root, &mut loose)?;
        loose.retain(|path| !claimed.contains(path));
        if !loose.is_empty() {
            let host_index = targets
                .iter()
                .position(|target| {
                    (!target.name.ends_with("Tests") && target.directory == sources_root)
                        || target.files.is_empty()
                })
                .or_else(|| (!targets.is_empty()).then_some(0));
            if let Some(index) = host_index {
                loose.sort();
                let mut loaded = load_swift_files(&loose)?;
                let host = &mut targets[index];
                host.files.append(&mut loaded);
                host.files.sort_by(|left, right| left.path.cmp(&right.path));
            }
        }
    }
    targets.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(targets)
}

fn discover_xcode(
    root: &Path,
    canonical_root: &Path,
    project: &Path,
) -> Result<Vec<SwiftTarget>, CargoDiscoveryError> {
    let project_stem = project
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or("App")
        .to_owned();
    let mut by_dir: HashMap<PathBuf, Vec<PathBuf>> = HashMap::new();
    walk_swift_files(root, canonical_root, &mut by_dir)?;
    let mut targets = Vec::new();
    for (directory, mut files) in by_dir {
        files.sort();
        let name = directory
            .file_name()
            .and_then(|value| value.to_str())
            .filter(|value| !value.is_empty() && *value != ".")
            .map(str::to_owned)
            .unwrap_or_else(|| project_stem.clone());
        let swift_files = load_swift_files(&files)?;
        targets.push(SwiftTarget {
            name,
            package_name: project_stem.clone(),
            directory,
            files: swift_files,
        });
    }
    targets.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(targets)
}

fn find_xcodeproj(root: &Path) -> Option<PathBuf> {
    let entries = fs::read_dir(root).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.ends_with(".xcodeproj") {
                return Some(path);
            }
        }
    }
    None
}

fn parse_package_name(contents: &str) -> Option<String> {
    let package_idx = contents.find("Package(")?;
    let after = &contents[package_idx..];
    let name_idx = after.find("name:")?;
    let after_name = after[name_idx + "name:".len()..].trim_start();
    let after_quote = after_name.strip_prefix('"')?;
    let end = after_quote.find('"')?;
    let name = &after_quote[..end];
    if name.is_empty() {
        None
    } else {
        Some(name.to_owned())
    }
}

fn parse_target_names(contents: &str) -> Vec<String> {
    const KINDS: &[&str] = &[".executableTarget(", ".testTarget(", ".target("];
    let mut names = Vec::new();
    let mut seen = HashSet::new();
    let mut search_from = 0usize;
    while search_from < contents.len() {
        let rest = &contents[search_from..];
        let mut best: Option<(usize, &str)> = None;
        for kind in KINDS {
            if let Some(idx) = rest.find(kind) {
                match best {
                    Some((best_idx, _)) if idx >= best_idx => {}
                    _ => best = Some((idx, kind)),
                }
            }
        }
        let Some((idx, kind)) = best else {
            break;
        };
        let after = &rest[idx + kind.len()..];
        let name = extract_name_argument(after);
        search_from += idx + kind.len();
        if let Some(name) = name {
            if seen.insert(name.clone()) {
                names.push(name);
            }
        }
    }
    names
}

fn extract_name_argument(after_open: &str) -> Option<String> {
    let name_idx = after_open.find("name:")?;
    // Avoid matching nested calls far from this target opener: stay within a window.
    if name_idx > 200 {
        return None;
    }
    let after_name = after_open[name_idx + "name:".len()..].trim_start();
    let after_quote = after_name.strip_prefix('"')?;
    let end = after_quote.find('"')?;
    let name = &after_quote[..end];
    if name.is_empty() {
        None
    } else {
        Some(name.to_owned())
    }
}

fn load_swift_files(paths: &[PathBuf]) -> Result<Vec<SwiftFile>, CargoDiscoveryError> {
    let mut files = Vec::new();
    for path in paths {
        match fs::read_to_string(path) {
            Ok(source) => {
                let (imports, symbols) = parse_swift_source(&source);
                files.push(SwiftFile {
                    path: path.clone(),
                    unreadable: false,
                    imports,
                    symbols,
                });
            }
            Err(_) => {
                files.push(SwiftFile {
                    path: path.clone(),
                    unreadable: true,
                    imports: Vec::new(),
                    symbols: Vec::new(),
                });
            }
        }
    }
    files.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(files)
}

fn collect_swift_files(
    directory: &Path,
    root: &Path,
    out: &mut Vec<PathBuf>,
) -> Result<(), CargoDiscoveryError> {
    let entries =
        fs::read_dir(directory).map_err(|source| CargoDiscoveryError::RepositoryPath {
            path: directory.to_owned(),
            source,
        })?;
    for entry in entries {
        let entry = entry.map_err(|source| CargoDiscoveryError::RepositoryPath {
            path: directory.to_owned(),
            source,
        })?;
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with('.') || skipped_directory(&name) {
            continue;
        }
        let file_type =
            entry
                .file_type()
                .map_err(|source| CargoDiscoveryError::RepositoryPath {
                    path: path.clone(),
                    source,
                })?;
        if file_type.is_dir() {
            collect_swift_files(&path, root, out)?;
            continue;
        }
        if is_swift_file(&path) && confined_swift_path(&path, root).is_some() {
            out.push(path);
        }
    }
    Ok(())
}

fn collect_swift_files_shallow(
    directory: &Path,
    root: &Path,
    out: &mut Vec<PathBuf>,
) -> Result<(), CargoDiscoveryError> {
    let entries =
        fs::read_dir(directory).map_err(|source| CargoDiscoveryError::RepositoryPath {
            path: directory.to_owned(),
            source,
        })?;
    for entry in entries {
        let entry = entry.map_err(|source| CargoDiscoveryError::RepositoryPath {
            path: directory.to_owned(),
            source,
        })?;
        let path = entry.path();
        let file_type =
            entry
                .file_type()
                .map_err(|source| CargoDiscoveryError::RepositoryPath {
                    path: path.clone(),
                    source,
                })?;
        if file_type.is_file() && is_swift_file(&path) && confined_swift_path(&path, root).is_some()
        {
            out.push(path);
        }
    }
    Ok(())
}

fn walk_swift_files(
    directory: &Path,
    root: &Path,
    packages: &mut HashMap<PathBuf, Vec<PathBuf>>,
) -> Result<(), CargoDiscoveryError> {
    let entries =
        fs::read_dir(directory).map_err(|source| CargoDiscoveryError::RepositoryPath {
            path: directory.to_owned(),
            source,
        })?;
    for entry in entries {
        let entry = entry.map_err(|source| CargoDiscoveryError::RepositoryPath {
            path: directory.to_owned(),
            source,
        })?;
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with('.') || skipped_directory(&name) || name.ends_with(".xcodeproj") {
            continue;
        }
        let file_type =
            entry
                .file_type()
                .map_err(|source| CargoDiscoveryError::RepositoryPath {
                    path: path.clone(),
                    source,
                })?;
        if file_type.is_dir() {
            walk_swift_files(&path, root, packages)?;
            continue;
        }
        if !is_swift_file(&path) {
            continue;
        }
        if confined_swift_path(&path, root).is_none() {
            continue;
        }
        let parent = path.parent().unwrap_or(directory).to_path_buf();
        packages.entry(parent).or_default().push(path);
    }
    Ok(())
}

fn confined_swift_path(path: &Path, root: &Path) -> Option<PathBuf> {
    match confined_canonical(path, root) {
        Ok(canonical) => Some(canonical),
        Err(CargoDiscoveryError::PathOutsideOpenedFolder { .. }) => None,
        Err(CargoDiscoveryError::RepositoryPath { source, .. })
            if source.kind() == io::ErrorKind::NotFound =>
        {
            None
        }
        Err(_) => None,
    }
}

fn skipped_directory(name: &str) -> bool {
    matches!(
        name,
        ".build"
            | "DerivedData"
            | ".git"
            | "node_modules"
            | "target"
            | "dist"
            | "vendor"
            | ".swiftpm"
    )
}

fn is_swift_file(path: &Path) -> bool {
    path.extension().and_then(|ext| ext.to_str()) == Some("swift")
}

fn strip_swift_comments(source: &str) -> String {
    let mut out = String::with_capacity(source.len());
    let chars: Vec<char> = source.chars().collect();
    let mut index = 0;
    while index < chars.len() {
        if chars[index] == '/' && index + 1 < chars.len() && chars[index + 1] == '/' {
            while index < chars.len() && chars[index] != '\n' {
                index += 1;
            }
            continue;
        }
        if chars[index] == '/' && index + 1 < chars.len() && chars[index + 1] == '*' {
            index += 2;
            while index < chars.len() {
                if index + 1 < chars.len() && chars[index] == '*' && chars[index + 1] == '/' {
                    index += 2;
                    break;
                }
                if chars[index] == '\n' {
                    out.push('\n');
                }
                index += 1;
            }
            continue;
        }
        if chars[index] == '"' {
            out.push('"');
            index += 1;
            // Triple-quoted strings
            if index + 1 < chars.len() && chars[index] == '"' && chars[index + 1] == '"' {
                out.push('"');
                out.push('"');
                index += 2;
                while index < chars.len() {
                    if chars[index] == '"'
                        && index + 2 < chars.len()
                        && chars[index + 1] == '"'
                        && chars[index + 2] == '"'
                    {
                        out.push('"');
                        out.push('"');
                        out.push('"');
                        index += 3;
                        break;
                    }
                    out.push(chars[index]);
                    index += 1;
                }
                continue;
            }
            while index < chars.len() {
                if chars[index] == '\\' {
                    out.push(chars[index]);
                    if index + 1 < chars.len() {
                        out.push(chars[index + 1]);
                    }
                    index += 2;
                    continue;
                }
                out.push(chars[index]);
                if chars[index] == '"' {
                    index += 1;
                    break;
                }
                index += 1;
            }
            continue;
        }
        if chars[index] == '\'' {
            out.push('\'');
            index += 1;
            while index < chars.len() {
                if chars[index] == '\\' {
                    out.push(chars[index]);
                    if index + 1 < chars.len() {
                        out.push(chars[index + 1]);
                    }
                    index += 2;
                    continue;
                }
                out.push(chars[index]);
                if chars[index] == '\'' {
                    index += 1;
                    break;
                }
                index += 1;
            }
            continue;
        }
        out.push(chars[index]);
        index += 1;
    }
    out
}

fn parse_imports(source: &str) -> Vec<SwiftImport> {
    let mut imports = Vec::new();
    for (index, line) in source.lines().enumerate() {
        let line_no = index + 1;
        let trimmed = line.trim();
        let rest = if let Some(rest) = trimmed.strip_prefix("import ") {
            rest.trim()
        } else if let Some(rest) = trimmed.strip_prefix("@_exported import ") {
            rest.trim()
        } else {
            continue;
        };
        // `import struct Module.Type` / `import class Module.Type` / plain `import Module`
        let (module, statement) = parse_import_rest(rest, trimmed);
        if module.is_empty() {
            continue;
        }
        imports.push(SwiftImport {
            line: line_no,
            module,
            statement,
        });
    }
    imports
}

fn parse_import_rest(rest: &str, full_line: &str) -> (String, String) {
    let kind_prefixes = [
        "struct ",
        "class ",
        "enum ",
        "protocol ",
        "actor ",
        "typealias ",
        "func ",
        "var ",
        "let ",
    ];
    let path = kind_prefixes
        .iter()
        .find_map(|prefix| rest.strip_prefix(prefix))
        .unwrap_or(rest)
        .trim();
    let module = path
        .split(|c: char| c == '.' || c.is_whitespace())
        .next()
        .unwrap_or("")
        .to_owned();
    let statement = full_line
        .trim()
        .trim_start_matches("@_exported ")
        .to_owned();
    let statement = if statement.starts_with("import ") {
        statement
    } else {
        format!("import {path}")
    };
    (module, statement)
}

fn parse_symbols(source: &str) -> Vec<SwiftSymbol> {
    let mut symbols = Vec::new();
    for (index, line) in source.lines().enumerate() {
        let line_no = index + 1;
        if let Some(symbol) = parse_symbol_line(line.trim(), line_no) {
            symbols.push(symbol);
        }
    }
    symbols
}

fn parse_symbol_line(line: &str, line_no: usize) -> Option<SwiftSymbol> {
    let mut rest = line;
    // Strip leading attributes and modifiers.
    loop {
        let trimmed = rest.trim_start();
        if trimmed.starts_with('@') {
            // Skip @attribute or @attribute(...)
            let after_at = &trimmed[1..];
            let name_end = after_at
                .find(|c: char| !c.is_ascii_alphanumeric() && c != '_')
                .unwrap_or(after_at.len());
            let after_name = &after_at[name_end..].trim_start();
            rest = if after_name.starts_with('(') {
                let close = find_matching_paren(after_name)?;
                after_name[close + 1..].trim_start()
            } else {
                after_name
            };
            continue;
        }
        const MODIFIERS: &[&str] = &[
            "public",
            "private",
            "open",
            "internal",
            "fileprivate",
            "final",
            "static",
            "override",
            "mutating",
            "nonmutating",
            "async",
            "throws",
            "rethrows",
            "indirect",
            "lazy",
            "weak",
            "unowned",
            "required",
            "convenience",
            "dynamic",
            "optional",
            "infix",
            "prefix",
            "postfix",
        ];
        let mut advanced = false;
        // `class` is a modifier only before func/var/let/subscript; otherwise it is a type keyword.
        if let Some(after) = trimmed.strip_prefix("class") {
            if after.starts_with(char::is_whitespace) {
                let next = after.trim_start();
                if next.starts_with("func")
                    || next.starts_with("var")
                    || next.starts_with("let")
                    || next.starts_with("subscript")
                {
                    rest = next;
                    advanced = true;
                }
            }
        }
        if !advanced {
            for modifier in MODIFIERS {
                if let Some(after) = trimmed.strip_prefix(modifier) {
                    if after.starts_with(char::is_whitespace) || after.is_empty() {
                        rest = after.trim_start();
                        advanced = true;
                        break;
                    }
                }
            }
        }
        if !advanced {
            rest = trimmed;
            break;
        }
    }
    if let Some(after) = rest.strip_prefix("func ") {
        let name = after
            .split(|c: char| c == '(' || c == '<' || c.is_whitespace())
            .next()?
            .trim();
        if name.is_empty() {
            return None;
        }
        return Some(SwiftSymbol {
            name: name.to_owned(),
            kind: SwiftSymbolKind::Func,
            line: line_no,
        });
    }
    if rest.starts_with("init") {
        let after = rest.strip_prefix("init")?;
        if after.starts_with('(')
            || after.starts_with('?')
            || after.starts_with('!')
            || after.starts_with('<')
        {
            return Some(SwiftSymbol {
                name: "init".to_owned(),
                kind: SwiftSymbolKind::Init,
                line: line_no,
            });
        }
    }
    for (keyword, kind) in [
        ("struct ", SwiftSymbolKind::Struct),
        ("class ", SwiftSymbolKind::Class),
        ("enum ", SwiftSymbolKind::Enum),
        ("protocol ", SwiftSymbolKind::Protocol),
        ("actor ", SwiftSymbolKind::Actor),
        ("typealias ", SwiftSymbolKind::Typealias),
    ] {
        if let Some(after) = rest.strip_prefix(keyword) {
            let name = after
                .split(|c: char| c == ':' || c == '{' || c == '<' || c == '=' || c.is_whitespace())
                .next()?
                .trim();
            if name.is_empty() {
                return None;
            }
            return Some(SwiftSymbol {
                name: name.to_owned(),
                kind,
                line: line_no,
            });
        }
    }
    None
}

fn find_matching_paren(source: &str) -> Option<usize> {
    let mut depth = 0;
    for (index, character) in source.char_indices() {
        match character {
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth == 0 {
                    return Some(index);
                }
            }
            _ => {}
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::{discover_swift_targets, parse_swift_source, SwiftSymbolKind};
    use crate::extract::extract_cargo_map;
    use crate::facts::FactBlock;
    use std::path::{Path, PathBuf};

    fn fixture_root() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/swift-sample")
    }

    #[test]
    fn fixture_lists_targets_files_imports_and_symbols() {
        let targets = discover_swift_targets(&fixture_root()).expect("swift fixture");
        assert!(
            targets.iter().any(|target| target.name == "Greeting"),
            "expected Greeting target"
        );
        assert!(
            targets.iter().any(|target| target.name == "Demo"),
            "expected Demo target"
        );
        let greeting = targets
            .iter()
            .find(|target| target.name == "Greeting")
            .expect("Greeting");
        let greeter = greeting
            .files
            .iter()
            .find(|file| {
                file.path.file_name().and_then(|name| name.to_str()) == Some("Greeter.swift")
            })
            .expect("Greeter.swift");
        assert!(greeter
            .imports
            .iter()
            .any(|import| import.module == "Foundation"));
        assert!(greeter
            .symbols
            .iter()
            .any(|symbol| { symbol.name == "Greeter" && symbol.kind == SwiftSymbolKind::Struct }));
        assert!(greeter
            .symbols
            .iter()
            .any(|symbol| symbol.name == "greet" && symbol.kind == SwiftSymbolKind::Func));
        let demo = targets
            .iter()
            .find(|target| target.name == "Demo")
            .expect("Demo");
        let main = demo
            .files
            .iter()
            .find(|file| file.path.file_name().and_then(|name| name.to_str()) == Some("main.swift"))
            .expect("main.swift");
        assert!(main
            .imports
            .iter()
            .any(|import| import.module == "Greeting"));
    }

    #[test]
    fn parse_import_struct_records_module_name() {
        let (imports, _) = parse_swift_source("import struct Foundation.Date\n");
        assert_eq!(imports.len(), 1);
        assert_eq!(imports[0].module, "Foundation");
    }

    #[test]
    fn block_comment_preserves_line_numbers_for_symbols() {
        let source = "/* block\n   comment */\npublic struct After {}\n";
        let (_, symbols) = parse_swift_source(source);
        assert_eq!(symbols.len(), 1);
        assert_eq!(symbols[0].name, "After");
        assert_eq!(symbols[0].line, 3);
    }

    #[test]
    fn parse_skips_comments_and_finds_types() {
        let source = "// struct Fake {}\npublic class Service {}\n";
        let (_, symbols) = parse_swift_source(source);
        assert_eq!(symbols.len(), 1);
        assert_eq!(symbols[0].name, "Service");
        assert_eq!(symbols[0].kind, SwiftSymbolKind::Class);
    }

    #[test]
    fn no_markers_returns_empty() {
        let empty = Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/python-sample");
        let targets = discover_swift_targets(&empty).expect("no swift markers");
        assert!(targets.is_empty());
    }

    #[test]
    fn swift_modules_merge_into_workspace_maps() {
        let root = fixture_root();
        let map = extract_cargo_map(&root, Some("Swift Sample")).expect("extract");
        let swift_blocks = map
            .blocks
            .iter()
            .filter_map(|block| match block {
                FactBlock::Module(module) if module.language == "swift" => Some(module),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert!(swift_blocks
            .iter()
            .any(|module| module.module_path.contains("Greeting")));
        assert!(swift_blocks.iter().any(|module| {
            module.base.label == "Greeter" || module.module_path.contains("Greeter")
        }));
        assert!(map.connections.iter().any(|connection| {
            matches!(
                connection,
                crate::facts::Connection::DependsOn {
                    source,
                    target,
                    ..
                } if source.contains("demo") && target.contains("greeting")
            )
        }));
    }
}
