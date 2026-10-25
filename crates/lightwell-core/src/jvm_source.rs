use crate::metadata::CargoDiscoveryError;
use crate::path_confinement::{confined_canonical, opened_root};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum JvmModuleKind {
    Maven,
    Gradle,
}

impl JvmModuleKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Maven => "maven",
            Self::Gradle => "gradle",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum JvmLanguage {
    Java,
    Kotlin,
}

impl JvmLanguage {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Java => "java",
            Self::Kotlin => "kotlin",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum JvmSymbolKind {
    Class,
    Interface,
    Enum,
    Object,
    Fun,
}

impl JvmSymbolKind {
    pub(crate) fn outline_label(self) -> &'static str {
        match self {
            Self::Class => "class",
            Self::Interface => "interface",
            Self::Enum => "enum",
            Self::Object => "object",
            Self::Fun => "fun",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct JvmModule {
    pub name: String,
    pub path: PathBuf,
    pub kind: JvmModuleKind,
}

impl JvmModule {
    pub(crate) fn marker_file(&self) -> Option<PathBuf> {
        let names: &[&str] = match self.kind {
            JvmModuleKind::Gradle => &[
                "build.gradle.kts",
                "build.gradle",
                "settings.gradle.kts",
                "settings.gradle",
            ],
            JvmModuleKind::Maven => &["pom.xml"],
        };
        names
            .iter()
            .map(|name| self.path.join(name))
            .find(|path| path.is_file())
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct JvmPackage {
    pub name: String,
    pub module_name: Option<String>,
    pub directory: PathBuf,
    pub files: Vec<JvmFile>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct JvmFile {
    pub path: PathBuf,
    pub language: JvmLanguage,
    pub test: bool,
    pub unreadable: bool,
    pub imports: Vec<JvmImport>,
    pub symbols: Vec<JvmSymbol>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct JvmImport {
    pub line: usize,
    pub path: String,
    pub static_import: bool,
}

impl JvmImport {
    pub(crate) fn statement(&self) -> String {
        if self.static_import {
            format!("import static {};", self.path)
        } else {
            format!("import {};", self.path)
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct JvmSymbol {
    pub name: String,
    pub kind: JvmSymbolKind,
    pub line: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct JvmWorkspace {
    pub modules: Vec<JvmModule>,
    pub packages: Vec<JvmPackage>,
}

impl JvmWorkspace {
    fn empty() -> Self {
        Self {
            modules: Vec::new(),
            packages: Vec::new(),
        }
    }
}

/// Discover Maven and Gradle modules under `repository_path`.
/// A tree with no `pom.xml` or Gradle build file is an empty workspace.
pub(crate) fn discover_jvm(repository_path: &Path) -> Result<JvmWorkspace, CargoDiscoveryError> {
    let canonical_root = opened_root(repository_path)?;
    let mut found = Found::default();
    let mut seen = HashSet::new();
    walk_jvm(repository_path, &canonical_root, &mut seen, &mut found)?;
    if found.markers.is_empty() {
        return Ok(JvmWorkspace::empty());
    }
    let mut modules = discover_modules(repository_path, &canonical_root, &found)?;
    if modules.is_empty() {
        modules.push(JvmModule {
            name: single_root_name(repository_path),
            path: repository_path.to_path_buf(),
            kind: kind_for(repository_path, JvmModuleKind::Maven),
        });
    }
    disambiguate_names(repository_path, &mut modules);
    modules.sort_by(|left, right| left.name.cmp(&right.name).then(left.path.cmp(&right.path)));
    let packages = group_sources(repository_path, &modules, &found.sources);
    Ok(JvmWorkspace { modules, packages })
}

pub(crate) fn parse_jvm_source(
    source: &str,
    language: JvmLanguage,
) -> (Vec<JvmImport>, Vec<JvmSymbol>) {
    let source = source.strip_prefix('\u{feff}').unwrap_or(source);
    let stripped = strip_jvm_comments(source);
    (parse_imports(&stripped), parse_symbols(&stripped, language))
}

/// Longest package whose name is `import_path` or a dot-bounded prefix of it.
pub(crate) fn jvm_import_package_matches<'a>(
    import_path: &str,
    packages: &'a [JvmPackage],
) -> Vec<&'a JvmPackage> {
    let normalized = normalize_import_path(import_path);
    let mut best = 0usize;
    let mut matched = Vec::new();
    for package in packages {
        if package.name.is_empty() || !import_matches_package(&normalized, &package.name) {
            continue;
        }
        if package.name.len() > best {
            best = package.name.len();
            matched.clear();
            matched.push(package);
        } else if package.name.len() == best {
            matched.push(package);
        }
    }
    matched
}

#[derive(Default)]
struct Found {
    markers: Vec<PathBuf>,
    settings: Vec<PathBuf>,
    poms: Vec<PathBuf>,
    sources: Vec<PathBuf>,
}

fn discover_modules(
    root: &Path,
    canonical_root: &Path,
    found: &Found,
) -> Result<Vec<JvmModule>, CargoDiscoveryError> {
    let mut modules = Vec::new();
    let mut settings = found.settings.clone();
    settings.sort();
    for path in settings {
        let text = match fs::read_to_string(&path) {
            Ok(text) => text,
            Err(_) => continue,
        };
        let base = path.parent().unwrap_or(root);
        for spec in gradle_includes(&text) {
            push_module(
                &mut modules,
                base,
                &spec,
                JvmModuleKind::Gradle,
                canonical_root,
            );
        }
    }
    let mut poms = found.poms.clone();
    poms.sort();
    for path in poms {
        let text = match fs::read_to_string(&path) {
            Ok(text) => text,
            Err(_) => continue,
        };
        let base = path.parent().unwrap_or(root);
        for spec in maven_module_paths(&text) {
            push_module(
                &mut modules,
                base,
                &spec,
                JvmModuleKind::Maven,
                canonical_root,
            );
        }
    }
    for module in &mut modules {
        module.kind = kind_for(&module.path, module.kind);
    }
    Ok(modules)
}

fn push_module(
    modules: &mut Vec<JvmModule>,
    base: &Path,
    spec: &str,
    kind: JvmModuleKind,
    canonical_root: &Path,
) {
    let Some(relative) = include_to_relative(spec) else {
        return;
    };
    let Some(path) = safe_join(base, &relative) else {
        return;
    };
    if path.exists() && confined_jvm_path(&path, canonical_root).is_none() {
        return;
    }
    if modules.iter().any(|module| same_dir(&module.path, &path)) {
        return;
    }
    modules.push(JvmModule {
        name: String::new(),
        path,
        kind,
    });
}

fn kind_for(dir: &Path, fallback: JvmModuleKind) -> JvmModuleKind {
    if dir.join("build.gradle").is_file() || dir.join("build.gradle.kts").is_file() {
        JvmModuleKind::Gradle
    } else if dir.join("pom.xml").is_file() {
        JvmModuleKind::Maven
    } else {
        fallback
    }
}

fn single_root_name(root: &Path) -> String {
    if let Some(name) = read_settings_name(root) {
        return name;
    }
    if let Some(name) = read_maven_artifact_id(root) {
        return name;
    }
    root.file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("jvm")
        .to_owned()
}

fn read_settings_name(root: &Path) -> Option<String> {
    for name in ["settings.gradle.kts", "settings.gradle"] {
        let path = root.join(name);
        let Ok(text) = fs::read_to_string(&path) else {
            continue;
        };
        if let Some(project) = gradle_project_name(&text) {
            return Some(project);
        }
    }
    None
}

fn read_maven_artifact_id(root: &Path) -> Option<String> {
    let text = fs::read_to_string(root.join("pom.xml")).ok()?;
    maven_artifact_id(&text)
}

fn disambiguate_names(root: &Path, modules: &mut [JvmModule]) {
    let leaves: Vec<String> = modules
        .iter()
        .map(|module| leaf_name(root, &module.path))
        .collect();
    let mut counts: HashMap<String, usize> = HashMap::new();
    for leaf in &leaves {
        *counts.entry(leaf.clone()).or_insert(0) += 1;
    }
    for (module, leaf) in modules.iter_mut().zip(leaves) {
        if module.name.is_empty() {
            if counts[&leaf] > 1 {
                let relative = relative_slash(root, &module.path);
                module.name = if relative.is_empty() { leaf } else { relative };
            } else {
                module.name = leaf;
            }
        }
    }
}

fn leaf_name(root: &Path, path: &Path) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| relative_slash(root, path))
}

fn group_sources(root: &Path, modules: &[JvmModule], sources: &[PathBuf]) -> Vec<JvmPackage> {
    let mut files = Vec::new();
    for path in sources {
        files.push(file_from_path(path));
    }
    files.sort_by(|left, right| left.path.cmp(&right.path));
    let mut grouped: HashMap<(Option<String>, String), Vec<JvmFile>> = HashMap::new();
    let mut directories: HashMap<(Option<String>, String), PathBuf> = HashMap::new();
    for file in files {
        let module_name = module_for_file(&file.path, modules).map(|module| module.name.clone());
        let package_name = if file.unreadable {
            String::new()
        } else {
            fs::read(&file.path)
                .ok()
                .and_then(|bytes| String::from_utf8(bytes).ok())
                .and_then(|text| package_name_from(&text))
                .unwrap_or_default()
        };
        let key = (module_name, package_name);
        directories
            .entry(key.clone())
            .or_insert_with(|| file.path.parent().unwrap_or(&file.path).to_path_buf());
        grouped.entry(key).or_default().push(file);
    }
    let mut packages: Vec<JvmPackage> = grouped
        .into_iter()
        .map(|((module_name, name), files)| JvmPackage {
            directory: directories
                .remove(&(module_name.clone(), name.clone()))
                .unwrap_or_else(|| root.to_path_buf()),
            name,
            module_name,
            files,
        })
        .collect();
    packages.sort_by(|left, right| {
        left.module_name
            .cmp(&right.module_name)
            .then(left.name.cmp(&right.name))
            .then(left.directory.cmp(&right.directory))
    });
    packages
}

fn file_from_path(path: &Path) -> JvmFile {
    let language = language_for(path);
    let test = is_test_file(path);
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(_) => {
            return JvmFile {
                path: path.to_path_buf(),
                language,
                test,
                unreadable: true,
                imports: Vec::new(),
                symbols: Vec::new(),
            };
        }
    };
    let Ok(text) = String::from_utf8(bytes) else {
        return JvmFile {
            path: path.to_path_buf(),
            language,
            test,
            unreadable: true,
            imports: Vec::new(),
            symbols: Vec::new(),
        };
    };
    let (imports, symbols) = parse_jvm_source(&text, language);
    JvmFile {
        path: path.to_path_buf(),
        language,
        test,
        unreadable: false,
        imports,
        symbols,
    }
}

fn module_for_file<'a>(path: &Path, modules: &'a [JvmModule]) -> Option<&'a JvmModule> {
    let mut best: Option<(usize, &'a JvmModule)> = None;
    for module in modules {
        if path.starts_with(&module.path) {
            let len = module.path.components().count();
            if best.map(|(current, _)| len > current).unwrap_or(true) {
                best = Some((len, module));
            }
        }
    }
    best.map(|(_, module)| module)
}

fn package_name_from(source: &str) -> Option<String> {
    let source = source.strip_prefix('\u{feff}').unwrap_or(source);
    let stripped = strip_jvm_comments(source);
    for line in stripped.lines() {
        let trimmed = line.trim();
        let Some(rest) = trimmed.strip_prefix("package ") else {
            continue;
        };
        let name = rest
            .trim()
            .trim_end_matches(';')
            .split_whitespace()
            .next()?;
        if name.is_empty() {
            return None;
        }
        return Some(name.to_owned());
    }
    None
}

fn walk_jvm(
    directory: &Path,
    canonical_root: &Path,
    seen: &mut HashSet<PathBuf>,
    found: &mut Found,
) -> Result<(), CargoDiscoveryError> {
    let Some(canonical) = confined_jvm_path(directory, canonical_root) else {
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
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with('.') || skipped_directory(&name) {
            continue;
        }
        let path = entry.path();
        let file_type =
            entry
                .file_type()
                .map_err(|source| CargoDiscoveryError::RepositoryPath {
                    path: path.clone(),
                    source,
                })?;
        if file_type.is_dir() {
            walk_jvm(&path, canonical_root, seen, found)?;
            continue;
        }
        if !file_type.is_file() || confined_jvm_path(&path, canonical_root).is_none() {
            continue;
        }
        if is_marker_name(&name) {
            found.markers.push(path.clone());
        }
        if name == "settings.gradle" || name == "settings.gradle.kts" {
            found.settings.push(path.clone());
        }
        if name == "pom.xml" {
            found.poms.push(path.clone());
        }
        if is_source_name(&name) {
            found.sources.push(path);
        }
    }
    Ok(())
}

fn confined_jvm_path(path: &Path, root: &Path) -> Option<PathBuf> {
    match confined_canonical(path, root) {
        Ok(canonical) => Some(canonical),
        Err(_) => None,
    }
}

fn skipped_directory(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "build" | ".gradle" | "target" | "node_modules" | "vendor" | ".git" | "dist" | "out"
    )
}

fn is_marker_name(name: &str) -> bool {
    matches!(
        name,
        "pom.xml" | "build.gradle" | "build.gradle.kts" | "settings.gradle" | "settings.gradle.kts"
    )
}

fn is_source_name(name: &str) -> bool {
    if is_marker_name(name) {
        return false;
    }
    matches!(
        extension_lower(name).as_deref(),
        Some("java" | "kt" | "kts")
    )
}

fn extension_lower(name: &str) -> Option<String> {
    name.rsplit_once('.')
        .map(|(_, extension)| extension.to_ascii_lowercase())
}

fn language_for(path: &Path) -> JvmLanguage {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("");
    if extension_lower(name).as_deref() == Some("java") {
        JvmLanguage::Java
    } else {
        JvmLanguage::Kotlin
    }
}

fn is_test_file(path: &Path) -> bool {
    let components: Vec<String> = path
        .components()
        .map(|component| component.as_os_str().to_string_lossy().into_owned())
        .collect();
    if components
        .windows(2)
        .any(|pair| pair[0] == "src" && pair[1] == "test")
    {
        return true;
    }
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("");
    name.ends_with("Test.java") || name.ends_with("Test.kt") || name.ends_with("Test.kts")
}

fn same_dir(left: &Path, right: &Path) -> bool {
    if left == right {
        return true;
    }
    match (left.canonicalize(), right.canonicalize()) {
        (Ok(left), Ok(right)) => left == right,
        _ => false,
    }
}

fn safe_join(base: &Path, relative: &str) -> Option<PathBuf> {
    if relative.is_empty() {
        return None;
    }
    let mut path = base.to_path_buf();
    for segment in relative.split(['/', '\\']) {
        if segment.is_empty() || segment == "." {
            continue;
        }
        if segment == ".." {
            return None;
        }
        path.push(segment);
    }
    Some(path)
}

fn include_to_relative(spec: &str) -> Option<String> {
    let spec = spec.trim().trim_start_matches(':');
    if spec.is_empty() {
        return None;
    }
    let relative = spec.replace(':', "/");
    if relative
        .split('/')
        .any(|segment| segment.is_empty() || segment == "." || segment == "..")
    {
        return None;
    }
    Some(relative)
}

fn relative_slash(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn gradle_includes(source: &str) -> Vec<String> {
    let stripped = strip_jvm_comments(source);
    let mut includes = Vec::new();
    let mut rest = stripped.as_str();
    while let Some(index) = find_word(rest, "include") {
        let after_word = &rest[index + "include".len()..];
        let after = after_word.trim_start();
        if after.starts_with('(') {
            let consumed = skip_parens(after);
            let block = &after[..consumed];
            includes.extend(quoted_strings(block));
            let ws = after_word.len() - after.len();
            let next = index + "include".len() + ws + consumed;
            rest = rest.get(next..).unwrap_or("");
            continue;
        }
        let line = after.lines().next().unwrap_or("");
        includes.extend(quoted_strings(line));
        if let Some(newline) = rest[index..].find('\n') {
            rest = &rest[index + newline + 1..];
        } else {
            break;
        }
    }
    includes
        .into_iter()
        .filter_map(|spec| include_to_relative(&spec))
        .collect()
}

fn gradle_project_name(source: &str) -> Option<String> {
    let stripped = strip_jvm_comments(source);
    let mut rest = stripped.as_str();
    while let Some(index) = rest.find("rootProject") {
        let before_ok = index == 0
            || rest[..index]
                .chars()
                .next_back()
                .is_none_or(|character| !is_ident_char(character));
        let after = rest[index + "rootProject".len()..].trim_start();
        if before_ok && after.starts_with(".name") {
            let after_name = after[".name".len()..].trim_start();
            if let Some(value) = after_name.strip_prefix('=') {
                if let Some(name) = quoted_strings(value.lines().next().unwrap_or(""))
                    .into_iter()
                    .next()
                {
                    if !name.is_empty() {
                        return Some(name);
                    }
                }
            }
        }
        rest = &rest[index + "rootProject".len()..];
    }
    None
}

fn maven_module_paths(source: &str) -> Vec<String> {
    let stripped = strip_xml_comments(source);
    let mut modules = Vec::new();
    let mut rest = stripped.as_str();
    while let Some(start) = rest.find("<modules>") {
        let after = &rest[start + "<modules>".len()..];
        let end = after.find("</modules>").unwrap_or(after.len());
        let mut inner = &after[..end];
        while let Some(tag) = inner.find("<module>") {
            let content = &inner[tag + "<module>".len()..];
            let close = content.find("</module>").unwrap_or(content.len());
            let name = content[..close].trim();
            if !name.is_empty() && !name.contains('<') {
                modules.push(name.to_owned());
            }
            inner = if close >= content.len() {
                ""
            } else {
                &content[close..]
            };
        }
        rest = if end >= after.len() {
            ""
        } else {
            &after[end..]
        };
    }
    modules
}

fn maven_artifact_id(source: &str) -> Option<String> {
    let mut text = strip_xml_comments(source);
    for tag in [
        "parent",
        "dependencies",
        "dependencyManagement",
        "build",
        "plugins",
    ] {
        text = remove_xml_element(&text, tag);
    }
    let start = text.find("<artifactId>")? + "<artifactId>".len();
    let rest = &text[start..];
    let end = rest.find("</artifactId>")?;
    let name = rest[..end].trim();
    if name.is_empty() || name.contains('<') {
        None
    } else {
        Some(name.to_owned())
    }
}

fn remove_xml_element(source: &str, tag: &str) -> String {
    let open = format!("<{tag}");
    let close = format!("</{tag}>");
    let mut out = String::new();
    let mut rest = source;
    while let Some(start) = rest.find(&open) {
        let after = &rest[start + open.len()..];
        let boundary = after.chars().next().is_none_or(|character| {
            character == '>' || character.is_whitespace() || character == '/'
        });
        if !boundary {
            out.push_str(&rest[..start + open.len()]);
            rest = &rest[start + open.len()..];
            continue;
        }
        out.push_str(&rest[..start]);
        if let Some(end) = rest[start..].find(&close) {
            rest = &rest[start + end + close.len()..];
        } else {
            rest = "";
            break;
        }
    }
    out.push_str(rest);
    out
}

fn strip_xml_comments(source: &str) -> String {
    let mut out = String::new();
    let mut rest = source;
    while let Some(start) = rest.find("<!--") {
        out.push_str(&rest[..start]);
        if let Some(end) = rest[start + 4..].find("-->") {
            rest = &rest[start + 4 + end + 3..];
        } else {
            rest = "";
            break;
        }
    }
    out.push_str(rest);
    out
}

fn normalize_import_path(path: &str) -> String {
    let trimmed = path.trim().trim_end_matches(';');
    let trimmed = trimmed.strip_suffix(".*").unwrap_or(trimmed);
    trimmed.trim_end_matches('.').to_owned()
}

fn import_matches_package(import_path: &str, package_name: &str) -> bool {
    import_path == package_name
        || import_path
            .strip_prefix(package_name)
            .is_some_and(|rest| rest.starts_with('.'))
}

fn parse_imports(source: &str) -> Vec<JvmImport> {
    let mut imports = Vec::new();
    for (index, line) in source.lines().enumerate() {
        let trimmed = line.trim().trim_end_matches(';').trim();
        let Some(rest) = trimmed.strip_prefix("import ") else {
            continue;
        };
        let rest = rest.trim();
        if rest.is_empty() {
            continue;
        }
        let (static_import, rest) = if let Some(after) = rest.strip_prefix("static ") {
            (true, after.trim())
        } else {
            (false, rest)
        };
        let rest = rest.split(" as ").next().unwrap_or(rest).trim();
        let path = rest
            .split_whitespace()
            .next()
            .unwrap_or("")
            .trim_end_matches(';');
        if path.is_empty()
            || !path.chars().all(|character| {
                character.is_ascii_alphanumeric()
                    || character == '_'
                    || character == '.'
                    || character == '*'
            })
        {
            continue;
        }
        imports.push(JvmImport {
            line: index + 1,
            path: path.to_owned(),
            static_import,
        });
    }
    imports
}

fn parse_symbols(source: &str, language: JvmLanguage) -> Vec<JvmSymbol> {
    let mut symbols = Vec::new();
    for (index, line) in source.lines().enumerate() {
        if let Some(symbol) = parse_symbol_line(line, index + 1, language) {
            symbols.push(symbol);
        }
    }
    symbols
}

fn parse_symbol_line(line: &str, line_no: usize, language: JvmLanguage) -> Option<JvmSymbol> {
    let head = declaration_head(line);
    let (kind, name) = if let Some(rest) = head.strip_prefix("enum class ") {
        (JvmSymbolKind::Enum, ident(rest)?)
    } else if let Some(rest) = head.strip_prefix("enum ") {
        (JvmSymbolKind::Enum, ident(rest)?)
    } else if let Some(rest) = head.strip_prefix("fun interface ") {
        (JvmSymbolKind::Interface, ident(rest)?)
    } else if let Some(rest) = head.strip_prefix("interface ") {
        (JvmSymbolKind::Interface, ident(rest)?)
    } else if let Some(rest) = head.strip_prefix("class ") {
        (JvmSymbolKind::Class, ident(rest)?)
    } else if language == JvmLanguage::Kotlin {
        if let Some(rest) = head.strip_prefix("object ") {
            (JvmSymbolKind::Object, ident(rest)?)
        } else if let Some(rest) = head.strip_prefix("fun ") {
            (JvmSymbolKind::Fun, fun_name(rest)?)
        } else {
            return None;
        }
    } else {
        return None;
    };
    Some(JvmSymbol {
        name,
        kind,
        line: line_no,
    })
}

const MODIFIERS: &[&str] = &[
    "public",
    "private",
    "protected",
    "internal",
    "abstract",
    "final",
    "open",
    "sealed",
    "data",
    "inner",
    "value",
    "annotation",
    "static",
    "inline",
    "suspend",
    "override",
    "tailrec",
    "operator",
    "infix",
    "external",
    "expect",
    "actual",
    "companion",
    "native",
    "synchronized",
    "strictfp",
    "default",
    "transitive",
    "non-sealed",
    "const",
    "lateinit",
    "crossinline",
    "noinline",
];

fn declaration_head(line: &str) -> &str {
    let mut current = line.trim();
    loop {
        let next = strip_leading_annotation_or_modifier(current);
        if next.len() == current.len() {
            return current;
        }
        current = next.trim_start();
    }
}

fn strip_leading_annotation_or_modifier(line: &str) -> &str {
    if let Some(rest) = strip_annotation(line) {
        return rest;
    }
    for modifier in MODIFIERS {
        if let Some(rest) = line.strip_prefix(modifier) {
            if rest.is_empty() || rest.starts_with(char::is_whitespace) {
                return rest;
            }
        }
    }
    line
}

fn strip_annotation(line: &str) -> Option<&str> {
    if !line.starts_with('@') {
        return None;
    }
    let mut index = 1usize;
    while index < line.len() {
        let character = line[index..].chars().next()?;
        if character.is_ascii_alphanumeric()
            || character == '_'
            || character == '.'
            || character == ':'
        {
            index += character.len_utf8();
        } else {
            break;
        }
    }
    let rest = &line[index..];
    if rest.starts_with('(') {
        Some(&rest[skip_parens(rest)..])
    } else {
        Some(rest)
    }
}

fn ident(source: &str) -> Option<String> {
    let source = source.trim_start();
    let mut name = String::new();
    for character in source.chars() {
        if character.is_ascii_alphanumeric() || character == '_' {
            name.push(character);
        } else {
            break;
        }
    }
    if name.is_empty()
        || name
            .chars()
            .next()
            .is_some_and(|character| character.is_ascii_digit())
    {
        return None;
    }
    Some(name)
}

fn fun_name(source: &str) -> Option<String> {
    let mut rest = source.trim_start();
    if rest.starts_with('<') {
        rest = skip_generic(rest)?.trim_start();
    }
    let head = rest.split('(').next()?.trim();
    if head.is_empty() {
        return None;
    }
    let head = head.trim_end_matches('?');
    let segment = head.split('.').next_back()?.trim();
    ident(segment)
}

fn skip_generic(source: &str) -> Option<&str> {
    let mut depth = 0i32;
    for (offset, character) in source.char_indices() {
        if character == '<' {
            depth += 1;
        } else if character == '>' {
            depth -= 1;
            if depth == 0 {
                return Some(&source[offset + character.len_utf8()..]);
            }
        }
    }
    None
}

fn skip_parens(source: &str) -> usize {
    skip_balanced(source, '(', ')')
}

fn skip_balanced(source: &str, open: char, close: char) -> usize {
    let mut depth = 0i32;
    for (offset, character) in source.char_indices() {
        if character == open {
            depth += 1;
        } else if character == close {
            depth -= 1;
            if depth == 0 {
                return offset + character.len_utf8();
            }
        }
    }
    source.len()
}

fn find_word(source: &str, word: &str) -> Option<usize> {
    let mut start = 0usize;
    while let Some(relative) = source[start..].find(word) {
        let index = start + relative;
        let before_ok = source[..index]
            .chars()
            .next_back()
            .is_none_or(|character| !is_ident_char(character));
        let after_ok = source[index + word.len()..]
            .chars()
            .next()
            .is_none_or(|character| !is_ident_char(character));
        if before_ok && after_ok {
            return Some(index);
        }
        start = index + word.len();
    }
    None
}

fn is_ident_char(character: char) -> bool {
    character.is_ascii_alphanumeric() || character == '_'
}

fn quoted_strings(source: &str) -> Vec<String> {
    let chars: Vec<char> = source.chars().collect();
    let mut index = 0usize;
    let mut values = Vec::new();
    while index < chars.len() {
        if chars[index] == '"' || chars[index] == '\'' {
            let quote = chars[index];
            index += 1;
            let mut current = String::new();
            while index < chars.len() && chars[index] != quote {
                if chars[index] == '\\' && index + 1 < chars.len() {
                    current.push(chars[index + 1]);
                    index += 2;
                    continue;
                }
                current.push(chars[index]);
                index += 1;
            }
            if index < chars.len() {
                index += 1;
            }
            if !current.is_empty() {
                values.push(current);
            }
            continue;
        }
        index += 1;
    }
    values
}

fn strip_jvm_comments(source: &str) -> String {
    let mut out = String::with_capacity(source.len());
    let chars: Vec<char> = source.chars().collect();
    let mut index = 0usize;
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
        if chars[index] == '"'
            && index + 2 < chars.len()
            && chars[index + 1] == '"'
            && chars[index + 2] == '"'
        {
            out.push('"');
            out.push('"');
            out.push('"');
            index += 3;
            while index < chars.len() {
                if index + 2 < chars.len()
                    && chars[index] == '"'
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
        if chars[index] == '"' {
            out.push('"');
            index += 1;
            while index < chars.len() {
                if chars[index] == '\\' && index + 1 < chars.len() {
                    out.push(chars[index]);
                    out.push(chars[index + 1]);
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
                if chars[index] == '\\' && index + 1 < chars.len() {
                    out.push(chars[index]);
                    out.push(chars[index + 1]);
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

#[cfg(test)]
mod tests {
    use super::{discover_jvm, parse_jvm_source, JvmLanguage, JvmModuleKind, JvmSymbolKind};
    use crate::extract::extract_cargo_map;
    use crate::facts::{Connection, FactBlock};
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn fixture_root() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/jvm-sample")
    }

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(label: &str) -> Self {
            let unique = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock")
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "lightwell-jvm-{label}-{}-{unique}",
                std::process::id()
            ));
            fs::create_dir_all(&path).expect("temp dir");
            Self(path)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn module_block<'a>(
        blocks: &'a [FactBlock],
        language: &str,
        module_path: &str,
    ) -> Option<&'a crate::facts::ModuleBlock> {
        blocks.iter().find_map(|block| match block {
            FactBlock::Module(module)
                if module.language == language && module.module_path == module_path =>
            {
                Some(module)
            }
            _ => None,
        })
    }

    #[test]
    fn jvm_parse_imports_and_symbols() {
        let java = "package com.example.app;\n// 日本語 café\nimport static com.example.lib.Util.greet;\nclass App {}\n";
        let (imports, symbols) = parse_jvm_source(java, JvmLanguage::Java);
        assert_eq!(imports.len(), 1);
        assert!(imports[0].static_import);
        assert_eq!(imports[0].path, "com.example.lib.Util.greet");
        assert_eq!(
            imports[0].statement(),
            "import static com.example.lib.Util.greet;"
        );
        assert_eq!(symbols.len(), 1);
        assert_eq!(symbols[0].name, "App");
        assert_eq!(symbols[0].line, 4);
        assert_eq!(symbols[0].kind, JvmSymbolKind::Class);

        let commented = "package p;\n/*\nclass Hidden {\n}\n*/\npublic class Shown {}\n";
        let (_, symbols) = parse_jvm_source(commented, JvmLanguage::Java);
        assert_eq!(symbols.len(), 1);
        assert_eq!(symbols[0].name, "Shown");
        assert_eq!(symbols[0].line, 6);

        let kotlin =
            "fun <T> identity(value: T) = value\nfun Greeter.extension() {}\nobject Holder\n";
        let (_, symbols) = parse_jvm_source(kotlin, JvmLanguage::Kotlin);
        assert_eq!(
            symbols
                .iter()
                .map(|symbol| (symbol.name.as_str(), symbol.kind))
                .collect::<Vec<_>>(),
            vec![
                ("identity", JvmSymbolKind::Fun),
                ("extension", JvmSymbolKind::Fun),
                ("Holder", JvmSymbolKind::Object),
            ]
        );
    }

    #[test]
    fn jvm_fixture_lists_modules_packages_imports_and_symbols() {
        let workspace = discover_jvm(&fixture_root()).expect("jvm fixture");
        assert_eq!(
            workspace
                .modules
                .iter()
                .map(|module| (module.name.as_str(), module.kind))
                .collect::<Vec<_>>(),
            vec![
                ("app", JvmModuleKind::Gradle),
                ("lib", JvmModuleKind::Maven)
            ]
        );
        let app = workspace
            .packages
            .iter()
            .find(|package| package.name == "com.example.app")
            .expect("app package");
        assert_eq!(app.module_name.as_deref(), Some("app"));
        let app_java = app
            .files
            .iter()
            .find(|file| file.path.ends_with("App.java"))
            .expect("App.java");
        assert_eq!(app_java.language, JvmLanguage::Java);
        assert!(!app_java.test);
        assert!(app_java
            .imports
            .iter()
            .any(|import| { !import.static_import && import.path == "com.example.lib.Util" }));
        assert!(app_java
            .imports
            .iter()
            .any(|import| { import.static_import && import.path == "com.example.lib.Util.greet" }));
        assert_eq!(app_java.symbols.len(), 1);
        assert_eq!(app_java.symbols[0].name, "App");
        assert_eq!(app_java.symbols[0].kind, JvmSymbolKind::Class);
        assert_eq!(app_java.symbols[0].line, 10);
        let greeter = app
            .files
            .iter()
            .find(|file| file.path.ends_with("Greeter.kt"))
            .expect("Greeter.kt");
        assert_eq!(greeter.language, JvmLanguage::Kotlin);
        assert!(!greeter.test);
        assert!(greeter.symbols.iter().any(|symbol| symbol.name == "Greeter"
            && symbol.kind == JvmSymbolKind::Object
            && symbol.line == 8));
        assert!(greeter.symbols.iter().any(|symbol| {
            symbol.name == "hello" && symbol.kind == JvmSymbolKind::Fun && symbol.line == 9
        }));
        assert!(greeter.symbols.iter().all(|symbol| symbol.name != "hidden"));
        let app_test = app
            .files
            .iter()
            .find(|file| file.path.ends_with("AppTest.java"))
            .expect("AppTest.java");
        assert!(app_test.test);
        let helper = app
            .files
            .iter()
            .find(|file| file.path.ends_with("Helper.java"))
            .expect("Helper.java");
        assert!(helper.test);
        let lib = workspace
            .packages
            .iter()
            .find(|package| package.name == "com.example.lib")
            .expect("lib package");
        assert_eq!(lib.module_name.as_deref(), Some("lib"));
        let util = &lib.files[0];
        assert_eq!(util.symbols.len(), 1);
        assert_eq!(util.symbols[0].name, "Util");
        assert_eq!(util.symbols[0].line, 3);
        assert!(workspace.packages.iter().all(|package| {
            package.files.iter().all(|file| {
                !file
                    .path
                    .components()
                    .any(|component| component.as_os_str() == "build")
            })
        }));
        assert!(workspace.packages.iter().all(|package| {
            package.files.iter().all(|file| {
                file.path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_none_or(|name| name != "build.gradle.kts" && name != "settings.gradle.kts")
            })
        }));
    }

    #[test]
    fn jvm_modules_merge_into_workspace_maps() {
        let root = fixture_root();
        let map = extract_cargo_map(&root, Some("JVM Sample")).expect("extract");
        assert!(map.blocks.iter().any(|block| matches!(
            block,
            FactBlock::Workspace(workspace) if workspace.base.source_path.as_deref() == Some("pom.xml")
        )));
        let app = module_block(&map.blocks, "jvm", "app").expect("app module");
        assert_eq!(app.base.id, "module:jvm:app");
        assert_eq!(app.cfg_attributes, ["gradle"]);
        assert_eq!(
            app.base.source_path.as_deref(),
            Some("app/build.gradle.kts")
        );
        let lib = module_block(&map.blocks, "jvm", "lib").expect("lib module");
        assert_eq!(lib.cfg_attributes, ["maven"]);
        assert_eq!(lib.base.source_path.as_deref(), Some("lib/pom.xml"));
        let app_package = module_block(&map.blocks, "jvm", "com.example.app").expect("app package");
        assert_eq!(app_package.base.id, "module:jvm:app:com-example-app");
        assert_eq!(
            app_package.base.parent_id.as_deref(),
            Some("module:jvm:app")
        );
        let lib_package = module_block(&map.blocks, "jvm", "com.example.lib").expect("lib package");
        assert_eq!(lib_package.base.id, "module:jvm:lib:com-example-lib");
        let app_file = module_block(&map.blocks, "java", "com.example.app/App").expect("App file");
        assert_eq!(
            app_file.base.id,
            "module:jvm:app-src-main-java-com-example-app-app-java"
        );
        assert_eq!(
            app_file.base.parent_id.as_deref(),
            Some("module:jvm:app:com-example-app")
        );
        let app_class =
            module_block(&map.blocks, "java", "com.example.app.App").expect("App class");
        assert_eq!(app_class.cfg_attributes, ["class"]);
        assert_eq!(
            app_class.base.id,
            "module:jvm:app-src-main-java-com-example-app-app-java:app:class"
        );
        let hello = module_block(&map.blocks, "kotlin", "com.example.app.hello").expect("hello");
        assert_eq!(hello.cfg_attributes, ["fun"]);
        assert_eq!(
            hello.base.id,
            "module:jvm:app-src-main-kotlin-com-example-app-greeter-kt:hello:fun"
        );
        let greeter =
            module_block(&map.blocks, "kotlin", "com.example.app.Greeter").expect("Greeter");
        assert_eq!(greeter.cfg_attributes, ["object"]);
        let app_test = map.blocks.iter().find_map(|block| match block {
            FactBlock::Module(module) if module.base.id.ends_with("apptest-java:test") => {
                Some(module)
            }
            _ => None,
        });
        assert!(
            app_test.is_some(),
            "AppTest.java should be a test file block"
        );
        let helper = map.blocks.iter().find_map(|block| match block {
            FactBlock::Module(module) if module.base.id.ends_with("helper-java:test") => {
                Some(module)
            }
            _ => None,
        });
        assert!(
            helper.is_some(),
            "Helper.java under src/test should be a test file block"
        );
        let app_edges: Vec<_> = map
            .connections
            .iter()
            .filter(|connection| {
                matches!(
                    connection,
                    Connection::DependsOn { source, .. } if source == "module:jvm:app-src-main-java-com-example-app-app-java"
                )
            })
            .collect();
        assert_eq!(app_edges.len(), 1);
        assert!(matches!(
            app_edges[0],
            Connection::DependsOn { target, .. } if target == "module:jvm:lib:com-example-lib"
        ));
        assert!(map.blocks.iter().all(|block| match block {
            FactBlock::Module(module) => module.base.label != "Skipped",
            _ => true,
        }));
    }

    #[test]
    fn jvm_missing_build_files_yield_an_empty_workspace() {
        let root = TempDir::new("plain");
        fs::create_dir_all(root.0.join("src")).expect("src");
        fs::write(root.0.join("src/App.java"), "public class App {}\n").expect("java");
        let workspace = discover_jvm(&root.0).expect("discover");
        assert!(workspace.modules.is_empty());
        assert!(workspace.packages.is_empty());
        let error = extract_cargo_map(&root.0, None)
            .expect_err("java without a build file is not a project")
            .to_string();
        assert!(
            error.contains("Cargo.toml"),
            "opening a stray java file should still report a missing project manifest"
        );
    }

    #[test]
    fn jvm_groovy_include_line_discovers_a_module() {
        let root = TempDir::new("groovy");
        fs::write(root.0.join("settings.gradle"), "include ':leaf'\n").expect("settings");
        fs::create_dir_all(root.0.join("leaf")).expect("leaf");
        fs::write(root.0.join("leaf/build.gradle"), "// leaf\n").expect("build");
        fs::create_dir_all(root.0.join("leaf/src/main/java/com/example")).expect("src");
        fs::write(
            root.0.join("leaf/src/main/java/com/example/Leaf.java"),
            "package com.example;\npublic class Leaf {}\n",
        )
        .expect("source");
        let workspace = discover_jvm(&root.0).expect("discover");
        assert_eq!(workspace.modules.len(), 1);
        assert_eq!(workspace.modules[0].name, "leaf");
        assert_eq!(workspace.modules[0].kind, JvmModuleKind::Gradle);
        assert!(workspace
            .packages
            .iter()
            .any(|package| package.name == "com.example"));
    }

    #[test]
    fn jvm_single_root_gradle_reads_kotlin_script() {
        let root = TempDir::new("solo");
        fs::write(
            root.0.join("settings.gradle.kts"),
            "// rootProject.name = \"nope\"\nrootProject.name = \"solo\"\n// include(\":skipped\")\n",
        )
        .expect("settings");
        fs::write(root.0.join("build.gradle.kts"), "// solo\n").expect("build");
        fs::create_dir_all(root.0.join("src/main/kotlin/com/example")).expect("src");
        fs::write(
            root.0.join("src/main/kotlin/com/example/Note.kts"),
            "/*\npackage com.evil\n*/\npackage com.example\n\nfun setup() {}\n",
        )
        .expect("script");
        fs::create_dir_all(root.0.join("build")).expect("build dir");
        fs::write(
            root.0.join("build/Skipped.kt"),
            "package skipped\nclass Skipped\n",
        )
        .expect("skipped");
        let workspace = discover_jvm(&root.0).expect("discover");
        assert_eq!(workspace.modules.len(), 1);
        assert_eq!(workspace.modules[0].name, "solo");
        assert_eq!(workspace.modules[0].kind, JvmModuleKind::Gradle);
        assert_eq!(workspace.packages.len(), 1);
        assert_eq!(workspace.packages[0].name, "com.example");
        assert_eq!(workspace.packages[0].files.len(), 1);
        assert_eq!(workspace.packages[0].files[0].language, JvmLanguage::Kotlin);
        assert_eq!(workspace.packages[0].files[0].symbols[0].name, "setup");
        assert_eq!(workspace.packages[0].files[0].symbols[0].line, 6);
        let map = extract_cargo_map(&root.0, Some("Solo")).expect("extract");
        let module = module_block(&map.blocks, "jvm", "solo").expect("solo module");
        assert_eq!(module.base.source_path.as_deref(), Some("build.gradle.kts"));
    }

    #[test]
    fn jvm_single_root_maven_uses_project_artifact_id() {
        let root = TempDir::new("demo");
        fs::write(
            root.0.join("pom.xml"),
            r#"<project>
  <parent>
    <artifactId>parent-art</artifactId>
  </parent>
  <artifactId>demo</artifactId>
  <dependencies>
    <dependency><artifactId>jcl</artifactId></dependency>
  </dependencies>
  <!-- <module>skipped</module> -->
</project>
"#,
        )
        .expect("pom");
        fs::create_dir_all(root.0.join("src/main/java/com/example")).expect("src");
        fs::write(
            root.0.join("src/main/java/com/example/Demo.java"),
            "package com.example;\npublic class Demo {}\n",
        )
        .expect("source");
        let workspace = discover_jvm(&root.0).expect("discover");
        assert_eq!(workspace.modules.len(), 1);
        assert_eq!(workspace.modules[0].name, "demo");
        assert_eq!(workspace.modules[0].kind, JvmModuleKind::Maven);
        let map = extract_cargo_map(&root.0, Some("Demo")).expect("extract");
        let module = map.blocks.iter().find_map(|block| match block {
            FactBlock::Module(module)
                if module.language == "jvm" && module.cfg_attributes == ["maven"] =>
            {
                Some(module)
            }
            _ => None,
        });
        assert_eq!(module.expect("maven module").base.label, "demo");
    }

    #[test]
    fn jvm_skips_generated_directories() {
        let root = TempDir::new("skip");
        fs::write(
            root.0.join("pom.xml"),
            "<project><artifactId>skip</artifactId></project>\n",
        )
        .expect("pom");
        fs::create_dir_all(root.0.join("src/main/java/com/example")).expect("src");
        fs::write(
            root.0.join("src/main/java/com/example/Kept.java"),
            "package com.example;\npublic class Kept {}\n",
        )
        .expect("kept");
        for name in [
            "build",
            "target",
            "node_modules",
            "vendor",
            "dist",
            "out",
            ".gradle",
            ".git",
        ] {
            let dir = root.0.join(name);
            fs::create_dir_all(&dir).expect("skipped dir");
            fs::write(
                dir.join("Hidden.java"),
                format!("public class Hidden{name} {{}}\n"),
            )
            .expect("hidden");
        }
        let workspace = discover_jvm(&root.0).expect("discover");
        let names: Vec<_> = workspace
            .packages
            .iter()
            .flat_map(|package| package.files.iter())
            .flat_map(|file| file.symbols.iter().map(|symbol| symbol.name.as_str()))
            .collect();
        assert_eq!(names, vec!["Kept"]);
    }

    #[test]
    fn jvm_depends_on_uses_longest_package_prefix() {
        let root = TempDir::new("prefix");
        fs::write(
            root.0.join("pom.xml"),
            "<project><artifactId>prefix</artifactId></project>\n",
        )
        .expect("pom");
        let java = root.0.join("src/main/java/com/example");
        fs::create_dir_all(java.join("lib")).expect("lib");
        fs::create_dir_all(java.join("app")).expect("app");
        fs::write(
            java.join("Root.java"),
            "package com.example;\npublic class Root {}\n",
        )
        .expect("root type");
        fs::write(
            java.join("lib/Util.java"),
            "package com.example.lib;\npublic class Util {}\n",
        )
        .expect("util");
        fs::write(
            java.join("app/App.java"),
            "package com.example.app;\nimport com.example.lib.Util;\npublic class App {}\n",
        )
        .expect("app");
        fs::write(
            java.join("app/Other.java"),
            "package com.example.app;\nimport com.example.libutil.Foo;\npublic class Other {}\n",
        )
        .expect("other");
        fs::write(
            java.join("app/Wild.java"),
            "package com.example.app;\nimport com.example.lib.*;\npublic class Wild {}\n",
        )
        .expect("wild");
        let map = extract_cargo_map(&root.0, Some("Prefix")).expect("extract");
        let target_of = |label: &str| -> Vec<String> {
            let source = map.blocks.iter().find_map(|block| match block {
                FactBlock::Module(module)
                    if module.language == "java"
                        && module.base.label == label
                        && module
                            .cfg_attributes
                            .iter()
                            .any(|item| item.starts_with("import ")) =>
                {
                    Some(module.base.id.clone())
                }
                _ => None,
            });
            let Some(source) = source else {
                return Vec::new();
            };
            map.connections
                .iter()
                .filter_map(|connection| match connection {
                    Connection::DependsOn {
                        source: edge_source,
                        target,
                        ..
                    } if edge_source == &source => Some(target.clone()),
                    _ => None,
                })
                .collect()
        };
        assert_eq!(
            target_of("App"),
            vec!["module:jvm:prefix:com-example-lib".to_owned()]
        );
        assert_eq!(
            target_of("Wild"),
            vec!["module:jvm:prefix:com-example-lib".to_owned()]
        );
        assert_eq!(
            target_of("Other"),
            vec!["module:jvm:prefix:com-example".to_owned()]
        );
    }

    #[test]
    fn jvm_invalid_utf8_is_unreadable_and_still_listed() {
        let root = TempDir::new("binary");
        fs::write(
            root.0.join("pom.xml"),
            "<project><artifactId>binary</artifactId></project>\n",
        )
        .expect("pom");
        fs::create_dir_all(root.0.join("src/main/java")).expect("src");
        fs::write(root.0.join("src/main/java/Broken.java"), [0xff, 0xfe, 0x00]).expect("binary");
        let workspace = discover_jvm(&root.0).expect("discover");
        let file = workspace
            .packages
            .iter()
            .flat_map(|package| package.files.iter())
            .find(|file| file.path.ends_with("Broken.java"))
            .expect("broken file");
        assert!(file.unreadable);
        assert!(file.imports.is_empty());
        assert!(file.symbols.is_empty());
        assert_eq!(file.language, JvmLanguage::Java);
    }
}
