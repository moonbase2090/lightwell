use crate::metadata::CargoDiscoveryError;
use crate::path_confinement::{confined_canonical, opened_root};
use std::collections::HashSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct PythonModule {
    pub name: String,
    pub path: PathBuf,
    pub package: Option<String>,
    pub stub: bool,
    pub unreadable: bool,
    pub imports: Vec<PythonImport>,
    pub symbols: Vec<PythonSymbol>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct PythonImport {
    pub line: usize,
    pub module: String,
    pub relative_level: usize,
    pub names: Vec<PythonImportedName>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct PythonImportedName {
    pub name: String,
    pub alias: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum PythonSymbolKind {
    Function,
    AsyncFunction,
    Class,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct PythonSymbol {
    pub name: String,
    pub kind: PythonSymbolKind,
    pub line: usize,
}

impl PythonImport {
    pub(crate) fn statement(&self) -> String {
        if self.names.len() == 1 && self.names[0].name == self.module && self.relative_level == 0 {
            return match &self.names[0].alias {
                Some(alias) => format!("import {} as {alias}", self.module),
                None => format!("import {}", self.module),
            };
        }
        let dots = ".".repeat(self.relative_level);
        let names = self
            .names
            .iter()
            .map(|name| match &name.alias {
                Some(alias) => format!("{} as {alias}", name.name),
                None => name.name.clone(),
            })
            .collect::<Vec<_>>()
            .join(", ");
        if self.module.is_empty() {
            format!("from {dots} import {names}")
        } else if self.relative_level == 0 {
            format!("from {} import {names}", self.module)
        } else {
            format!("from {dots}{} import {names}", self.module)
        }
    }
}

impl PythonSymbol {
    pub(crate) fn outline_label(&self) -> &'static str {
        match self.kind {
            PythonSymbolKind::Function => "def",
            PythonSymbolKind::AsyncFunction => "async def",
            PythonSymbolKind::Class => "class",
        }
    }
}

pub(crate) fn discover_python_modules(
    repository_path: &Path,
) -> Result<Vec<PythonModule>, CargoDiscoveryError> {
    let canonical_root = opened_root(repository_path)?;
    let mut files = Vec::new();
    let mut seen = HashSet::new();
    walk_python_files(repository_path, &canonical_root, &mut seen, &mut files)?;
    let packages = package_directories(&files);
    let mut modules = files
        .into_iter()
        .map(|path| module_from_file(repository_path, &path, &packages))
        .collect::<Result<Vec<_>, _>>()?;
    modules.sort_by(|left, right| {
        left.name
            .cmp(&right.name)
            .then(left.stub.cmp(&right.stub))
            .then(left.path.cmp(&right.path))
    });
    Ok(modules)
}

pub(crate) fn parse_python_source(source: &str) -> (Vec<PythonImport>, Vec<PythonSymbol>) {
    let source = source.strip_prefix('\u{feff}').unwrap_or(source);
    let mut imports = Vec::new();
    let mut symbols = Vec::new();
    let mut state = ScanState::default();
    let mut logical = String::new();
    let mut logical_line = 1usize;
    let mut continued = false;

    for (index, raw_line) in source.split_inclusive('\n').enumerate() {
        let line_no = index + 1;
        let line = raw_line.trim_end_matches(['\n', '\r']);
        if state.quote.is_some() {
            scan_line(line, &mut state);
            continue;
        }
        if state.paren > 0 || continued {
            logical.push('\n');
            logical.push_str(line);
            continued = scan_line(line, &mut state);
            if state.paren == 0 && state.quote.is_none() && !continued {
                classify(&logical, logical_line, &mut imports, &mut symbols);
                logical.clear();
            }
            continue;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if line.len() != trimmed.len() {
            continue;
        }
        logical.clear();
        logical.push_str(line);
        logical_line = line_no;
        continued = scan_line(line, &mut state);
        if state.paren == 0 && state.quote.is_none() && !continued {
            classify(&logical, logical_line, &mut imports, &mut symbols);
            logical.clear();
        }
    }
    (imports, symbols)
}

fn module_from_file(
    root: &Path,
    path: &Path,
    packages: &HashSet<PathBuf>,
) -> Result<PythonModule, CargoDiscoveryError> {
    let bytes = fs::read(path).map_err(|source| CargoDiscoveryError::PythonSourceRead {
        path: path.to_owned(),
        source,
    })?;
    let stub = path.extension().and_then(|ext| ext.to_str()) == Some("pyi");
    let Ok(source) = String::from_utf8(bytes) else {
        return Ok(PythonModule {
            name: module_name(root, path),
            package: nearest_package(root, path, packages),
            path: path.to_owned(),
            stub,
            unreadable: true,
            imports: Vec::new(),
            symbols: Vec::new(),
        });
    };
    let (imports, symbols) = parse_python_source(&source);
    Ok(PythonModule {
        name: module_name(root, path),
        package: nearest_package(root, path, packages),
        path: path.to_owned(),
        stub,
        unreadable: false,
        imports,
        symbols,
    })
}

fn walk_python_files(
    directory: &Path,
    root: &Path,
    seen: &mut HashSet<PathBuf>,
    files: &mut Vec<PathBuf>,
) -> Result<(), CargoDiscoveryError> {
    let canonical = match confined_python_path(directory, root) {
        Some(path) => path,
        None => return Ok(()),
    };
    if !seen.insert(canonical) {
        return Ok(());
    }
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
            walk_python_files(&path, root, seen, files)?;
            continue;
        }
        if !is_python_file(&path) {
            continue;
        }
        if confined_python_path(&path, root).is_none() {
            continue;
        }
        files.push(path);
    }
    Ok(())
}

fn confined_python_path(path: &Path, root: &Path) -> Option<PathBuf> {
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
        "__pycache__" | "node_modules" | "target" | "dist" | "venv" | ".venv"
    )
}

fn is_python_file(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|ext| ext.to_str()),
        Some("py" | "pyi")
    )
}

fn package_directories(files: &[PathBuf]) -> HashSet<PathBuf> {
    files
        .iter()
        .filter(|path| {
            matches!(
                path.file_name().and_then(|name| name.to_str()),
                Some("__init__.py" | "__init__.pyi")
            )
        })
        .filter_map(|path| path.parent().map(Path::to_path_buf))
        .collect()
}

fn nearest_package(root: &Path, path: &Path, packages: &HashSet<PathBuf>) -> Option<String> {
    let mut directory = path.parent()?;
    loop {
        if packages.contains(directory) {
            return Some(dotted_directory(root, directory));
        }
        if directory == root {
            return None;
        }
        directory = directory.parent()?;
    }
}

fn module_name(root: &Path, path: &Path) -> String {
    let relative = path.strip_prefix(root).unwrap_or(path);
    let mut parts = relative
        .components()
        .filter_map(|component| component.as_os_str().to_str())
        .map(str::to_owned)
        .collect::<Vec<_>>();
    if let Some(file_name) = parts.pop() {
        let stem = Path::new(&file_name)
            .file_stem()
            .and_then(|stem| stem.to_str())
            .unwrap_or(&file_name);
        if stem != "__init__" {
            parts.push(stem.to_owned());
        }
    }
    parts.join(".")
}

fn dotted_directory(root: &Path, directory: &Path) -> String {
    directory
        .strip_prefix(root)
        .unwrap_or(directory)
        .components()
        .filter_map(|component| component.as_os_str().to_str())
        .collect::<Vec<_>>()
        .join(".")
}

#[derive(Clone, Copy)]
enum Quote {
    Single,
    Double,
    TripleSingle,
    TripleDouble,
}

#[derive(Default)]
struct ScanState {
    quote: Option<Quote>,
    paren: i32,
}

fn scan_line(line: &str, state: &mut ScanState) -> bool {
    let chars = line.chars().collect::<Vec<_>>();
    let mut index = 0;
    while index < chars.len() {
        if let Some(quote) = state.quote {
            if closes_quote(&chars, index, quote) {
                index += quote_len(quote);
                state.quote = None;
                continue;
            }
            if chars[index] == '\\' {
                index += 2;
                continue;
            }
            index += 1;
            continue;
        }
        if chars[index] == '#' {
            break;
        }
        if chars[index] == '\\' && index + 1 == chars.len() {
            return true;
        }
        if let Some(quote) = opens_quote(&chars, index) {
            index += quote_len(quote);
            state.quote = Some(quote);
            continue;
        }
        match chars[index] {
            '(' | '[' | '{' => state.paren += 1,
            ')' | ']' | '}' => state.paren -= 1,
            _ => {}
        }
        index += 1;
    }
    false
}

fn opens_quote(chars: &[char], index: usize) -> Option<Quote> {
    if starts_with_at(chars, index, &['\'', '\'', '\'']) {
        Some(Quote::TripleSingle)
    } else if starts_with_at(chars, index, &['"', '"', '"']) {
        Some(Quote::TripleDouble)
    } else if chars[index] == '\'' {
        Some(Quote::Single)
    } else if chars[index] == '"' {
        Some(Quote::Double)
    } else {
        None
    }
}

fn closes_quote(chars: &[char], index: usize, quote: Quote) -> bool {
    match quote {
        Quote::Single => chars[index] == '\'' && !escaped(chars, index),
        Quote::Double => chars[index] == '"' && !escaped(chars, index),
        Quote::TripleSingle => starts_with_at(chars, index, &['\'', '\'', '\'']),
        Quote::TripleDouble => starts_with_at(chars, index, &['"', '"', '"']),
    }
}

fn quote_len(quote: Quote) -> usize {
    match quote {
        Quote::Single | Quote::Double => 1,
        Quote::TripleSingle | Quote::TripleDouble => 3,
    }
}

fn escaped(chars: &[char], index: usize) -> bool {
    let mut slashes = 0;
    let mut cursor = index;
    while cursor > 0 && chars[cursor - 1] == '\\' {
        slashes += 1;
        cursor -= 1;
    }
    slashes % 2 == 1
}

fn starts_with_at(chars: &[char], index: usize, needle: &[char]) -> bool {
    chars[index..].starts_with(needle)
}

fn classify(
    statement: &str,
    line: usize,
    imports: &mut Vec<PythonImport>,
    symbols: &mut Vec<PythonSymbol>,
) {
    let code = blank_strings(statement);
    let trimmed = code.trim();
    if trimmed.starts_with('@') {
        return;
    }
    if let Some(name) = keyword_name(trimmed, "async def") {
        symbols.push(PythonSymbol {
            name,
            kind: PythonSymbolKind::AsyncFunction,
            line,
        });
        return;
    }
    if let Some(name) = keyword_name(trimmed, "def") {
        symbols.push(PythonSymbol {
            name,
            kind: PythonSymbolKind::Function,
            line,
        });
        return;
    }
    if let Some(name) = keyword_name(trimmed, "class") {
        symbols.push(PythonSymbol {
            name,
            kind: PythonSymbolKind::Class,
            line,
        });
        return;
    }
    if let Some(rest) = trimmed.strip_prefix("import ") {
        imports.extend(parse_import(rest, line));
        return;
    }
    if let Some(rest) = trimmed.strip_prefix("from ") {
        if let Some(import) = parse_from(rest, line) {
            imports.push(import);
        }
    }
}

fn blank_strings(statement: &str) -> String {
    let chars = statement.chars().collect::<Vec<_>>();
    let mut index = 0;
    let mut quote = None;
    let mut blanked = String::new();
    while index < chars.len() {
        if let Some(active) = quote {
            if closes_quote(&chars, index, active) {
                index += quote_len(active);
                quote = None;
                continue;
            }
            if chars[index] == '\\' {
                index += 1;
            }
            if index < chars.len() {
                if chars[index] == '\n' {
                    blanked.push('\n');
                } else {
                    blanked.push(' ');
                }
                index += 1;
            }
            continue;
        }
        if let Some(opened) = opens_quote(&chars, index) {
            quote = Some(opened);
            index += quote_len(opened);
            continue;
        }
        blanked.push(chars[index]);
        index += 1;
    }
    blanked
}

fn keyword_name(statement: &str, keyword: &str) -> Option<String> {
    let rest = statement.strip_prefix(keyword)?;
    if rest
        .chars()
        .next()
        .is_some_and(|character| !character.is_whitespace())
    {
        return None;
    }
    let rest = rest.trim_start();
    let name = rest
        .chars()
        .take_while(|character| character.is_ascii_alphanumeric() || *character == '_')
        .collect::<String>();
    if name.is_empty() || name.chars().next()?.is_ascii_digit() {
        None
    } else {
        Some(name)
    }
}

fn parse_import(rest: &str, line: usize) -> Vec<PythonImport> {
    split_top_level(rest, ',')
        .into_iter()
        .filter_map(|part| {
            let part = part.trim();
            if part.is_empty() {
                return None;
            }
            let (module, alias) = split_alias(part);
            Some(PythonImport {
                line,
                module: module.clone(),
                relative_level: 0,
                names: vec![PythonImportedName {
                    name: module,
                    alias,
                }],
            })
        })
        .collect()
}

fn parse_from(rest: &str, line: usize) -> Option<PythonImport> {
    let (module_token, names_token) = rest.split_once(" import ")?;
    let (relative_level, module) = split_relative(module_token.trim());
    let names = split_top_level(&names_token.replace(['(', ')'], " "), ',')
        .into_iter()
        .filter_map(|part| {
            let part = part.trim();
            if part.is_empty() {
                return None;
            }
            let (name, alias) = split_alias(part);
            Some(PythonImportedName { name, alias })
        })
        .collect::<Vec<_>>();
    if names.is_empty() {
        return None;
    }
    Some(PythonImport {
        line,
        module,
        relative_level,
        names,
    })
}

fn split_alias(part: &str) -> (String, Option<String>) {
    match part.split_once(" as ") {
        Some((name, alias)) => (name.trim().to_owned(), Some(alias.trim().to_owned())),
        None => (part.trim().to_owned(), None),
    }
}

fn split_relative(token: &str) -> (usize, String) {
    let level = token
        .chars()
        .take_while(|character| *character == '.')
        .count();
    (level, token[level..].trim().to_owned())
}

fn split_top_level(value: &str, separator: char) -> Vec<String> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut depth = 0i32;
    for character in value.chars() {
        match character {
            '(' | '[' | '{' => {
                depth += 1;
                current.push(character);
            }
            ')' | ']' | '}' => {
                depth -= 1;
                current.push(character);
            }
            found if found == separator && depth == 0 => {
                parts.push(std::mem::take(&mut current));
            }
            _ => current.push(character),
        }
    }
    if !current.trim().is_empty() {
        parts.push(current);
    }
    parts
}

#[cfg(test)]
mod tests {
    use super::{discover_python_modules, parse_python_source, PythonSymbolKind};
    use crate::extract::extract_cargo_map;
    use crate::facts::FactBlock;
    use crate::metadata::CargoDiscoveryError;
    use std::fs;
    use std::io;
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn fixture_root() -> std::path::PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/python-sample")
    }

    #[test]
    fn fixture_lists_packages_modules_imports_and_top_level_symbols() {
        let modules =
            discover_python_modules(&fixture_root()).expect("python fixture should parse");
        let api = modules
            .iter()
            .find(|module| module.name == "sample_pkg.api" && !module.stub)
            .expect("api module");
        assert_eq!(api.package.as_deref(), Some("sample_pkg"));
        assert!(api
            .imports
            .iter()
            .any(|import| import.statement() == "import json"));
        assert!(api.imports.iter().any(|import| {
            import.statement() == "from .nested.worker import run" && import.relative_level == 1
        }));
        assert!(api
            .imports
            .iter()
            .any(|import| { import.statement() == "from typing import Optional" }));
        assert_eq!(
            api.symbols
                .iter()
                .map(|symbol| (symbol.name.as_str(), symbol.kind))
                .collect::<Vec<_>>(),
            vec![
                ("load_widget", PythonSymbolKind::Function),
                ("Widget", PythonSymbolKind::Class),
                ("refresh", PythonSymbolKind::AsyncFunction),
            ]
        );
        assert!(modules.iter().any(|module| module.name == "sample_pkg"));
        assert!(modules
            .iter()
            .any(|module| module.name == "sample_pkg.nested.worker"));
        let stub = modules
            .iter()
            .find(|module| module.name == "sample_pkg.types")
            .expect("stub module");
        assert!(stub.stub);
        assert_eq!(stub.symbols[0].name, "Widget");
        assert_eq!(stub.symbols[0].kind, PythonSymbolKind::Class);
        let loose = modules
            .iter()
            .find(|module| module.name == "loose")
            .expect("loose module");
        assert_eq!(loose.package, None);
        assert_eq!(loose.symbols[0].name, "entry");
    }

    #[test]
    fn strings_and_nested_defs_are_not_top_level_symbols() {
        let source = "\
\"\"\"def not_a_function():
    pass
\"\"\"
text = \"def still_not_real():\"
def load_widget():
    def hidden():
        return text
";
        let (_imports, symbols) = parse_python_source(source);
        assert_eq!(symbols.len(), 1);
        assert_eq!(symbols[0].name, "load_widget");
    }

    #[test]
    fn a_leading_bom_keeps_the_first_function() {
        let source = "\u{feff}def load_widget():\n    return None\n";
        let (_imports, symbols) = parse_python_source(source);
        assert_eq!(symbols.len(), 1);
        assert_eq!(symbols[0].name, "load_widget");
        assert_eq!(symbols[0].kind, PythonSymbolKind::Function);
    }

    #[test]
    fn invalid_utf8_is_an_unresolved_python_module_and_the_map_continues() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("lightwell-python-utf8-{unique}"));
        fs::create_dir_all(root.join("src")).expect("src");
        fs::write(
            root.join("Cargo.toml"),
            "[package]\nname = \"pyhost\"\nversion = \"0.1.0\"\nedition = \"2021\"\n",
        )
        .expect("manifest");
        fs::write(root.join("src/lib.rs"), "pub fn value() -> u8 { 1 }\n").expect("lib");
        fs::write(root.join("kept.py"), "def kept():\n    return None\n").expect("kept");
        fs::write(root.join("bad_source.py"), [0xff, 0xfe, b'd', b'e', b'f']).expect("bad");
        let map = extract_cargo_map(&root, Some("Py Host")).expect("extract continues");
        let python = map
            .blocks
            .iter()
            .filter_map(|block| match block {
                FactBlock::Module(module) if module.language == "python" => Some(module),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert!(python.iter().any(|module| {
            module.module_path == "bad_source"
                && module.unresolved
                && module.cfg_attributes.is_empty()
        }));
        assert!(python
            .iter()
            .all(|module| !module.module_path.starts_with("bad_source.")));
        assert!(python
            .iter()
            .any(|module| module.module_path == "kept.kept" && module.cfg_attributes == ["def"]));
        let read_error = CargoDiscoveryError::PythonSourceRead {
            path: PathBuf::from("pkg/bad_source.py"),
            source: io::Error::new(io::ErrorKind::PermissionDenied, "denied"),
        };
        let message = read_error.to_string();
        assert!(message.contains("Python source"));
        assert!(!message.contains("Rust source"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn assignments_are_not_definitions() {
        let source = "default = 1\nclassic = True\ndef load_widget():\n    return default\n";
        let (_imports, symbols) = parse_python_source(source);
        assert_eq!(symbols.len(), 1);
        assert_eq!(symbols[0].name, "load_widget");
        assert_eq!(symbols[0].kind, PythonSymbolKind::Function);
    }

    #[test]
    fn a_symlink_outside_the_root_is_not_a_module() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("lightwell-python-link-{unique}"));
        let outside = std::env::temp_dir().join(format!("lightwell-python-outside-{unique}"));
        let _ = fs::remove_dir_all(&outside);
        fs::create_dir_all(&root).expect("root");
        fs::create_dir_all(&outside).expect("outside");
        fs::write(
            outside.join("escape.py"),
            "def escaped():\n    return None\n",
        )
        .expect("outside file");
        fs::write(root.join("kept.py"), "def kept():\n    return None\n").expect("kept");
        std::os::unix::fs::symlink(outside.join("escape.py"), root.join("escape.py"))
            .expect("symlink");
        let modules = discover_python_modules(&root).expect("discover");
        assert!(modules.iter().all(|module| module.name != "escape"));
        assert!(modules.iter().any(|module| module.name == "kept"));
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&outside);
    }

    #[test]
    fn extract_includes_python_modules_by_default() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("lightwell-python-extract-{unique}"));
        fs::create_dir_all(root.join("src")).expect("src");
        fs::create_dir_all(root.join("sample_pkg")).expect("package");
        fs::write(
            root.join("Cargo.toml"),
            "[package]\nname = \"pyhost\"\nversion = \"0.1.0\"\nedition = \"2021\"\n",
        )
        .expect("manifest");
        fs::write(root.join("src/lib.rs"), "pub fn value() -> u8 { 1 }\n").expect("lib");
        fs::write(root.join("sample_pkg/__init__.py"), "").expect("init");
        fs::write(
            root.join("sample_pkg/api.py"),
            "def load_widget():\n    return None\n",
        )
        .expect("api");
        let map = extract_cargo_map(&root, Some("Py Host")).expect("extract");
        let python = map
            .blocks
            .iter()
            .filter_map(|block| match block {
                FactBlock::Module(module) if module.language == "python" => Some(module),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert!(python
            .iter()
            .any(|module| module.module_path == "sample_pkg.api"));
        assert!(python.iter().any(|module| {
            module.module_path == "sample_pkg.api.load_widget" && module.cfg_attributes == ["def"]
        }));
        assert!(map.blocks.iter().any(|block| matches!(
            block,
            FactBlock::Module(module) if module.language == "rust" && module.module_path == "crate root"
        )));
        let _ = fs::remove_dir_all(&root);
    }
}
