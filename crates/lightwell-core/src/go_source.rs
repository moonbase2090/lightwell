use crate::metadata::CargoDiscoveryError;
use crate::path_confinement::{confined_canonical, opened_root};
use crate::workspace_ignore::is_ignored_directory;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct GoPackage {
    pub import_path: String,
    pub name: String,
    pub directory: PathBuf,
    pub files: Vec<GoFile>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct GoFile {
    pub path: PathBuf,
    pub test: bool,
    pub unreadable: bool,
    pub imports: Vec<GoImport>,
    pub symbols: Vec<GoSymbol>,
    pub calls: Vec<GoCall>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct GoImport {
    pub line: usize,
    pub path: String,
    pub alias: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum GoSymbolKind {
    Func,
    Method,
    Type,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct GoSymbol {
    pub name: String,
    pub kind: GoSymbolKind,
    pub line: usize,
    pub receiver: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct GoCall {
    pub line: usize,
    pub qualifier: String,
    pub name: String,
}

impl GoImport {
    pub(crate) fn statement(&self) -> String {
        match &self.alias {
            Some(alias) => format!("import {alias} \"{}\"", self.path),
            None => format!("import \"{}\"", self.path),
        }
    }
}

/// Map local import alias (or default package name) to import path.
pub(crate) fn go_import_alias_paths(imports: &[GoImport]) -> HashMap<String, String> {
    let mut alias_to_path = HashMap::new();
    for import in imports {
        if import.alias.as_deref() == Some("_") || import.alias.as_deref() == Some(".") {
            continue;
        }
        let alias = import
            .alias
            .clone()
            .or_else(|| import.path.rsplit('/').next().map(str::to_owned))
            .unwrap_or_default();
        if !alias.is_empty() {
            alias_to_path.insert(alias, import.path.clone());
        }
    }
    alias_to_path
}

impl GoSymbol {
    pub(crate) fn outline_label(&self) -> &'static str {
        match self.kind {
            GoSymbolKind::Func => "func",
            GoSymbolKind::Method => "method",
            GoSymbolKind::Type => "type",
        }
    }
}

/// Discover Go packages under `repository_path`. Skips `vendor/` and `testdata/`.
/// `*_test.go` files are included as separate file blocks with test-only symbols.
pub(crate) fn discover_go_packages(
    repository_path: &Path,
) -> Result<Vec<GoPackage>, CargoDiscoveryError> {
    let canonical_root = opened_root(repository_path)?;
    let module_path = read_go_module_path(repository_path)?;
    let mut directories: HashMap<PathBuf, Vec<PathBuf>> = HashMap::new();
    let mut seen = HashSet::new();
    walk_go_files(
        repository_path,
        &canonical_root,
        &mut seen,
        &mut directories,
    )?;
    let mut packages = directories
        .into_iter()
        .map(|(directory, files)| {
            package_from_directory(repository_path, &module_path, &directory, &files)
        })
        .collect::<Result<Vec<_>, _>>()?;
    packages.sort_by(|left, right| left.import_path.cmp(&right.import_path));
    Ok(packages)
}

pub(crate) fn parse_go_source(source: &str) -> (Vec<GoImport>, Vec<GoSymbol>, Vec<GoCall>) {
    let source = source.strip_prefix('\u{feff}').unwrap_or(source);
    let stripped = strip_go_comments(source);
    let imports = parse_imports(&stripped);
    let symbols = parse_symbols(&stripped);
    let calls = parse_calls(&stripped, &imports);
    (imports, symbols, calls)
}

fn read_go_module_path(root: &Path) -> Result<String, CargoDiscoveryError> {
    let path = root.join("go.mod");
    let contents = fs::read_to_string(&path).map_err(|source| {
        if source.kind() == io::ErrorKind::NotFound {
            CargoDiscoveryError::ManifestMissing(path.clone())
        } else {
            CargoDiscoveryError::RepositoryPath {
                path: path.clone(),
                source,
            }
        }
    })?;
    for line in contents.lines() {
        let trimmed = line.split("//").next().unwrap_or("").trim();
        if let Some(module) = trimmed.strip_prefix("module ") {
            let module = module.trim().trim_matches('"');
            if !module.is_empty() {
                return Ok(module.to_owned());
            }
        }
    }
    Err(CargoDiscoveryError::RepositoryPath {
        path,
        source: io::Error::new(io::ErrorKind::InvalidData, "go.mod has no module path"),
    })
}

fn package_from_directory(
    root: &Path,
    module_path: &str,
    directory: &Path,
    files: &[PathBuf],
) -> Result<GoPackage, CargoDiscoveryError> {
    let relative = directory
        .strip_prefix(root)
        .unwrap_or(directory)
        .to_string_lossy()
        .replace('\\', "/");
    let import_path = if relative.is_empty() {
        module_path.to_owned()
    } else {
        format!("{module_path}/{relative}")
    };
    let mut go_files = Vec::new();
    let mut package_name = None;
    for path in files {
        let source = match fs::read_to_string(path) {
            Ok(contents) => contents,
            Err(_) => {
                go_files.push(GoFile {
                    path: path.clone(),
                    test: is_test_file(path),
                    unreadable: true,
                    imports: Vec::new(),
                    symbols: Vec::new(),
                    calls: Vec::new(),
                });
                continue;
            }
        };
        let clause = read_package_clause(&source);
        if let Some(name) = clause {
            package_name = Some(name);
        }
        let (imports, symbols, calls) = parse_go_source(&source);
        go_files.push(GoFile {
            path: path.clone(),
            test: is_test_file(path),
            unreadable: false,
            imports,
            symbols,
            calls,
        });
    }
    go_files.sort_by(|left, right| left.path.cmp(&right.path));
    let name = package_name.unwrap_or_else(|| {
        directory
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("main")
            .to_owned()
    });
    Ok(GoPackage {
        import_path,
        name,
        directory: directory.to_path_buf(),
        files: go_files,
    })
}

fn read_package_clause(source: &str) -> Option<String> {
    for line in source.lines() {
        let trimmed = line.split("//").next().unwrap_or("").trim();
        if let Some(rest) = trimmed.strip_prefix("package ") {
            let name = rest.split_whitespace().next()?;
            return Some(name.to_owned());
        }
    }
    None
}

fn walk_go_files(
    directory: &Path,
    root: &Path,
    seen: &mut HashSet<PathBuf>,
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
            walk_go_files(&path, root, seen, packages)?;
            continue;
        }
        if !is_go_file(&path) {
            continue;
        }
        if confined_go_path(&path, root).is_none() {
            continue;
        }
        let parent = path.parent().unwrap_or(directory).to_path_buf();
        packages.entry(parent).or_default().push(path);
    }
    Ok(())
}

fn confined_go_path(path: &Path, root: &Path) -> Option<PathBuf> {
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
    is_ignored_directory(name) || matches!(name, "vendor" | "testdata")
}

fn is_go_file(path: &Path) -> bool {
    path.extension().and_then(|ext| ext.to_str()) == Some("go")
}

fn is_test_file(path: &Path) -> bool {
    path.file_stem()
        .and_then(|stem| stem.to_str())
        .is_some_and(|stem| stem.ends_with("_test"))
}

fn strip_go_comments(source: &str) -> String {
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
        if chars[index] == '"' || chars[index] == '`' {
            let quote = chars[index];
            out.push(quote);
            index += 1;
            while index < chars.len() {
                if chars[index] == '\\' && quote != '`' {
                    out.push(chars[index]);
                    if index + 1 < chars.len() {
                        out.push(chars[index + 1]);
                    }
                    index += 2;
                    continue;
                }
                out.push(chars[index]);
                if chars[index] == quote {
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

fn parse_imports(source: &str) -> Vec<GoImport> {
    let mut imports = Vec::new();
    let mut line_no = 1usize;
    let mut index = 0usize;
    while index < source.len() {
        let Some(ch) = source[index..].chars().next() else {
            break;
        };
        if ch == '\n' {
            line_no += 1;
            index += 1;
            continue;
        }
        if source[index..].starts_with("import ") {
            let import_start = index + "import ".len();
            let rest = &source[import_start..];
            if rest.trim_start().starts_with('(') {
                let trimmed = rest.trim_start();
                let (block, consumed) = read_paren_block(trimmed);
                for entry in split_import_block(&block) {
                    if let Some(import) = parse_import_entry(&entry, line_no) {
                        imports.push(import);
                    }
                }
                index = import_start + (rest.len() - trimmed.len()) + consumed;
                continue;
            }
            let entry = rest.lines().next().unwrap_or("").trim();
            if let Some(import) = parse_import_entry(entry, line_no) {
                imports.push(import);
            }
            index = import_start + entry.len();
            continue;
        }
        index += ch.len_utf8();
    }
    imports
}

fn read_paren_block(source: &str) -> (String, usize) {
    let mut depth = 0;
    let mut out = String::new();
    for (offset, character) in source.char_indices() {
        out.push(character);
        if character == '(' {
            depth += 1;
        } else if character == ')' {
            depth -= 1;
            if depth == 0 {
                return (out, offset + 1);
            }
        }
    }
    (out, source.len())
}

fn split_import_block(block: &str) -> Vec<String> {
    let inner = block
        .trim()
        .strip_prefix('(')
        .and_then(|value| value.strip_suffix(')'))
        .unwrap_or(block);
    inner
        .split('\n')
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_owned)
        .collect()
}

fn parse_import_entry(entry: &str, line: usize) -> Option<GoImport> {
    let entry = entry.trim().trim_end_matches(';');
    if entry.is_empty() {
        return None;
    }
    let (alias, path) = if entry.starts_with('"') {
        (None, entry.trim_matches('"').to_owned())
    } else {
        let mut parts = entry.splitn(2, '"').collect::<Vec<_>>();
        if parts.len() < 2 {
            return None;
        }
        let alias = parts[0].trim();
        let path = parts[1].split('"').next().unwrap_or("").to_owned();
        let alias = match alias {
            "." | "_" => Some(alias.to_owned()),
            "" => None,
            value => Some(value.to_owned()),
        };
        (alias, path)
    };
    if path.is_empty() {
        return None;
    }
    Some(GoImport { line, path, alias })
}

fn parse_symbols(source: &str) -> Vec<GoSymbol> {
    let mut symbols = Vec::new();
    for (index, line) in source.lines().enumerate() {
        let line_no = index + 1;
        let trimmed = line.trim();
        if trimmed.starts_with("func ") {
            if let Some(symbol) = parse_func_line(trimmed, line_no) {
                symbols.push(symbol);
            }
            continue;
        }
        if trimmed.starts_with("type ") {
            if let Some(name) = trimmed
                .strip_prefix("type ")
                .and_then(|rest| rest.split_whitespace().next())
            {
                symbols.push(GoSymbol {
                    name: name.to_owned(),
                    kind: GoSymbolKind::Type,
                    line: line_no,
                    receiver: None,
                });
            }
        }
    }
    symbols
}

fn parse_func_line(line: &str, line_no: usize) -> Option<GoSymbol> {
    let rest = line.strip_prefix("func ")?;
    if rest.starts_with('(') {
        let close = rest.find(')')?;
        let receiver = rest[1..close].trim();
        let receiver_type = receiver
            .split_whitespace()
            .last()
            .unwrap_or(receiver)
            .trim_start_matches('*')
            .to_owned();
        let after = rest[close + 1..].trim();
        let name = after.split('(').next()?.trim();
        if name.is_empty() {
            return None;
        }
        return Some(GoSymbol {
            name: name.to_owned(),
            kind: GoSymbolKind::Method,
            line: line_no,
            receiver: Some(receiver_type),
        });
    }
    let name = rest.split('(').next()?.trim();
    if name.is_empty() {
        return None;
    }
    Some(GoSymbol {
        name: name.to_owned(),
        kind: GoSymbolKind::Func,
        line: line_no,
        receiver: None,
    })
}

fn parse_calls(source: &str, imports: &[GoImport]) -> Vec<GoCall> {
    let alias_to_path = go_import_alias_paths(imports);
    let mut calls = Vec::new();
    for (index, line) in source.lines().enumerate() {
        let line_no = index + 1;
        for token in line.split(|c: char| !c.is_ascii_alphanumeric() && c != '_' && c != '.') {
            if !token.contains('.') {
                continue;
            }
            let mut parts = token.split('.');
            let qualifier = parts.next().unwrap_or("");
            let name = parts.next().unwrap_or("");
            if qualifier.is_empty()
                || name.is_empty()
                || !name.chars().next().is_some_and(|c| c.is_ascii_uppercase())
            {
                continue;
            }
            if alias_to_path.contains_key(qualifier) {
                calls.push(GoCall {
                    line: line_no,
                    qualifier: qualifier.to_owned(),
                    name: name.to_owned(),
                });
            }
        }
    }
    calls
}

#[cfg(test)]
mod tests {
    use super::{discover_go_packages, parse_go_source, GoSymbolKind};
    use crate::extract::extract_cargo_map;
    use crate::facts::FactBlock;
    use std::path::{Path, PathBuf};

    fn fixture_root() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/go-sample")
    }

    #[test]
    fn fixture_lists_packages_files_imports_and_symbols() {
        let packages = discover_go_packages(&fixture_root()).expect("go fixture");
        let api = packages
            .iter()
            .find(|pkg| pkg.import_path.ends_with("/api"))
            .expect("api package");
        assert_eq!(api.name, "api");
        let api_go = api.files.iter().find(|file| !file.test).expect("api.go");
        assert!(api_go
            .imports
            .iter()
            .any(|import| import.path.contains("util")));
        assert!(api_go.symbols.iter().any(|symbol| symbol.name == "Greet"));
        let util = packages
            .iter()
            .find(|pkg| pkg.import_path.ends_with("/util"))
            .expect("util");
        assert!(util.files[0]
            .symbols
            .iter()
            .any(|symbol| { symbol.name == "Label" && symbol.kind == GoSymbolKind::Type }));
    }

    #[test]
    fn parse_imports_survives_non_ascii_bytes_before_imports() {
        let source = "package p\n// 日本語 café\nimport \"example.com/x\"\n";
        let (imports, _, _) = parse_go_source(source);
        assert_eq!(imports.len(), 1);
        assert_eq!(imports[0].path, "example.com/x");
    }

    #[test]
    fn block_comment_preserves_line_numbers_for_symbols() {
        let source = "package p\n/* block\n   comment */\nfunc After() {}\n";
        let (_, symbols, _) = parse_go_source(source);
        assert_eq!(symbols.len(), 1);
        assert_eq!(symbols[0].name, "After");
        assert_eq!(symbols[0].line, 4);
    }

    #[test]
    fn parse_skips_comments_and_finds_methods() {
        let source = "package p\n// func fake() {}\nfunc (s *Service) Run() {}\n";
        let (_, symbols, _) = parse_go_source(source);
        assert_eq!(symbols.len(), 1);
        assert_eq!(symbols[0].name, "Run");
        assert_eq!(symbols[0].kind, GoSymbolKind::Method);
    }

    #[test]
    fn go_modules_merge_into_workspace_maps() {
        let root = fixture_root();
        let packages = discover_go_packages(&root).expect("go fixture");
        let map = extract_cargo_map(&root, Some("Go Sample")).expect("extract");
        let go_blocks = map
            .blocks
            .iter()
            .filter_map(|block| match block {
                FactBlock::Module(module) if module.language == "go" => Some(module),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert!(go_blocks
            .iter()
            .any(|module| module.module_path.contains("api")));
        assert!(map.connections.iter().any(|connection| {
            matches!(connection, crate::facts::Connection::DependsOn { .. })
        }));
        let api = packages
            .iter()
            .find(|pkg| pkg.import_path.ends_with("/api"))
            .expect("api package");
        let api_go = api.files.iter().find(|file| !file.test).expect("api.go");
        assert!(
            !api_go.calls.is_empty(),
            "qualified calls such as util.Label should be recorded"
        );
        let main_pkg = packages
            .iter()
            .find(|pkg| pkg.import_path == "example.com/go-sample")
            .expect("main package");
        let main_go = main_pkg
            .files
            .iter()
            .find(|file| !file.test)
            .expect("main.go");
        assert!(
            main_go
                .calls
                .iter()
                .any(|call| call.qualifier == "api" && call.name == "Greet"),
            "main should record api.Greet call"
        );
        assert!(
            map.connections.iter().any(|connection| {
                matches!(
                    connection,
                    crate::facts::Connection::DependsOn {
                        source,
                        target,
                        ..
                    } if source.contains("example-com-go-sample-api-api")
                        && target.contains("util-util-label")
                )
            }),
            "call edges should link file blocks to callee symbols"
        );
    }
}
