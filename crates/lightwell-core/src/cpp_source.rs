use crate::metadata::CargoDiscoveryError;
use crate::path_confinement::{confined_canonical, opened_root};
use crate::workspace_ignore::is_ignored_directory;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct CppTarget {
    pub name: String,
    pub kind: CppTargetKind,
    pub directory: PathBuf,
    pub files: Vec<CppFile>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum CppTargetKind {
    Executable,
    Library,
    Interface,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct CppFile {
    pub path: PathBuf,
    pub unreadable: bool,
    pub includes: Vec<CppInclude>,
    pub symbols: Vec<CppSymbol>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct CppInclude {
    pub line: usize,
    pub path: String,
    pub system: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum CppSymbolKind {
    Class,
    Struct,
    Function,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct CppSymbol {
    pub name: String,
    pub kind: CppSymbolKind,
    pub line: usize,
}

impl CppTargetKind {
    pub(crate) fn outline_label(self) -> &'static str {
        match self {
            Self::Executable => "executable",
            Self::Library => "library",
            Self::Interface => "interface",
        }
    }
}

impl CppInclude {
    pub(crate) fn statement(&self) -> String {
        if self.system {
            format!("#include <{}>", self.path)
        } else {
            format!("#include \"{}\"", self.path)
        }
    }
}

impl CppSymbol {
    pub(crate) fn outline_label(&self) -> &'static str {
        match self.kind {
            CppSymbolKind::Class => "class",
            CppSymbolKind::Struct => "struct",
            CppSymbolKind::Function => "function",
        }
    }
}

/// Discover C/C++ targets under `repository_path` when a root `CMakeLists.txt` exists.
/// Returns an empty list when CMake is absent (not an error).
pub(crate) fn discover_cpp_targets(
    repository_path: &Path,
) -> Result<Vec<CppTarget>, CargoDiscoveryError> {
    let cmake_path = repository_path.join("CMakeLists.txt");
    if !cmake_path.is_file() {
        return Ok(Vec::new());
    }
    let canonical_root = opened_root(repository_path)?;
    let cmake_text =
        fs::read_to_string(&cmake_path).map_err(|source| CargoDiscoveryError::RepositoryPath {
            path: cmake_path.clone(),
            source,
        })?;
    let project_name = parse_cmake_project_name(&cmake_text);
    let cmake_targets = parse_cmake_targets(&cmake_text);

    let mut all_files = Vec::new();
    let mut seen = HashSet::new();
    walk_cpp_files(repository_path, &canonical_root, &mut seen, &mut all_files)?;

    let mut claimed: HashSet<PathBuf> = HashSet::new();
    let mut targets = Vec::new();

    for (name, kind, sources) in &cmake_targets {
        let mut files = Vec::new();
        for source in sources {
            let absolute = repository_path.join(source);
            match confined_cpp_path(&absolute, &canonical_root) {
                Some(_) => {
                    claimed.insert(normalize_key(&absolute));
                    files.push(file_from_path(&absolute)?);
                }
                None if absolute.exists() => {
                    // Outside opened folder — skip.
                }
                None => {
                    claimed.insert(normalize_key(&absolute));
                    files.push(CppFile {
                        path: absolute,
                        unreadable: true,
                        includes: Vec::new(),
                        symbols: Vec::new(),
                    });
                }
            }
        }
        files.sort_by(|left, right| left.path.cmp(&right.path));
        targets.push(CppTarget {
            name: name.clone(),
            kind: *kind,
            directory: repository_path.to_path_buf(),
            files,
        });
    }

    let mut unlisted = Vec::new();
    for path in &all_files {
        if claimed.insert(normalize_key(path)) {
            unlisted.push(file_from_path(path)?);
        }
    }
    unlisted.sort_by(|left, right| left.path.cmp(&right.path));

    if targets.is_empty() {
        if !unlisted.is_empty() {
            let name = project_name.clone().unwrap_or_else(|| "sources".to_owned());
            targets.push(CppTarget {
                name,
                kind: CppTargetKind::Interface,
                directory: repository_path.to_path_buf(),
                files: unlisted,
            });
        }
    } else if !unlisted.is_empty() {
        targets.push(CppTarget {
            name: "sources".to_owned(),
            kind: CppTargetKind::Interface,
            directory: repository_path.to_path_buf(),
            files: unlisted,
        });
    }

    targets.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(targets)
}

pub(crate) fn parse_cpp_source(source: &str) -> (Vec<CppInclude>, Vec<CppSymbol>) {
    let source = source.strip_prefix('\u{feff}').unwrap_or(source);
    let stripped = strip_cpp_comments(source);
    let includes = parse_includes(&stripped);
    let symbols = parse_symbols(&stripped);
    (includes, symbols)
}

fn file_from_path(path: &Path) -> Result<CppFile, CargoDiscoveryError> {
    let source = match fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(_) => {
            return Ok(CppFile {
                path: path.to_path_buf(),
                unreadable: true,
                includes: Vec::new(),
                symbols: Vec::new(),
            });
        }
    };
    let (includes, symbols) = parse_cpp_source(&source);
    Ok(CppFile {
        path: path.to_path_buf(),
        unreadable: false,
        includes,
        symbols,
    })
}

fn normalize_key(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                normalized.pop();
            }
            component => normalized.push(component.as_os_str()),
        }
    }
    normalized
}

fn walk_cpp_files(
    directory: &Path,
    root: &Path,
    seen: &mut HashSet<PathBuf>,
    files: &mut Vec<PathBuf>,
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
            walk_cpp_files(&path, root, seen, files)?;
            continue;
        }
        if !is_cpp_source_file(&path) {
            continue;
        }
        let Some(canonical) = confined_cpp_path(&path, root) else {
            continue;
        };
        if seen.insert(canonical) {
            files.push(path);
        }
    }
    Ok(())
}

fn confined_cpp_path(path: &Path, root: &Path) -> Option<PathBuf> {
    match confined_canonical(path, root) {
        Ok(canonical) => Some(canonical),
        Err(CargoDiscoveryError::PathOutsideOpenedFolder { .. }) => None,
        Err(CargoDiscoveryError::RepositoryPath { source, .. })
            if source.kind() == std::io::ErrorKind::NotFound =>
        {
            None
        }
        Err(_) => None,
    }
}

fn skipped_directory(name: &str) -> bool {
    if is_ignored_directory(name)
        || matches!(
            name.to_ascii_lowercase().as_str(),
            "build" | "deriveddata" | "vendor"
        )
    {
        return true;
    }
    name.starts_with("cmake-build-")
}

fn is_cpp_source_file(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.to_ascii_lowercase())
            .as_deref(),
        Some("c" | "cc" | "cpp" | "cxx" | "h" | "hh" | "hpp" | "hxx")
    )
}

fn strip_cmake_comments(source: &str) -> String {
    let mut out = String::with_capacity(source.len());
    for line in source.lines() {
        let mut in_string = false;
        let mut chars = line.chars().peekable();
        while let Some(ch) = chars.next() {
            if ch == '"' {
                in_string = !in_string;
                out.push(ch);
                continue;
            }
            if !in_string && ch == '#' {
                break;
            }
            out.push(ch);
        }
        out.push('\n');
    }
    out
}

fn parse_cmake_project_name(source: &str) -> Option<String> {
    let cleaned = strip_cmake_comments(source);
    for call in cmake_calls(&cleaned) {
        if !call.name.eq_ignore_ascii_case("project") {
            continue;
        }
        let name = call.args.first()?.trim();
        if !name.is_empty() {
            return Some(name.to_owned());
        }
    }
    None
}

fn parse_cmake_targets(source: &str) -> Vec<(String, CppTargetKind, Vec<String>)> {
    let cleaned = strip_cmake_comments(source);
    let mut targets = Vec::new();
    for call in cmake_calls(&cleaned) {
        let kind = if call.name.eq_ignore_ascii_case("add_executable") {
            CppTargetKind::Executable
        } else if call.name.eq_ignore_ascii_case("add_library") {
            CppTargetKind::Library
        } else {
            continue;
        };
        let mut args = call.args.into_iter();
        let Some(name) = args.next() else {
            continue;
        };
        let name = name.trim().to_owned();
        if name.is_empty() {
            continue;
        }
        let sources = args
            .map(|arg| arg.trim().to_owned())
            .filter(|arg| !arg.is_empty() && is_cmake_source_arg(arg))
            .collect::<Vec<_>>();
        targets.push((name, kind, sources));
    }
    targets
}

fn is_cmake_source_arg(arg: &str) -> bool {
    let lower = arg.to_ascii_lowercase();
    if matches!(
        lower.as_str(),
        "static"
            | "shared"
            | "module"
            | "object"
            | "interface"
            | "alias"
            | "imported"
            | "global"
            | "exclude_from_all"
    ) {
        return false;
    }
    Path::new(arg)
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| {
            matches!(
                ext.to_ascii_lowercase().as_str(),
                "c" | "cc" | "cpp" | "cxx" | "h" | "hh" | "hpp" | "hxx"
            )
        })
}

struct CmakeCall {
    name: String,
    args: Vec<String>,
}

fn cmake_calls(source: &str) -> Vec<CmakeCall> {
    let mut calls = Vec::new();
    let chars: Vec<char> = source.chars().collect();
    let mut index = 0;
    while index < chars.len() {
        if chars[index].is_ascii_whitespace() {
            index += 1;
            continue;
        }
        if !chars[index].is_ascii_alphabetic() && chars[index] != '_' {
            index += 1;
            continue;
        }
        let start = index;
        while index < chars.len() && (chars[index].is_ascii_alphanumeric() || chars[index] == '_') {
            index += 1;
        }
        let name: String = chars[start..index].iter().collect();
        while index < chars.len() && chars[index].is_ascii_whitespace() {
            index += 1;
        }
        if index >= chars.len() || chars[index] != '(' {
            continue;
        }
        index += 1;
        let mut depth = 1;
        let arg_start = index;
        while index < chars.len() {
            if chars[index] == '(' {
                depth += 1;
            } else if chars[index] == ')' {
                depth -= 1;
                if depth == 0 {
                    break;
                }
            }
            index += 1;
        }
        let args_raw: String = chars[arg_start..index.min(chars.len())].iter().collect();
        if index < chars.len() && chars[index] == ')' {
            index += 1;
        }
        let args = split_cmake_args(&args_raw);
        calls.push(CmakeCall { name, args });
    }
    calls
}

fn split_cmake_args(raw: &str) -> Vec<String> {
    let mut args = Vec::new();
    let mut current = String::new();
    let mut in_string = false;
    for ch in raw.chars() {
        if ch == '"' {
            in_string = !in_string;
            continue;
        }
        if !in_string && ch.is_ascii_whitespace() {
            if !current.is_empty() {
                args.push(std::mem::take(&mut current));
            }
            continue;
        }
        current.push(ch);
    }
    if !current.is_empty() {
        args.push(current);
    }
    args
}

fn strip_cpp_comments(source: &str) -> String {
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

fn parse_includes(source: &str) -> Vec<CppInclude> {
    let mut includes = Vec::new();
    for (index, line) in source.lines().enumerate() {
        let line_no = index + 1;
        let trimmed = line.trim();
        let Some(rest) = trimmed.strip_prefix("#include") else {
            continue;
        };
        let rest = rest.trim_start();
        if let Some(path) = rest.strip_prefix('"').and_then(|value| {
            let end = value.find('"')?;
            Some(value[..end].to_owned())
        }) {
            if !path.is_empty() {
                includes.push(CppInclude {
                    line: line_no,
                    path,
                    system: false,
                });
            }
            continue;
        }
        if let Some(path) = rest.strip_prefix('<').and_then(|value| {
            let end = value.find('>')?;
            Some(value[..end].to_owned())
        }) {
            if !path.is_empty() {
                includes.push(CppInclude {
                    line: line_no,
                    path,
                    system: true,
                });
            }
        }
    }
    includes
}

fn parse_symbols(source: &str) -> Vec<CppSymbol> {
    let mut symbols = Vec::new();
    let mut brace_depth = 0usize;
    let mut type_body_depth: Option<usize> = None;

    for (index, line) in source.lines().enumerate() {
        let line_no = index + 1;
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            brace_depth = update_brace_depth(brace_depth, line);
            continue;
        }

        let inside_type = type_body_depth.is_some_and(|depth| brace_depth > depth);

        if !inside_type {
            if let Some(name) = type_name_after(trimmed, "class ") {
                symbols.push(CppSymbol {
                    name,
                    kind: CppSymbolKind::Class,
                    line: line_no,
                });
                if trimmed.contains('{') {
                    type_body_depth = Some(brace_depth);
                }
            } else if let Some(name) = type_name_after(trimmed, "struct ") {
                symbols.push(CppSymbol {
                    name,
                    kind: CppSymbolKind::Struct,
                    line: line_no,
                });
                if trimmed.contains('{') {
                    type_body_depth = Some(brace_depth);
                }
            } else if let Some(name) = parse_function_name(trimmed) {
                symbols.push(CppSymbol {
                    name,
                    kind: CppSymbolKind::Function,
                    line: line_no,
                });
            }
        }

        let previous = brace_depth;
        brace_depth = update_brace_depth(brace_depth, line);
        if let Some(depth) = type_body_depth {
            if previous > depth && brace_depth <= depth {
                type_body_depth = None;
            }
        }
    }
    symbols
}

fn update_brace_depth(depth: usize, line: &str) -> usize {
    let mut depth = depth;
    for ch in line.chars() {
        if ch == '{' {
            depth = depth.saturating_add(1);
        } else if ch == '}' {
            depth = depth.saturating_sub(1);
        }
    }
    depth
}

fn type_name_after(line: &str, keyword: &str) -> Option<String> {
    let rest = line.strip_prefix(keyword)?;
    let name = rest
        .split(|ch: char| ch.is_ascii_whitespace() || ch == ':' || ch == '{' || ch == ';')
        .next()?
        .trim();
    if name.is_empty() || !is_identifier(name) {
        return None;
    }
    Some(name.to_owned())
}

fn parse_function_name(line: &str) -> Option<String> {
    if line.starts_with("class ") || line.starts_with("struct ") || line.starts_with("enum ") {
        return None;
    }
    if line.contains(" operator") || line.starts_with("operator") {
        return None;
    }
    let open = line.find('(')?;
    let before = line[..open].trim();
    if before.is_empty() {
        return None;
    }
    // Skip constructors/destructors written as Type::Type or ~Type without return type
    // when they still look like return-type name(...).
    let tokens = split_decl_tokens(before);
    if tokens.is_empty() {
        return None;
    }
    let name = tokens.last()?.trim_start_matches('*').trim_end_matches('&');
    if !is_identifier(name) {
        return None;
    }
    // Require a return type or a known modifier so we skip random calls.
    if tokens.len() == 1 {
        return None;
    }
    let head = tokens[..tokens.len() - 1]
        .iter()
        .map(|token| token.as_str())
        .collect::<Vec<_>>();
    if !head.iter().any(|token| is_typeish_token(token)) {
        return None;
    }
    Some(name.to_owned())
}

fn split_decl_tokens(before: &str) -> Vec<String> {
    before
        .split(|ch: char| ch.is_ascii_whitespace() || ch == '*')
        .map(str::trim)
        .filter(|token| !token.is_empty() && *token != "&" && *token != "&&")
        .map(|token| token.trim_end_matches('&').to_owned())
        .filter(|token| !token.is_empty())
        .collect()
}

fn is_typeish_token(token: &str) -> bool {
    let token = token.trim_start_matches('*').trim_end_matches('&');
    matches!(
        token,
        "static"
            | "inline"
            | "constexpr"
            | "virtual"
            | "explicit"
            | "friend"
            | "void"
            | "int"
            | "bool"
            | "auto"
            | "unsigned"
            | "signed"
            | "long"
            | "short"
            | "char"
            | "float"
            | "double"
            | "size_t"
            | "ssize_t"
            | "uint8_t"
            | "uint16_t"
            | "uint32_t"
            | "uint64_t"
            | "int8_t"
            | "int16_t"
            | "int32_t"
            | "int64_t"
            | "const"
            | "volatile"
            | "noexcept"
    ) || is_identifier(token)
}

fn is_identifier(value: &str) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !(first.is_ascii_alphabetic() || first == '_') {
        return false;
    }
    chars.all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
}

#[cfg(test)]
mod tests {
    use super::{discover_cpp_targets, parse_cpp_source, CppSymbolKind, CppTargetKind};
    use crate::extract::{cpp_id_encode, extract_cargo_map};
    use crate::facts::{Connection, FactBlock};
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn cpp_id_encode_is_injective_for_case_and_punctuation() {
        assert_eq!(cpp_id_encode("Foo"), "Foo");
        assert_eq!(cpp_id_encode("foo"), "foo");
        assert_ne!(cpp_id_encode("Foo"), cpp_id_encode("foo"));
        assert_eq!(cpp_id_encode("lib-a"), "lib_2d_a");
        assert_eq!(cpp_id_encode("lib_a"), "lib_5f_a");
        assert_ne!(cpp_id_encode("lib-a"), cpp_id_encode("lib_a"));
        let cases = ["Foo", "foo", "lib-a", "lib_a", "demo/main", "demo/Main"];
        let mut encoded: Vec<_> = cases.iter().map(|value| cpp_id_encode(value)).collect();
        let before = encoded.len();
        encoded.sort();
        encoded.dedup();
        assert_eq!(encoded.len(), before, "encode cases must stay injective");
    }

    fn fixture_root() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/cpp-sample")
    }

    #[test]
    fn fixture_lists_targets_files_includes_and_symbols() {
        let targets = discover_cpp_targets(&fixture_root()).expect("cpp fixture");
        let demo = targets
            .iter()
            .find(|target| target.name == "demo")
            .expect("demo target");
        assert_eq!(demo.kind, CppTargetKind::Executable);
        assert!(demo.files.iter().any(|file| {
            file.path.file_name().and_then(|name| name.to_str()) == Some("main.cpp")
        }));
        assert!(demo.files.iter().any(|file| {
            file.path.file_name().and_then(|name| name.to_str()) == Some("greeter.cpp")
        }));
        let main = demo
            .files
            .iter()
            .find(|file| file.path.file_name().and_then(|name| name.to_str()) == Some("main.cpp"))
            .expect("main.cpp");
        assert!(main
            .includes
            .iter()
            .any(|include| !include.system && include.path == "greeter.h"));
        assert!(main
            .symbols
            .iter()
            .any(|symbol| symbol.name == "main" && symbol.kind == CppSymbolKind::Function));

        let sources = targets
            .iter()
            .find(|target| target.name == "sources")
            .expect("sources interface for headers");
        assert_eq!(sources.kind, CppTargetKind::Interface);
        let greeter_h = sources
            .files
            .iter()
            .find(|file| file.path.file_name().and_then(|name| name.to_str()) == Some("greeter.h"))
            .expect("greeter.h");
        assert!(greeter_h
            .symbols
            .iter()
            .any(|symbol| symbol.name == "Greeter" && symbol.kind == CppSymbolKind::Class));
    }

    #[test]
    fn parse_include_and_class() {
        let source = r#"
#include "greeter.h"
#include <vector>

// class Fake {}
class Greeter {
public:
    void skip_me();
};

struct Point {
    int x;
};

int helper(int value) {
    return value;
}
"#;
        let (includes, symbols) = parse_cpp_source(source);
        assert!(includes
            .iter()
            .any(|include| !include.system && include.path == "greeter.h"));
        assert!(includes
            .iter()
            .any(|include| include.system && include.path == "vector"));
        assert!(symbols
            .iter()
            .any(|symbol| symbol.name == "Greeter" && symbol.kind == CppSymbolKind::Class));
        assert!(symbols
            .iter()
            .any(|symbol| symbol.name == "Point" && symbol.kind == CppSymbolKind::Struct));
        assert!(symbols
            .iter()
            .any(|symbol| symbol.name == "helper" && symbol.kind == CppSymbolKind::Function));
        assert!(!symbols.iter().any(|symbol| symbol.name == "skip_me"));
        assert!(!symbols.iter().any(|symbol| symbol.name == "Fake"));
    }

    #[test]
    fn cmake_missing_returns_empty() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "lightwell-cpp-missing-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&root).expect("temp dir");
        fs::write(root.join("orphan.cpp"), "int main() { return 0; }\n").expect("cpp");
        let targets = discover_cpp_targets(&root).expect("discover");
        assert!(targets.is_empty());
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn cpp_modules_merge_into_workspace_maps() {
        let root = fixture_root();
        let map = extract_cargo_map(&root, Some("Cpp Sample")).expect("extract");
        let cpp_blocks = map
            .blocks
            .iter()
            .filter_map(|block| match block {
                FactBlock::Module(module) if module.language == "cpp" => Some(module),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert!(
            cpp_blocks
                .iter()
                .any(|module| module.base.label == "demo" || module.module_path.contains("demo")),
            "expected demo target block"
        );
        assert!(
            cpp_blocks
                .iter()
                .any(|module| module.base.label == "main" || module.module_path.contains("main")),
            "expected main.cpp file block"
        );
        assert!(
            map.connections.iter().any(|connection| {
                matches!(
                    connection,
                    Connection::DependsOn {
                        source,
                        target,
                        ..
                    } if source.contains("main") && target.contains("greeter")
                )
            }),
            "quoted include should link main.cpp to greeter.h"
        );
    }
}
