use crate::metadata::CargoDiscoveryError;
use crate::path_confinement::{confined_canonical, opened_root};
use crate::workspace_ignore::is_ignored_directory;
use std::collections::HashSet;
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum DotnetSymbolKind {
    Class,
    Struct,
    Record,
    Interface,
    Enum,
    Module,
    Method,
}

impl DotnetSymbolKind {
    pub(crate) fn cfg_label(self, partial: bool) -> &'static str {
        match self {
            Self::Class if partial => "partial class",
            Self::Class => "class",
            Self::Struct => "struct",
            Self::Record => "record",
            Self::Interface => "interface",
            Self::Enum => "enum",
            Self::Module => "module",
            Self::Method => "method",
        }
    }

    fn is_type(self) -> bool {
        !matches!(self, Self::Method)
    }

    fn allows_members(self) -> bool {
        matches!(
            self,
            Self::Class | Self::Struct | Self::Record | Self::Interface | Self::Module
        )
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct DotnetImport {
    pub line: usize,
    pub target: String,
    pub alias: Option<String>,
    pub global: bool,
    pub statement: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct DotnetSymbol {
    pub name: String,
    /// For a type, its namespace-qualified name. For a method, the owning type.
    pub qualified: String,
    pub kind: DotnetSymbolKind,
    pub line: usize,
    pub namespace: String,
    pub partial: bool,
    pub bases: Vec<String>,
    pub member_types: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct DotnetFile {
    pub path: PathBuf,
    pub language: String,
    pub namespace: String,
    pub project_path: Option<PathBuf>,
    pub unreadable: bool,
    pub imports: Vec<DotnetImport>,
    pub symbols: Vec<DotnetSymbol>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct DotnetProject {
    pub name: String,
    pub path: PathBuf,
    pub language: String,
    pub root_namespace: Option<String>,
    pub references: Vec<PathBuf>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct DotnetWorkspace {
    pub projects: Vec<DotnetProject>,
    pub files: Vec<DotnetFile>,
}

pub(crate) fn discover_dotnet(
    repository_path: &Path,
) -> Result<DotnetWorkspace, CargoDiscoveryError> {
    let canonical_root = opened_root(repository_path)?;
    let mut paths = Vec::new();
    let mut seen = HashSet::new();
    walk_dotnet_files(repository_path, &canonical_root, &mut seen, &mut paths)?;
    paths.sort();
    let mut projects = Vec::new();
    let mut source_paths = Vec::new();
    let mut solutions = Vec::new();
    for path in paths {
        match extension_lower(&path).as_deref() {
            Some("csproj" | "vbproj") => projects.push(project_from_file(&path)?),
            Some("sln") => solutions.push(path),
            Some("cs" | "vb") => source_paths.push(path),
            _ => {}
        }
    }
    for solution in &solutions {
        if let Ok(text) = fs::read_to_string(solution) {
            let base = solution.parent().unwrap_or(repository_path);
            for relative in solution_project_paths(&text) {
                let path = portable_join(base, &relative);
                if projects
                    .iter()
                    .any(|project| same_path(&project.path, &path))
                {
                    continue;
                }
                if extension_lower(&path).as_deref() == Some("csproj")
                    || extension_lower(&path).as_deref() == Some("vbproj")
                {
                    if confined_dotnet_path(&path, &canonical_root).is_some() && path.is_file() {
                        projects.push(project_from_file(&path)?);
                    }
                }
            }
        }
    }
    projects.sort_by(|left, right| left.name.cmp(&right.name).then(left.path.cmp(&right.path)));
    let mut files = source_paths
        .into_iter()
        .map(|path| file_from_path(&path, &projects))
        .collect::<Result<Vec<_>, _>>()?;
    for file in &mut files {
        apply_root_namespace(file, &projects);
    }
    files.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(DotnetWorkspace { projects, files })
}

pub(crate) fn parse_csharp_source(source: &str) -> (Vec<DotnetImport>, Vec<DotnetSymbol>) {
    parse_csharp(&mask_csharp(strip_bom(source)))
}

pub(crate) fn parse_vb_source(source: &str) -> (Vec<DotnetImport>, Vec<DotnetSymbol>) {
    parse_vb(&mask_vb(strip_bom(source)))
}

pub(crate) fn solution_project_paths(source: &str) -> Vec<String> {
    let mut paths = Vec::new();
    for line in source.lines() {
        let trimmed = line.trim();
        let Some(rest) = trimmed.strip_prefix("Project(") else {
            continue;
        };
        let Some(eq) = rest.find('=') else { continue };
        let mut quotes = Vec::new();
        let mut current = String::new();
        let mut in_quote = false;
        for character in rest[eq + 1..].chars() {
            if character == '"' {
                if in_quote {
                    quotes.push(std::mem::take(&mut current));
                }
                in_quote = !in_quote;
                continue;
            }
            if in_quote {
                current.push(character);
            }
        }
        if quotes.len() >= 2 {
            paths.push(quotes[1].clone());
        }
    }
    paths
}

fn strip_bom(source: &str) -> &str {
    source.strip_prefix('\u{feff}').unwrap_or(source)
}

fn file_from_path(
    path: &Path,
    projects: &[DotnetProject],
) -> Result<DotnetFile, CargoDiscoveryError> {
    let language = if extension_lower(path).as_deref() == Some("vb") {
        "vb"
    } else {
        "csharp"
    };
    let project_path = owning_project(path, projects).map(|project| project.path.clone());
    let bytes = fs::read(path).map_err(|source| CargoDiscoveryError::DotnetSourceRead {
        path: path.to_owned(),
        source,
    })?;
    let Ok(text) = String::from_utf8(bytes) else {
        return Ok(DotnetFile {
            path: path.to_owned(),
            language: language.to_owned(),
            namespace: String::new(),
            project_path,
            unreadable: true,
            imports: Vec::new(),
            symbols: Vec::new(),
        });
    };
    let (imports, symbols) = if language == "vb" {
        parse_vb_source(&text)
    } else {
        parse_csharp_source(&text)
    };
    let namespace = symbols
        .iter()
        .find(|symbol| symbol.kind.is_type())
        .map(|symbol| symbol.namespace.clone())
        .or_else(|| symbols.first().map(|symbol| symbol.namespace.clone()))
        .unwrap_or_default();
    Ok(DotnetFile {
        path: path.to_owned(),
        language: language.to_owned(),
        namespace,
        project_path,
        unreadable: false,
        imports,
        symbols,
    })
}

fn apply_root_namespace(file: &mut DotnetFile, projects: &[DotnetProject]) {
    let Some(project) = file.project_path.as_ref().and_then(|path| {
        projects
            .iter()
            .find(|project| same_path(&project.path, path))
    }) else {
        return;
    };
    let Some(root) = project.root_namespace.as_deref() else {
        return;
    };
    if root.is_empty() {
        return;
    }
    if file.namespace.is_empty() {
        file.namespace = root.to_owned();
    }
    for symbol in &mut file.symbols {
        if symbol.namespace.is_empty() {
            symbol.namespace = root.to_owned();
            symbol.qualified = format!("{root}.{}", symbol.qualified);
        }
    }
}

fn owning_project<'a>(file: &Path, projects: &'a [DotnetProject]) -> Option<&'a DotnetProject> {
    let mut best: Option<&DotnetProject> = None;
    let mut best_len = 0usize;
    for project in projects {
        let Some(directory) = project.path.parent() else {
            continue;
        };
        if file.starts_with(directory) {
            let len = directory.components().count();
            if best.is_none() || len > best_len {
                best = Some(project);
                best_len = len;
            }
        }
    }
    best
}

fn project_from_file(path: &Path) -> Result<DotnetProject, CargoDiscoveryError> {
    let text =
        fs::read_to_string(path).map_err(|source| CargoDiscoveryError::DotnetSourceRead {
            path: path.to_owned(),
            source,
        })?;
    let language = if extension_lower(path).as_deref() == Some("vbproj") {
        "vb"
    } else {
        "csharp"
    };
    let assembly = xml_text(&text, "AssemblyName");
    let name = assembly.unwrap_or_else(|| {
        path.file_stem()
            .map(|stem| stem.to_string_lossy().into_owned())
            .unwrap_or_else(|| "project".to_owned())
    });
    let root_namespace = xml_text(&text, "RootNamespace");
    let directory = path.parent().unwrap_or(Path::new(""));
    let mut references = Vec::new();
    for include in xml_attr_values(&text, "ProjectReference", "Include") {
        references.push(portable_join(directory, &include));
    }
    Ok(DotnetProject {
        name,
        path: path.to_owned(),
        language: language.to_owned(),
        root_namespace,
        references,
    })
}

fn xml_text(text: &str, element: &str) -> Option<String> {
    let open = format!("<{element}>");
    let close = format!("</{element}>");
    let start = text.find(&open)? + open.len();
    let end = text[start..].find(&close)? + start;
    let value = text[start..end].trim();
    if value.is_empty() {
        None
    } else {
        Some(value.to_owned())
    }
}

fn xml_attr_values(text: &str, element: &str, attr: &str) -> Vec<String> {
    let mut values = Vec::new();
    let needle = format!("<{element}");
    let mut rest = text;
    while let Some(index) = rest.find(&needle) {
        rest = &rest[index + needle.len()..];
        let end = rest.find('>').unwrap_or(rest.len());
        let tag = &rest[..end];
        let attr_needle = format!("{attr}=\"");
        if let Some(start) = tag.find(&attr_needle) {
            let value_start = start + attr_needle.len();
            if let Some(value_end) = tag[value_start..].find('"') {
                values.push(tag[value_start..value_start + value_end].to_owned());
            }
        }
        rest = &rest[end..];
    }
    values
}

fn walk_dotnet_files(
    directory: &Path,
    root: &Path,
    seen: &mut HashSet<PathBuf>,
    files: &mut Vec<PathBuf>,
) -> Result<(), CargoDiscoveryError> {
    let Some(canonical) = confined_dotnet_path(directory, root) else {
        return Ok(());
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
            walk_dotnet_files(&path, root, seen, files)?;
            continue;
        }
        if !is_dotnet_file(&path) || confined_dotnet_path(&path, root).is_none() {
            continue;
        }
        files.push(path);
    }
    Ok(())
}

fn confined_dotnet_path(path: &Path, root: &Path) -> Option<PathBuf> {
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
    is_ignored_directory(name) || matches!(name.to_ascii_lowercase().as_str(), "bin" | "obj")
}

fn is_dotnet_file(path: &Path) -> bool {
    matches!(
        extension_lower(path).as_deref(),
        Some("cs" | "vb" | "csproj" | "vbproj" | "sln")
    )
}

fn extension_lower(path: &Path) -> Option<String> {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.to_ascii_lowercase())
}

fn same_path(left: &Path, right: &Path) -> bool {
    normalize_path(left) == normalize_path(right)
}

fn portable_join(base: &Path, relative: &str) -> PathBuf {
    let mut out = base.to_path_buf();
    for part in relative.split(['/', '\\']) {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            out.pop();
            continue;
        }
        out.push(part);
    }
    normalize_path(&out)
}

fn normalize_path(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            component => normalized.push(component.as_os_str()),
        }
    }
    normalized
}

#[derive(Clone, Copy)]
enum MaskMode {
    Code,
    LineComment,
    BlockComment,
    Char {
        escape: bool,
    },
    Regular {
        interpolated: bool,
        braces: i32,
        nested: bool,
        escape: bool,
    },
    Verbatim {
        interpolated: bool,
        braces: i32,
        nested: bool,
    },
    Raw {
        quotes: usize,
        interpolated: bool,
        braces: i32,
        nested: bool,
    },
}

fn mask_csharp(source: &str) -> String {
    let chars: Vec<char> = source.chars().collect();
    let mut out = String::new();
    let mut index = 0;
    let mut stack = vec![MaskMode::Code];
    while index < chars.len() {
        let current = chars[index];
        let next = chars.get(index + 1).copied();
        let mode = *stack.last().unwrap_or(&MaskMode::Code);
        match mode {
            MaskMode::Code => {
                if current == '/' && next == Some('/') {
                    out.push(' ');
                    out.push(' ');
                    index += 2;
                    stack.push(MaskMode::LineComment);
                    continue;
                }
                if current == '/' && next == Some('*') {
                    out.push(' ');
                    out.push(' ');
                    index += 2;
                    stack.push(MaskMode::BlockComment);
                    continue;
                }
                if current == '\'' {
                    out.push(' ');
                    index += 1;
                    stack.push(MaskMode::Char { escape: false });
                    continue;
                }
                if let Some((mode, width)) = open_csharp_string(&chars, index) {
                    for _ in 0..width {
                        out.push(' ');
                    }
                    index += width;
                    stack.push(mode);
                    continue;
                }
                out.push(current);
                index += 1;
            }
            MaskMode::LineComment => {
                out.push(if current == '\n' { '\n' } else { ' ' });
                index += 1;
                if current == '\n' {
                    stack.pop();
                }
            }
            MaskMode::BlockComment => {
                if current == '*' && next == Some('/') {
                    out.push(' ');
                    out.push(' ');
                    index += 2;
                    stack.pop();
                    continue;
                }
                out.push(if current == '\n' { '\n' } else { ' ' });
                index += 1;
            }
            MaskMode::Char { escape } => {
                out.push(if current == '\n' { '\n' } else { ' ' });
                index += 1;
                if escape {
                    *stack.last_mut().unwrap() = MaskMode::Char { escape: false };
                } else if current == '\\' {
                    *stack.last_mut().unwrap() = MaskMode::Char { escape: true };
                } else if current == '\'' || current == '\n' {
                    stack.pop();
                }
            }
            MaskMode::Regular {
                interpolated,
                braces,
                nested,
                escape,
            } => {
                out.push(if current == '\n' { '\n' } else { ' ' });
                index += 1;
                let mut next_mode = mode;
                if escape {
                    next_mode = MaskMode::Regular {
                        interpolated,
                        braces,
                        nested,
                        escape: false,
                    };
                } else if nested {
                    if current == '\\' {
                        next_mode = MaskMode::Regular {
                            interpolated,
                            braces,
                            nested: true,
                            escape: true,
                        };
                    } else if current == '"' {
                        next_mode = MaskMode::Regular {
                            interpolated,
                            braces,
                            nested: false,
                            escape: false,
                        };
                    }
                } else if braces > 0 {
                    if current == '"' {
                        next_mode = MaskMode::Regular {
                            interpolated,
                            braces,
                            nested: true,
                            escape: false,
                        };
                    } else if current == '{' {
                        next_mode = MaskMode::Regular {
                            interpolated,
                            braces: braces + 1,
                            nested: false,
                            escape: false,
                        };
                    } else if current == '}' {
                        next_mode = MaskMode::Regular {
                            interpolated,
                            braces: braces - 1,
                            nested: false,
                            escape: false,
                        };
                    }
                } else if current == '\\' {
                    next_mode = MaskMode::Regular {
                        interpolated,
                        braces,
                        nested: false,
                        escape: true,
                    };
                } else if current == '"' || current == '\n' {
                    stack.pop();
                    continue;
                } else if interpolated && current == '{' {
                    if next == Some('{') {
                        out.push(' ');
                        index += 1;
                    } else {
                        next_mode = MaskMode::Regular {
                            interpolated,
                            braces: 1,
                            nested: false,
                            escape: false,
                        };
                    }
                }
                if let Some(top) = stack.last_mut() {
                    *top = next_mode;
                }
            }
            MaskMode::Verbatim {
                interpolated,
                braces,
                nested,
            } => {
                out.push(if current == '\n' { '\n' } else { ' ' });
                index += 1;
                let mut next_mode = mode;
                if nested {
                    if current == '"' && next == Some('"') {
                        out.push(' ');
                        index += 1;
                    } else if current == '"' {
                        next_mode = MaskMode::Verbatim {
                            interpolated,
                            braces,
                            nested: false,
                        };
                    }
                } else if braces > 0 {
                    if current == '"' {
                        next_mode = MaskMode::Verbatim {
                            interpolated,
                            braces,
                            nested: true,
                        };
                    } else if current == '{' {
                        next_mode = MaskMode::Verbatim {
                            interpolated,
                            braces: braces + 1,
                            nested: false,
                        };
                    } else if current == '}' {
                        next_mode = MaskMode::Verbatim {
                            interpolated,
                            braces: braces - 1,
                            nested: false,
                        };
                    }
                } else if current == '"' {
                    if next == Some('"') {
                        out.push(' ');
                        index += 1;
                    } else {
                        stack.pop();
                        continue;
                    }
                } else if interpolated && current == '{' && braces == 0 {
                    if next == Some('{') {
                        out.push(' ');
                        index += 1;
                    } else {
                        next_mode = MaskMode::Verbatim {
                            interpolated,
                            braces: 1,
                            nested: false,
                        };
                    }
                }
                if let Some(top) = stack.last_mut() {
                    *top = next_mode;
                }
            }
            MaskMode::Raw {
                quotes,
                interpolated,
                braces,
                nested,
            } => {
                if braces == 0 && !nested && current == '"' {
                    let count = count_quotes(&chars, index);
                    if count >= quotes {
                        for _ in 0..quotes {
                            out.push(' ');
                        }
                        index += quotes;
                        stack.pop();
                        continue;
                    }
                }
                out.push(if current == '\n' { '\n' } else { ' ' });
                index += 1;
                let mut next_mode = mode;
                if nested {
                    if current == '"' {
                        next_mode = MaskMode::Raw {
                            quotes,
                            interpolated,
                            braces,
                            nested: false,
                        };
                    }
                } else if braces > 0 {
                    if current == '"' {
                        next_mode = MaskMode::Raw {
                            quotes,
                            interpolated,
                            braces,
                            nested: true,
                        };
                    } else if current == '{' {
                        next_mode = MaskMode::Raw {
                            quotes,
                            interpolated,
                            braces: braces + 1,
                            nested: false,
                        };
                    } else if current == '}' {
                        next_mode = MaskMode::Raw {
                            quotes,
                            interpolated,
                            braces: braces - 1,
                            nested: false,
                        };
                    }
                } else if interpolated && current == '{' {
                    if next == Some('{') {
                        out.push(' ');
                        index += 1;
                    } else {
                        next_mode = MaskMode::Raw {
                            quotes,
                            interpolated,
                            braces: 1,
                            nested: false,
                        };
                    }
                }
                if let Some(top) = stack.last_mut() {
                    *top = next_mode;
                }
            }
        }
    }
    out
}

fn open_csharp_string(chars: &[char], index: usize) -> Option<(MaskMode, usize)> {
    let current = chars[index];
    let next = chars.get(index + 1).copied();
    let third = chars.get(index + 2).copied();
    if current == '@' && next == Some('$') && third == Some('"') {
        return Some((
            MaskMode::Verbatim {
                interpolated: true,
                braces: 0,
                nested: false,
            },
            3,
        ));
    }
    if current == '@' && next == Some('"') {
        return Some((
            MaskMode::Verbatim {
                interpolated: false,
                braces: 0,
                nested: false,
            },
            2,
        ));
    }
    if current == '$' && next == Some('@') && third == Some('"') {
        return Some((
            MaskMode::Verbatim {
                interpolated: true,
                braces: 0,
                nested: false,
            },
            3,
        ));
    }
    if current == '$' || current == '"' {
        let quote_at = if current == '$' { index + 1 } else { index };
        if chars.get(quote_at) != Some(&'"') {
            return None;
        }
        let quotes = count_quotes(chars, quote_at);
        let interpolated = current == '$';
        if quotes >= 3 {
            return Some((
                MaskMode::Raw {
                    quotes,
                    interpolated,
                    braces: 0,
                    nested: false,
                },
                quote_at - index + quotes,
            ));
        }
        if interpolated {
            return Some((
                MaskMode::Regular {
                    interpolated: true,
                    braces: 0,
                    nested: false,
                    escape: false,
                },
                2,
            ));
        }
        return Some((
            MaskMode::Regular {
                interpolated: false,
                braces: 0,
                nested: false,
                escape: false,
            },
            1,
        ));
    }
    None
}

fn count_quotes(chars: &[char], index: usize) -> usize {
    chars[index..]
        .iter()
        .take_while(|character| **character == '"')
        .count()
}

fn mask_vb(source: &str) -> String {
    let chars: Vec<char> = source.chars().collect();
    let mut out = String::new();
    let mut index = 0;
    let mut in_string = false;
    while index < chars.len() {
        let current = chars[index];
        if in_string {
            out.push(if current == '\n' { '\n' } else { ' ' });
            if current == '"' {
                if chars.get(index + 1) == Some(&'"') {
                    out.push(' ');
                    index += 2;
                    continue;
                }
                in_string = false;
            }
            index += 1;
            continue;
        }
        if current == '"' {
            in_string = true;
            out.push(' ');
            index += 1;
            continue;
        }
        if current == '\'' {
            out.push(' ');
            index += 1;
            while index < chars.len() && chars[index] != '\n' {
                out.push(' ');
                index += 1;
            }
            continue;
        }
        out.push(current);
        index += 1;
    }
    out
}

struct TypeFrame {
    qualified: String,
    simple: String,
    kind: DotnetSymbolKind,
    end_depth: usize,
    body_depth: usize,
}

struct NsFrame {
    full: String,
    end_depth: usize,
}

struct PendingType {
    symbol: DotnetSymbol,
    kind: DotnetSymbolKind,
}

fn parse_csharp(masked: &str) -> (Vec<DotnetImport>, Vec<DotnetSymbol>) {
    let mut imports = Vec::new();
    let mut symbols = Vec::new();
    let mut file_namespace: Option<String> = None;
    let mut namespaces: Vec<NsFrame> = Vec::new();
    let mut types: Vec<TypeFrame> = Vec::new();
    let mut pending: Option<PendingType> = None;
    let mut pending_namespace: Option<String> = None;
    let mut depth = 0usize;
    for (line_no, line) in csharp_logical_lines(masked) {
        let start_depth = depth;
        let trimmed = line.trim();
        if let Some(waiting) = pending.take() {
            if trimmed.starts_with('{') || trimmed.starts_with(':') {
                let mut symbol = waiting.symbol;
                if trimmed.starts_with(':') {
                    symbol.bases.extend(bases_from_line(&line));
                }
                if line.contains('{') {
                    types.push(TypeFrame {
                        qualified: symbol.qualified.clone(),
                        simple: symbol.name.clone(),
                        kind: waiting.kind,
                        end_depth: start_depth,
                        body_depth: start_depth + 1,
                    });
                } else {
                    pending = Some(PendingType {
                        symbol,
                        kind: waiting.kind,
                    });
                    depth = brace_depth(&line, depth);
                    pop_frames(&mut types, &mut namespaces, depth);
                    continue;
                }
                symbols.push(symbol);
                depth = brace_depth(&line, depth);
                pop_frames(&mut types, &mut namespaces, depth);
                continue;
            }
            symbols.push(waiting.symbol);
        }
        let mut code_line = line.to_owned();
        if let Some(full) = pending_namespace.take() {
            if trimmed.starts_with('{') {
                namespaces.push(NsFrame {
                    full,
                    end_depth: start_depth,
                });
                if let Some(brace) = line.find('{') {
                    code_line = line[brace + 1..].to_owned();
                }
            } else {
                file_namespace = Some(full);
            }
        }
        let code_trimmed = code_line.trim();
        if code_trimmed.is_empty() {
            depth = brace_depth(&line, depth);
            pop_frames(&mut types, &mut namespaces, depth);
            continue;
        }
        let code = strip_attributes(code_trimmed);
        let tokens = tokenize(&code);
        let partial = tokens.iter().any(|token| token == "partial");
        let index = skip_modifiers(&tokens);
        let current_ns = current_namespace(&file_namespace, &namespaces);
        if tokens.get(index).map(String::as_str) == Some("#") {
            depth = brace_depth(&line, depth);
            pop_frames(&mut types, &mut namespaces, depth);
            continue;
        }
        if let Some(import) = csharp_import(&tokens, index, line_no) {
            imports.push(import);
        } else if tokens.get(index).map(String::as_str) == Some("namespace") {
            if let Some(name) = dotted_name(&tokens, index + 1) {
                let full = join_namespace(&current_ns, &name);
                if code_line.contains(';') && !code_line.contains('{') {
                    file_namespace = Some(full);
                } else if code_line.contains('{') {
                    namespaces.push(NsFrame {
                        full,
                        end_depth: start_depth,
                    });
                } else {
                    pending_namespace = Some(full);
                }
            }
        } else if let Some(declared) =
            csharp_type(&tokens, index, partial, line_no, &current_ns, types.last())
        {
            if code_line.contains('{') {
                types.push(TypeFrame {
                    qualified: declared.qualified.clone(),
                    simple: declared.name.clone(),
                    kind: declared.kind,
                    end_depth: start_depth,
                    body_depth: start_depth + 1,
                });
                symbols.push(declared);
            } else if code_line.contains(';') {
                symbols.push(declared);
            } else {
                pending = Some(PendingType {
                    kind: declared.kind,
                    symbol: declared,
                });
            }
        } else if types
            .last()
            .is_some_and(|frame| frame.kind.allows_members() && start_depth == frame.body_depth)
        {
            if let Some(member) =
                csharp_member(&tokens, index, line_no, types.last().unwrap(), &current_ns)
            {
                if member.kind == DotnetSymbolKind::Method {
                    symbols.push(member);
                } else if let Some(owner) = symbols.iter_mut().rev().find(|symbol| {
                    symbol.kind.is_type() && symbol.qualified == types.last().unwrap().qualified
                }) {
                    owner.member_types.extend(member.member_types);
                }
            }
        }
        depth = brace_depth(&line, depth);
        pop_frames(&mut types, &mut namespaces, depth);
    }
    if let Some(waiting) = pending {
        symbols.push(waiting.symbol);
    }
    (imports, symbols)
}

fn csharp_logical_lines(masked: &str) -> Vec<(usize, String)> {
    let raw: Vec<&str> = masked.split('\n').collect();
    let mut lines = Vec::new();
    let mut index = 0;
    while index < raw.len() {
        let start = index + 1;
        let mut combined = raw[index].trim_end_matches('\r').to_owned();
        index += 1;
        loop {
            let angles =
                combined.matches('<').count() as i32 - combined.matches('>').count() as i32;
            let parens =
                combined.matches('(').count() as i32 - combined.matches(')').count() as i32;
            let trimmed = combined.trim();
            let hanging =
                trimmed.ends_with(':') || trimmed.ends_with(',') || angles > 0 || parens > 0;
            if !hanging || index >= raw.len() {
                break;
            }
            combined.push(' ');
            combined.push_str(raw[index].trim_end_matches('\r'));
            index += 1;
        }
        lines.push((start, combined));
    }
    lines
}

fn pop_frames(types: &mut Vec<TypeFrame>, namespaces: &mut Vec<NsFrame>, depth: usize) {
    while types.last().is_some_and(|frame| depth <= frame.end_depth) {
        types.pop();
    }
    while namespaces
        .last()
        .is_some_and(|frame| depth <= frame.end_depth)
    {
        namespaces.pop();
    }
}

fn brace_depth(line: &str, depth: usize) -> usize {
    let mut depth = depth as i32;
    for character in line.chars() {
        if character == '{' {
            depth += 1;
        } else if character == '}' {
            depth -= 1;
        }
    }
    depth.max(0) as usize
}

fn current_namespace(file_namespace: &Option<String>, namespaces: &[NsFrame]) -> String {
    namespaces
        .last()
        .map(|frame| frame.full.clone())
        .or_else(|| file_namespace.clone())
        .unwrap_or_default()
}

fn join_namespace(parent: &str, declared: &str) -> String {
    if parent.is_empty() {
        declared.to_owned()
    } else if declared.is_empty() {
        parent.to_owned()
    } else {
        format!("{parent}.{declared}")
    }
}

fn csharp_import(tokens: &[String], mut index: usize, line: usize) -> Option<DotnetImport> {
    let mut global = false;
    if tokens.get(index).map(String::as_str) == Some("global")
        && tokens.get(index + 1).map(String::as_str) == Some("using")
    {
        global = true;
        index += 1;
    }
    if tokens.get(index).map(String::as_str) != Some("using") {
        return None;
    }
    if matches!(tokens.get(index + 1).map(String::as_str), Some("(" | "var")) {
        return None;
    }
    index += 1;
    let mut static_import = false;
    if tokens.get(index).map(String::as_str) == Some("static") {
        static_import = true;
        index += 1;
    }
    let target = dotted_name(tokens, index)?;
    let mut alias = None;
    let after = index + target.split('.').count() * 2 - 1;
    if tokens.get(after).map(String::as_str) == Some("=") {
        alias = Some(target.clone());
        let real = dotted_name(tokens, after + 1)?;
        let statement = if global {
            format!("global using {target} = {real}")
        } else {
            format!("using {target} = {real}")
        };
        return Some(DotnetImport {
            line,
            target: real,
            alias,
            global,
            statement,
        });
    }
    let statement = if global && static_import {
        format!("global using static {target}")
    } else if global {
        format!("global using {target}")
    } else if static_import {
        format!("using static {target}")
    } else {
        format!("using {target}")
    };
    Some(DotnetImport {
        line,
        target,
        alias,
        global,
        statement,
    })
}

fn csharp_type(
    tokens: &[String],
    index: usize,
    partial: bool,
    line: usize,
    namespace: &str,
    owner: Option<&TypeFrame>,
) -> Option<DotnetSymbol> {
    let mut cursor = index;
    let kind = match tokens.get(cursor).map(String::as_str) {
        Some("class") => DotnetSymbolKind::Class,
        Some("struct") => DotnetSymbolKind::Struct,
        Some("interface") => DotnetSymbolKind::Interface,
        Some("enum") => DotnetSymbolKind::Enum,
        Some("record") => {
            if matches!(
                tokens.get(cursor + 1).map(String::as_str),
                Some("struct" | "class")
            ) {
                cursor += 1;
            }
            DotnetSymbolKind::Record
        }
        _ => return None,
    };
    cursor += 1;
    let name = tokens.get(cursor).filter(|token| is_ident(token))?.clone();
    cursor += 1;
    if tokens.get(cursor).map(String::as_str) == Some("<") {
        cursor = skip_nest(tokens, cursor, "<", ">");
    }
    let mut member_types = Vec::new();
    if tokens.get(cursor).map(String::as_str) == Some("(") {
        let end = skip_nest(tokens, cursor, "(", ")");
        member_types.extend(type_names(&tokens[cursor + 1..end.saturating_sub(1)]));
        cursor = end;
    }
    let mut bases = Vec::new();
    if tokens.get(cursor).map(String::as_str) == Some(":") {
        let rest = &tokens[cursor + 1..];
        let end = rest
            .iter()
            .position(|token| token == "{" || token == "where" || token == ";")
            .unwrap_or(rest.len());
        bases.extend(type_names(&rest[..end]));
    }
    let qualified = qualify(
        namespace,
        owner.map(|frame| frame.qualified.as_str()),
        &name,
    );
    Some(DotnetSymbol {
        name,
        qualified,
        kind,
        line,
        namespace: namespace.to_owned(),
        partial,
        bases,
        member_types,
    })
}

fn csharp_member(
    tokens: &[String],
    index: usize,
    line: usize,
    owner: &TypeFrame,
    namespace: &str,
) -> Option<DotnetSymbol> {
    if index >= tokens.len() {
        return None;
    }
    if is_control(&tokens[index]) {
        return None;
    }
    let paren = tokens.iter().position(|token| token == "(");
    let brace = tokens.iter().position(|token| token == "{");
    let is_method = paren.is_some_and(|paren_at| brace.is_none_or(|brace_at| paren_at < brace_at));
    if is_method {
        let paren_at = paren?;
        if paren_at == 0 {
            return None;
        }
        let name = tokens
            .get(paren_at - 1)
            .filter(|token| is_ident(token))?
            .clone();
        if is_control(&name) {
            return None;
        }
        let mut member_types = type_names(&tokens[index..paren_at.saturating_sub(1)]);
        let end = skip_nest(tokens, paren_at, "(", ")");
        member_types.extend(type_names(&tokens[paren_at + 1..end.saturating_sub(1)]));
        return Some(DotnetSymbol {
            name,
            qualified: owner.qualified.clone(),
            kind: DotnetSymbolKind::Method,
            line,
            namespace: namespace.to_owned(),
            partial: false,
            bases: Vec::new(),
            member_types,
        });
    }
    let terminator = tokens
        .iter()
        .position(|token| token == "{" || token == ";" || token == "=")
        .unwrap_or(tokens.len());
    if terminator == 0 {
        return None;
    }
    let name_at = (0..terminator)
        .rev()
        .find(|cursor| is_ident(&tokens[*cursor]))?;
    member_type_symbol(&tokens[index..name_at], owner, namespace, line)
}

fn member_type_symbol(
    type_tokens: &[String],
    owner: &TypeFrame,
    namespace: &str,
    line: usize,
) -> Option<DotnetSymbol> {
    let member_types = type_names(type_tokens);
    if member_types.is_empty() {
        return None;
    }
    Some(DotnetSymbol {
        name: owner.simple.clone(),
        qualified: owner.qualified.clone(),
        kind: owner.kind,
        line,
        namespace: namespace.to_owned(),
        partial: false,
        bases: Vec::new(),
        member_types,
    })
}

fn bases_from_line(line: &str) -> Vec<String> {
    let code = strip_attributes(line.trim().trim_start_matches(':').trim());
    let tokens = tokenize(&code);
    let end = tokens
        .iter()
        .position(|token| token == "{" || token == "where")
        .unwrap_or(tokens.len());
    type_names(&tokens[..end])
}

fn parse_vb(masked: &str) -> (Vec<DotnetImport>, Vec<DotnetSymbol>) {
    let mut imports = Vec::new();
    let mut symbols: Vec<DotnetSymbol> = Vec::new();
    let mut namespaces: Vec<String> = Vec::new();
    let mut types: Vec<String> = Vec::new();
    let mut type_kinds: Vec<DotnetSymbolKind> = Vec::new();
    let mut in_method = 0usize;
    for (offset, raw) in vb_logical_lines(masked).into_iter().enumerate() {
        let line_no = offset + 1;
        let tokens = tokenize(raw.trim());
        if tokens.is_empty() {
            continue;
        }
        let lower: Vec<String> = tokens
            .iter()
            .map(|token| token.to_ascii_lowercase())
            .collect();
        if lower.first().map(String::as_str) == Some("end") {
            match lower.get(1).map(String::as_str) {
                Some("namespace") => {
                    namespaces.pop();
                }
                Some("class" | "structure" | "interface" | "module" | "enum") => {
                    types.pop();
                    type_kinds.pop();
                }
                Some("sub" | "function") => {
                    in_method = in_method.saturating_sub(1);
                }
                _ => {}
            }
            continue;
        }
        if lower.first().map(String::as_str) == Some("imports") {
            if let Some(import) = vb_import(&tokens, &lower, line_no) {
                imports.push(import);
            }
            continue;
        }
        if lower.first().map(String::as_str) == Some("namespace") {
            if let Some(name) = dotted_name(&tokens, 1) {
                let full =
                    join_namespace(namespaces.last().map(String::as_str).unwrap_or(""), &name);
                namespaces.push(full);
            }
            continue;
        }
        if matches!(
            lower.first().map(String::as_str),
            Some("inherits" | "implements")
        ) {
            let bases = type_names(&tokens[1..]);
            if let Some(owner) = types.last() {
                if let Some(symbol) = symbols
                    .iter_mut()
                    .rev()
                    .find(|symbol| symbol.kind.is_type() && symbol.qualified == *owner)
                {
                    symbol.bases.extend(bases);
                }
            }
            continue;
        }
        if let Some(kind_at) = lower.iter().position(|token| {
            matches!(
                token.as_str(),
                "class" | "structure" | "interface" | "module" | "enum"
            )
        }) {
            if kind_at > 0 && is_control(&lower[0]) {
                continue;
            }
            let kind = match lower[kind_at].as_str() {
                "class" => DotnetSymbolKind::Class,
                "structure" => DotnetSymbolKind::Struct,
                "interface" => DotnetSymbolKind::Interface,
                "module" => DotnetSymbolKind::Module,
                "enum" => DotnetSymbolKind::Enum,
                _ => continue,
            };
            let name = tokens.get(kind_at + 1).filter(|token| is_ident(token));
            let Some(name) = name else { continue };
            if lower[..kind_at].iter().any(|token| token == "end") {
                continue;
            }
            let namespace = namespaces.last().cloned().unwrap_or_default();
            let owner = types.last().cloned();
            let qualified = qualify(&namespace, owner.as_deref(), name);
            let partial = lower.iter().any(|token| token == "partial");
            symbols.push(DotnetSymbol {
                name: name.clone(),
                qualified: qualified.clone(),
                kind,
                line: line_no,
                namespace,
                partial,
                bases: Vec::new(),
                member_types: Vec::new(),
            });
            types.push(qualified);
            type_kinds.push(kind);
            continue;
        }
        let in_type = type_kinds.last().is_some_and(|kind| kind.allows_members());
        if !in_type || in_method > 0 {
            continue;
        }
        if let Some(kind_at) = lower
            .iter()
            .position(|token| matches!(token.as_str(), "sub" | "function"))
        {
            let name = tokens.get(kind_at + 1).filter(|token| is_ident(token));
            let Some(name) = name else { continue };
            let owner = types.last().cloned().unwrap_or_default();
            let mut member_types = Vec::new();
            if let Some(paren) = tokens.iter().position(|token| token == "(") {
                let end = skip_nest(&tokens, paren, "(", ")");
                member_types.extend(vb_param_types(&tokens[paren + 1..end.saturating_sub(1)]));
                if lower[kind_at].as_str() == "function" {
                    if let Some(as_at) = lower.iter().rposition(|token| token == "as") {
                        if as_at > paren {
                            member_types.extend(type_names(&tokens[as_at + 1..]));
                        }
                    }
                }
            }
            symbols.push(DotnetSymbol {
                name: name.clone(),
                qualified: owner,
                kind: DotnetSymbolKind::Method,
                line: line_no,
                namespace: namespaces.last().cloned().unwrap_or_default(),
                partial: false,
                bases: Vec::new(),
                member_types,
            });
            in_method += 1;
            continue;
        }
        if let Some(as_at) = lower.iter().position(|token| token == "as") {
            if let Some(owner) = types.last() {
                let member_types = type_names(&tokens[as_at + 1..]);
                if let Some(symbol) = symbols
                    .iter_mut()
                    .rev()
                    .find(|symbol| symbol.kind.is_type() && symbol.qualified == *owner)
                {
                    symbol.member_types.extend(member_types);
                }
            }
        }
    }
    let _ = in_method;
    (imports, symbols)
}

fn vb_logical_lines(masked: &str) -> Vec<String> {
    let mut lines = Vec::new();
    let mut current = String::new();
    for raw in masked.split('\n') {
        let line = raw.trim_end_matches('\r');
        let continued = line.trim_end().ends_with(" _");
        let piece = if continued {
            line.trim_end().trim_end_matches('_').trim_end()
        } else {
            line
        };
        if !current.is_empty() {
            current.push(' ');
        }
        current.push_str(piece);
        if !continued {
            lines.push(std::mem::take(&mut current));
        }
    }
    if !current.is_empty() {
        lines.push(current);
    }
    lines
}

fn vb_import(tokens: &[String], lower: &[String], line: usize) -> Option<DotnetImport> {
    let mut index = 1usize;
    if lower.get(index).map(String::as_str) == Some("global") {
        // VB global imports are still imports.
        index += 1;
    }
    let target = dotted_name(tokens, index)?;
    let after = index + target.matches('.').count() + 1;
    if tokens.get(after).map(String::as_str) == Some("=") {
        let real = dotted_name(tokens, after + 1)?;
        return Some(DotnetImport {
            line,
            alias: Some(target.clone()),
            target: real.clone(),
            global: lower.get(1).map(String::as_str) == Some("global"),
            statement: format!("Imports {target} = {real}"),
        });
    }
    Some(DotnetImport {
        line,
        target: target.clone(),
        alias: None,
        global: lower.get(1).map(String::as_str) == Some("global"),
        statement: format!("Imports {target}"),
    })
}

fn vb_param_types(tokens: &[String]) -> Vec<String> {
    let mut types = Vec::new();
    let mut current = Vec::new();
    let mut depth = 0i32;
    for token in tokens {
        if token == "(" {
            depth += 1;
        } else if token == ")" {
            depth -= 1;
        }
        if token == "," && depth == 0 {
            types.extend(as_type(&current));
            current.clear();
        } else {
            current.push(token.clone());
        }
    }
    types.extend(as_type(&current));
    types
}

fn as_type(tokens: &[String]) -> Vec<String> {
    let lower: Vec<String> = tokens
        .iter()
        .map(|token| token.to_ascii_lowercase())
        .collect();
    let Some(as_at) = lower.iter().position(|token| token == "as") else {
        return Vec::new();
    };
    type_names(&tokens[as_at + 1..])
}

fn qualify(namespace: &str, owner: Option<&str>, name: &str) -> String {
    if let Some(owner) = owner {
        format!("{owner}.{name}")
    } else if namespace.is_empty() {
        name.to_owned()
    } else {
        format!("{namespace}.{name}")
    }
}

fn skip_modifiers(tokens: &[String]) -> usize {
    let mut index = 0;
    while tokens.get(index).is_some_and(is_modifier) {
        index += 1;
    }
    index
}

fn is_modifier(token: &String) -> bool {
    matches!(
        token.as_str(),
        "public"
            | "private"
            | "protected"
            | "internal"
            | "static"
            | "abstract"
            | "sealed"
            | "partial"
            | "readonly"
            | "ref"
            | "file"
            | "unsafe"
            | "new"
            | "virtual"
            | "override"
            | "async"
            | "extern"
            | "volatile"
            | "required"
            | "const"
            | "fixed"
            | "friend"
            | "shared"
            | "overrides"
            | "overridable"
            | "mustoverride"
            | "notinheritable"
            | "mustinherit"
            | "writeonly"
            | "withevents"
            | "shadows"
            | "overloads"
            | "dim"
            | "iterator"
    )
}

fn is_control(token: &str) -> bool {
    matches!(
        token,
        "if" | "for"
            | "foreach"
            | "while"
            | "switch"
            | "lock"
            | "using"
            | "fixed"
            | "catch"
            | "else"
            | "do"
            | "return"
            | "throw"
            | "new"
            | "try"
            | "checked"
            | "unchecked"
            | "var"
            | "when"
            | "case"
    )
}

fn is_ident(token: &str) -> bool {
    let mut chars = token.chars();
    match chars.next() {
        Some(first) if first == '_' || first == '@' || first.is_alphabetic() => {}
        _ => return false,
    }
    chars.all(|character| character == '_' || character.is_alphanumeric())
}

fn dotted_name(tokens: &[String], start: usize) -> Option<String> {
    if !tokens.get(start).is_some_and(|token| is_ident(token)) {
        return None;
    }
    let mut name = tokens[start].clone();
    let mut index = start + 1;
    while tokens.get(index).map(String::as_str) == Some(".")
        && tokens.get(index + 1).is_some_and(|token| is_ident(token))
    {
        name.push('.');
        name.push_str(&tokens[index + 1]);
        index += 2;
    }
    Some(name)
}

fn skip_nest(tokens: &[String], start: usize, open: &str, close: &str) -> usize {
    let mut depth = 0i32;
    for (offset, token) in tokens.iter().enumerate().skip(start) {
        if token == open {
            depth += 1;
        } else if token == close {
            depth -= 1;
            if depth == 0 {
                return offset + 1;
            }
        }
    }
    tokens.len()
}

fn type_names(tokens: &[String]) -> Vec<String> {
    let mut names = Vec::new();
    let mut current = String::new();
    let mut angle = 0i32;
    let flush = |current: &mut String, names: &mut Vec<String>| {
        if !current.is_empty() {
            names.push(std::mem::take(current));
        }
    };
    for token in tokens {
        if token == "<" {
            if angle == 0 {
                flush(&mut current, &mut names);
            }
            angle += 1;
            continue;
        }
        if token == ">" {
            angle = angle.saturating_sub(1);
            continue;
        }
        if angle > 0 {
            if is_ident(token) {
                names.push(token.clone());
            }
            continue;
        }
        if token == "," {
            flush(&mut current, &mut names);
            continue;
        }
        if token == "[" || token == "]" || token == "?" || token == "(" || token == ")" {
            continue;
        }
        if token == "." {
            if !current.is_empty() {
                current.push('.');
            }
            continue;
        }
        if is_ident(token) {
            if current.ends_with('.') || current.is_empty() {
                current.push_str(token);
            } else {
                flush(&mut current, &mut names);
                current.push_str(token);
            }
        }
    }
    flush(&mut current, &mut names);
    names
}

fn strip_attributes(line: &str) -> String {
    let mut out = String::new();
    let mut depth = 0i32;
    for character in line.chars() {
        if character == '[' {
            depth += 1;
            continue;
        }
        if character == ']' && depth > 0 {
            depth -= 1;
            continue;
        }
        if depth == 0 {
            out.push(character);
        }
    }
    out
}

fn tokenize(line: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    for character in line.chars() {
        if character.is_alphanumeric() || character == '_' || character == '@' {
            current.push(character);
        } else {
            if !current.is_empty() {
                tokens.push(std::mem::take(&mut current));
            }
            if !character.is_whitespace() {
                tokens.push(character.to_string());
            }
        }
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    tokens
}

#[cfg(test)]
mod tests {
    use super::{
        discover_dotnet, parse_csharp_source, parse_vb_source, solution_project_paths,
        DotnetSymbolKind,
    };
    use crate::extract::extract_cargo_map;
    use crate::facts::FactBlock;
    use std::path::PathBuf;

    fn fixture_root() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures/dotnet-sample")
    }

    fn names_of(source: &str, csharp: bool) -> Vec<String> {
        let (_imports, symbols) = if csharp {
            parse_csharp_source(source)
        } else {
            parse_vb_source(source)
        };
        symbols.into_iter().map(|symbol| symbol.name).collect()
    }

    #[test]
    fn csharp_skips_comments_strings_and_reads_partial_types() {
        let source = r#"
namespace Sample;
public partial class Real : Other {
    public string Name { get; set; }
    public int Measure(Part item) { return 1; }
}
// class Fake {}
string text = "class Fake2 {}";
string verbatim = @"class Fake3 {}";
string raw = """
class Fake4 {}
""";
"#;
        let (imports, symbols) = parse_csharp_source(source);
        assert!(imports.is_empty());
        let types: Vec<_> = symbols
            .iter()
            .filter(|symbol| symbol.kind == DotnetSymbolKind::Class)
            .map(|symbol| symbol.name.as_str())
            .collect();
        assert_eq!(types, ["Real"]);
        assert!(symbols
            .iter()
            .any(|symbol| symbol.name == "Measure" && symbol.kind == DotnetSymbolKind::Method));
        assert!(symbols.iter().any(|symbol| symbol
            .member_types
            .iter()
            .any(|ty| ty == "Part" || ty == "string")));
        assert_eq!(
            symbols
                .iter()
                .find(|symbol| symbol.name == "Real")
                .unwrap()
                .bases,
            ["Other"]
        );
        assert!(!names_of(source, true)
            .iter()
            .any(|name| name.starts_with("Fake")));
    }

    #[test]
    fn csharp_file_scoped_namespace_survives_crlf() {
        let (imports, symbols) = parse_csharp_source(
            "using VbApp;\r\nnamespace A;\r\npublic class B {\r\n public void M() {}\r\n}\r\n",
        );
        assert_eq!(imports[0].target, "VbApp");
        assert_eq!(symbols[0].name, "B");
        assert_eq!(symbols[0].qualified, "A.B");
        assert!(symbols.iter().any(|symbol| symbol.name == "M"));
    }

    #[test]
    fn vb_is_case_insensitive_and_skips_comments() {
        let source = "Imports CSharpApp\nNamespace VbApp\nPublic CLASS part\nPublic Function Grow(ByVal amount As Integer) As Integer\nReturn amount\nEnd Function\nEnd Class\nEnd Namespace\n' Class Hidden\n";
        let (imports, symbols) = parse_vb_source(source);
        assert_eq!(imports[0].target, "CSharpApp");
        assert!(symbols
            .iter()
            .any(|symbol| symbol.kind == DotnetSymbolKind::Class && symbol.namespace == "VbApp"));
        assert!(symbols
            .iter()
            .any(|symbol| symbol.name == "Grow" && symbol.kind == DotnetSymbolKind::Method));
        assert!(!symbols.iter().any(|symbol| symbol.name == "Hidden"));
    }

    #[test]
    fn solution_lists_both_projects() {
        let text = std::fs::read_to_string(fixture_root().join("Sample.sln")).expect("sln");
        let paths = solution_project_paths(&text);
        assert_eq!(paths, ["csharp\\CSharpApp.csproj", "vb\\VbApp.vbproj"]);
    }

    #[test]
    fn fixture_maps_projects_partials_and_skips_build_output() {
        let found = discover_dotnet(&fixture_root()).expect("discover");
        let names: Vec<_> = found
            .projects
            .iter()
            .map(|project| project.name.as_str())
            .collect();
        assert_eq!(names, ["CSharpApp", "VbApp"]);
        assert!(found.projects.iter().any(|project| {
            project.name == "CSharpApp"
                && project
                    .references
                    .iter()
                    .any(|path| path.ends_with("VbApp.vbproj"))
        }));
        assert!(found.projects.iter().any(|project| {
            project.name == "VbApp"
                && project
                    .references
                    .iter()
                    .any(|path| path.ends_with("CSharpApp.csproj"))
        }));
        assert!(!found.files.iter().any(|file| {
            let text = file.path.to_string_lossy().replace('\\', "/");
            text.contains("/bin/") || text.contains("/obj/")
        }));
        assert!(found
            .files
            .iter()
            .any(|file| file.path.extension().and_then(|ext| ext.to_str()) == Some("CS")));
        let widget_parts = found
            .files
            .iter()
            .filter(|file| {
                file.symbols
                    .iter()
                    .any(|symbol| symbol.name == "Widget" && symbol.partial)
            })
            .count();
        assert_eq!(widget_parts, 2);
        let map = extract_cargo_map(fixture_root(), Some("DotnetSample")).expect("map");
        let modules: Vec<_> = map
            .blocks
            .iter()
            .filter_map(|block| match block {
                FactBlock::Module(module) => Some(module),
                _ => None,
            })
            .collect();
        assert_eq!(
            modules
                .iter()
                .filter(|module| module.base.label == "Widget")
                .count(),
            1
        );
        assert!(modules
            .iter()
            .any(|module| module.base.label == "ExtraCase"));
        assert!(!modules.iter().any(|module| module.base.label == "BinOnly"
            || module.base.label == "ObjOnly"
            || module.base.label == "NotAClass"
            || module.base.label == "Hidden"));
        let widget = modules
            .iter()
            .find(|module| module.base.label == "Widget")
            .unwrap();
        let part = modules
            .iter()
            .find(|module| module.base.label == "Part" && module.language == "vb")
            .unwrap();
        let csharp = modules
            .iter()
            .find(|module| module.cfg_attributes == ["project"] && module.base.label == "CSharpApp")
            .unwrap();
        let vb = modules
            .iter()
            .find(|module| module.cfg_attributes == ["project"] && module.base.label == "VbApp")
            .unwrap();
        assert!(map.connections.iter().any(|connection| connection_ends(
            connection,
            &csharp.base.id,
            &vb.base.id
        )));
        assert!(map.connections.iter().any(|connection| connection_ends(
            connection,
            &vb.base.id,
            &csharp.base.id
        )));
        assert!(map.connections.iter().any(|connection| connection_ends(
            connection,
            &widget.base.id,
            &part.base.id
        )));
        assert!(modules.iter().any(|module| module.base.label == "Measure"
            && module.base.parent_id.as_deref() == Some(widget.base.id.as_str())));
        assert!(modules.iter().any(|module| module.base.label == "Reset"
            && module.base.parent_id.as_deref() == Some(widget.base.id.as_str())));
        assert!(modules
            .iter()
            .any(|module| module.base.label == "Grow" && module.language == "vb"));
        assert!(modules
            .iter()
            .any(|module| module.base.label == "Run" && module.cfg_attributes == ["method"]));
        assert!(modules
            .iter()
            .any(|module| module.base.label == "Café" && module.language == "csharp"));
        assert!(modules.iter().any(|module| module.base.label == "名前"));
        assert!(modules
            .iter()
            .any(|module| module.base.label == "Café" && module.language == "vb"));
        let chooses: Vec<_> = modules
            .iter()
            .filter(|module| module.base.label == "Choose" && module.cfg_attributes == ["method"])
            .collect();
        assert_eq!(chooses.len(), 2, "each overload stays a block");
        assert_ne!(chooses[0].base.id, chooses[1].base.id);
    }

    #[test]
    fn allman_brace_namespace_leaves_the_following_sibling_outside() {
        let source = include_str!("../fixtures/dotnet-sample/csharp/BraceNamespace.cs");
        let (_imports, symbols) = parse_csharp_source(source);
        let inside = symbols
            .iter()
            .find(|symbol| symbol.name == "InsideBrace")
            .expect("InsideBrace");
        let outside = symbols
            .iter()
            .find(|symbol| symbol.name == "OutsideBrace")
            .expect("OutsideBrace");
        assert_eq!(inside.namespace, "CSharpApp");
        assert_eq!(outside.namespace, "");
        assert_eq!(inside.qualified, "CSharpApp.InsideBrace");
        assert_eq!(outside.qualified, "OutsideBrace");
    }

    #[test]
    fn type_names_keep_non_ascii_characters() {
        let source = include_str!("../fixtures/dotnet-sample/csharp/Cafe.cs");
        let (_imports, symbols) = parse_csharp_source(source);
        assert!(symbols.iter().any(|symbol| symbol.name == "Café"));
        assert!(symbols.iter().any(|symbol| symbol.name == "名前"));
        let vb = include_str!("../fixtures/dotnet-sample/vb/Cafe.vb");
        let (_imports, symbols) = parse_vb_source(vb);
        assert!(symbols.iter().any(|symbol| symbol.name == "Café"));
    }

    fn connection_ends(connection: &crate::facts::Connection, source: &str, target: &str) -> bool {
        match connection {
            crate::facts::Connection::DependsOn {
                source: from,
                target: to,
                ..
            } => from == source && to == target,
            crate::facts::Connection::Contains { .. } => false,
        }
    }
}
