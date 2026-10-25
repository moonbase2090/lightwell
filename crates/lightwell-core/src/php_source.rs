use crate::metadata::CargoDiscoveryError;
use crate::path_confinement::{confined_canonical, is_confined_to, opened_root};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct PhpPackage {
    pub composer_name: String,
    pub import_path: String,
    pub namespace: String,
    pub name: String,
    pub directory: PathBuf,
    pub files: Vec<PhpFile>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct PhpFile {
    pub path: PathBuf,
    pub unreadable: bool,
    pub namespace: String,
    pub imports: Vec<PhpImport>,
    pub symbols: Vec<PhpSymbol>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct PhpImport {
    pub line: usize,
    pub qualified: String,
    pub alias: Option<String>,
    pub statement: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum PhpSymbolKind {
    Class,
    Interface,
    Trait,
    Enum,
    Function,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct PhpSymbol {
    pub name: String,
    pub kind: PhpSymbolKind,
    pub line: usize,
}

impl PhpSymbol {
    pub(crate) fn outline_label(&self) -> &'static str {
        match self.kind {
            PhpSymbolKind::Class => "class",
            PhpSymbolKind::Interface => "interface",
            PhpSymbolKind::Trait => "trait",
            PhpSymbolKind::Enum => "enum",
            PhpSymbolKind::Function => "function",
        }
    }
}

/// Discover PHP files when `composer.json` is present. Returns an empty list otherwise.
/// Skips `vendor/`, `.git`, `node_modules`, `target`, and `dist`.
pub(crate) fn discover_php_packages(
    repository_path: &Path,
) -> Result<Vec<PhpPackage>, CargoDiscoveryError> {
    let composer_path = repository_path.join("composer.json");
    if !composer_path.is_file() {
        return Ok(Vec::new());
    }
    let canonical_root = opened_root(repository_path)?;
    let project = read_composer(repository_path, &composer_path)?;
    let mut files = Vec::new();
    let mut seen = HashSet::new();
    walk_php_files(repository_path, &canonical_root, &mut seen, &mut files)?;
    files.sort();
    let mut grouped: HashMap<String, Vec<PhpFile>> = HashMap::new();
    for path in files {
        let php_file = load_php_file(repository_path, &path, &project)?;
        grouped
            .entry(php_file.namespace.clone())
            .or_default()
            .push(php_file);
    }
    let mut packages = grouped
        .into_iter()
        .map(|(namespace, mut php_files)| {
            php_files.sort_by(|left, right| left.path.cmp(&right.path));
            let import_path = if namespace.is_empty() {
                project.name.clone()
            } else {
                format!("{}/{}", project.name, namespace.replace('\\', "/"))
            };
            let name = short_php_name(&namespace, &project.name);
            let directory = php_files
                .first()
                .and_then(|file| file.path.parent().map(Path::to_path_buf))
                .unwrap_or_else(|| repository_path.to_path_buf());
            PhpPackage {
                composer_name: project.name.clone(),
                import_path,
                namespace,
                name,
                directory,
                files: php_files,
            }
        })
        .collect::<Vec<_>>();
    packages.sort_by(|left, right| left.import_path.cmp(&right.import_path));
    Ok(packages)
}

pub(crate) fn parse_php_source(source: &str) -> (String, Vec<PhpImport>, Vec<PhpSymbol>) {
    let source = source.strip_prefix('\u{feff}').unwrap_or(source);
    let stripped = strip_php_comments_and_strings(source);
    parse_php_code(&stripped)
}

struct ComposerProject {
    name: String,
    laravel: bool,
    psr4: Vec<(String, String)>,
}

fn read_composer(
    root: &Path,
    composer_path: &Path,
) -> Result<ComposerProject, CargoDiscoveryError> {
    let contents = fs::read_to_string(composer_path).map_err(|source| {
        CargoDiscoveryError::RepositoryPath {
            path: composer_path.to_owned(),
            source,
        }
    })?;
    let contents = contents
        .strip_prefix('\u{feff}')
        .unwrap_or(&contents)
        .to_owned();
    let value: Value =
        serde_json::from_str(&contents).map_err(|_| CargoDiscoveryError::RepositoryPath {
            path: composer_path.to_owned(),
            source: io::Error::new(
                io::ErrorKind::InvalidData,
                "composer.json is not valid JSON",
            ),
        })?;
    let name = value
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| directory_name(root));
    let mut psr4 = Vec::new();
    for autoload_key in ["autoload", "autoload-dev"] {
        let Some(map) = value
            .pointer(&format!("/{autoload_key}/psr-4"))
            .and_then(Value::as_object)
        else {
            continue;
        };
        for (prefix, paths) in map {
            let prefix = prefix.trim().trim_matches('\\').to_owned();
            match paths {
                Value::String(path) => push_psr4(&mut psr4, &prefix, path),
                Value::Array(items) => {
                    for item in items {
                        if let Some(path) = item.as_str() {
                            push_psr4(&mut psr4, &prefix, path);
                        }
                    }
                }
                _ => {}
            }
        }
    }
    let illuminate = contents.contains("illuminate/");
    let laravel =
        root.join("artisan").is_file() || root.join("app").join("Http").is_dir() || illuminate;
    if laravel && !psr4_covers_app(&psr4) {
        psr4.push(("App".to_owned(), "app".to_owned()));
    }
    Ok(ComposerProject {
        name,
        laravel,
        psr4,
    })
}

fn push_psr4(psr4: &mut Vec<(String, String)>, prefix: &str, path: &str) {
    let dir = path.trim().trim_matches('/');
    if dir.is_empty() {
        return;
    }
    psr4.push((prefix.to_owned(), dir.replace('\\', "/")));
}

fn psr4_covers_app(psr4: &[(String, String)]) -> bool {
    psr4.iter()
        .any(|(_, dir)| dir == "app" || dir.starts_with("app/"))
}

fn directory_name(root: &Path) -> String {
    root.file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("php")
        .to_owned()
}

fn short_php_name(namespace: &str, composer_name: &str) -> String {
    if namespace.is_empty() {
        composer_name
            .rsplit('/')
            .next()
            .unwrap_or(composer_name)
            .to_owned()
    } else {
        namespace
            .rsplit('\\')
            .next()
            .unwrap_or(namespace)
            .to_owned()
    }
}

fn load_php_file(
    root: &Path,
    path: &Path,
    project: &ComposerProject,
) -> Result<PhpFile, CargoDiscoveryError> {
    let relative = relative_slash(root, path);
    let source = match fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(_) => {
            let namespace = infer_php_namespace(&relative, project);
            return Ok(PhpFile {
                path: path.to_path_buf(),
                unreadable: true,
                namespace,
                imports: Vec::new(),
                symbols: Vec::new(),
            });
        }
    };
    let (declared, imports, symbols) = parse_php_source(&source);
    let namespace = if declared.is_empty() {
        infer_php_namespace(&relative, project)
    } else {
        declared
    };
    Ok(PhpFile {
        path: path.to_path_buf(),
        unreadable: false,
        namespace,
        imports,
        symbols,
    })
}

fn infer_php_namespace(relative: &str, project: &ComposerProject) -> String {
    let mut best: Option<(usize, String)> = None;
    for (prefix, dir) in &project.psr4 {
        let with_slash = format!("{dir}/");
        if !relative.starts_with(&with_slash) {
            continue;
        }
        let rest = &relative[with_slash.len()..];
        let suffix = namespace_from_relative_file(rest);
        let full = join_namespace(prefix, &suffix);
        if best.as_ref().is_none_or(|(len, _)| dir.len() > *len) {
            best = Some((dir.len(), full));
        }
    }
    if let Some((_, namespace)) = best {
        return namespace;
    }
    if project.laravel {
        if let Some(namespace) = laravel_conventional_namespace(relative) {
            return namespace;
        }
    }
    String::new()
}

fn laravel_conventional_namespace(relative: &str) -> Option<String> {
    let file_dir = relative.rsplit_once('/').map(|(dir, _)| dir).unwrap_or("");
    if file_dir == "app/Models" || file_dir.starts_with("app/Models/") {
        let sub = file_dir.trim_start_matches("app/Models").trim_matches('/');
        return Some(join_namespace("App\\Models", &sub.replace('/', "\\")));
    }
    if file_dir == "app/Http/Controllers" || file_dir.starts_with("app/Http/Controllers/") {
        let sub = file_dir
            .trim_start_matches("app/Http/Controllers")
            .trim_matches('/');
        return Some(join_namespace(
            "App\\Http\\Controllers",
            &sub.replace('/', "\\"),
        ));
    }
    None
}

fn namespace_from_relative_file(rest: &str) -> String {
    rest.rsplit_once('/')
        .map(|(dir, _)| dir.replace('/', "\\"))
        .unwrap_or_default()
}

fn join_namespace(prefix: &str, suffix: &str) -> String {
    let prefix = prefix.trim_matches('\\');
    let suffix = suffix.trim_matches('\\');
    match (prefix.is_empty(), suffix.is_empty()) {
        (true, true) => String::new(),
        (true, false) => suffix.to_owned(),
        (false, true) => prefix.to_owned(),
        (false, false) => format!("{prefix}\\{suffix}"),
    }
}

fn relative_slash(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn walk_php_files(
    directory: &Path,
    root: &Path,
    seen: &mut HashSet<PathBuf>,
    files: &mut Vec<PathBuf>,
) -> Result<(), CargoDiscoveryError> {
    let canonical = match directory.canonicalize() {
        Ok(path) => path,
        Err(_) => return Ok(()),
    };
    if !is_confined_to(&canonical, root) || !seen.insert(canonical) {
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
        if name.starts_with('.') || skipped_php_directory(&name) {
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
            walk_php_files(&path, root, seen, files)?;
            continue;
        }
        if !is_php_file(&path) {
            continue;
        }
        if confined_php_path(&path, root).is_none() {
            continue;
        }
        files.push(path);
    }
    Ok(())
}

fn confined_php_path(path: &Path, root: &Path) -> Option<PathBuf> {
    match confined_canonical(path, root) {
        Ok(canonical) => Some(canonical),
        Err(_) => None,
    }
}

fn skipped_php_directory(name: &str) -> bool {
    matches!(name, "vendor" | "node_modules" | "target" | "dist" | ".git")
}

fn is_php_file(path: &Path) -> bool {
    path.extension().and_then(|ext| ext.to_str()) == Some("php")
}

fn strip_php_comments_and_strings(source: &str) -> String {
    let chars: Vec<char> = source.chars().collect();
    let mut index = 0;
    let mut out = String::with_capacity(source.len());
    while index < chars.len() {
        if chars[index] == '<'
            && index + 2 < chars.len()
            && chars[index + 1] == '<'
            && chars[index + 2] == '<'
        {
            index = skip_php_heredoc(&chars, index, &mut out);
            continue;
        }
        if chars[index] == '/' && index + 1 < chars.len() && chars[index + 1] == '/' {
            while index < chars.len() && chars[index] != '\n' {
                index += 1;
            }
            continue;
        }
        if chars[index] == '#' {
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
        if chars[index] == '"' || chars[index] == '\'' {
            let quote = chars[index];
            out.push(quote);
            index += 1;
            while index < chars.len() {
                if chars[index] == '\\' {
                    out.push(' ');
                    index += 1;
                    if index < chars.len() {
                        if chars[index] == '\n' {
                            out.push('\n');
                        } else {
                            out.push(' ');
                        }
                        index += 1;
                    }
                    continue;
                }
                if chars[index] == quote {
                    out.push(quote);
                    index += 1;
                    break;
                }
                if chars[index] == '\n' {
                    out.push('\n');
                } else {
                    out.push(' ');
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

fn skip_php_heredoc(chars: &[char], start: usize, out: &mut String) -> usize {
    let mut index = start + 3;
    if index < chars.len() && (chars[index] == '\'' || chars[index] == '"') {
        index += 1;
    }
    let label_start = index;
    while index < chars.len() && (chars[index].is_ascii_alphanumeric() || chars[index] == '_') {
        index += 1;
    }
    if index == label_start {
        out.push_str("<<<");
        return start + 3;
    }
    let label: String = chars[label_start..index].iter().collect();
    if index < chars.len() && (chars[index] == '\'' || chars[index] == '"') {
        index += 1;
    }
    while index < chars.len() && chars[index] != '\n' {
        index += 1;
    }
    if index < chars.len() && chars[index] == '\n' {
        out.push('\n');
        index += 1;
    }
    while index < chars.len() {
        let line_start = index;
        while index < chars.len() && chars[index] != '\n' {
            index += 1;
        }
        let line: String = chars[line_start..index].iter().collect();
        let closer = line.trim();
        let closer = closer.strip_suffix(';').unwrap_or(closer).trim();
        if index < chars.len() && chars[index] == '\n' {
            out.push('\n');
            index += 1;
        }
        if closer == label {
            break;
        }
    }
    index
}

fn parse_php_code(source: &str) -> (String, Vec<PhpImport>, Vec<PhpSymbol>) {
    let mut namespace = String::new();
    let mut imports = Vec::new();
    let mut symbols = Vec::new();
    let mut brace_depth = 0i32;
    let mut type_stack: Vec<i32> = Vec::new();
    let mut pending_type = false;
    let mut pending_use: Option<(usize, String)> = None;
    for (index, line) in source.lines().enumerate() {
        let line_no = index + 1;
        let trimmed = line.trim();
        let starts_declaration = parse_type_at_start(trimmed).is_some()
            || parse_function_at_start(trimmed).is_some()
            || parse_namespace_line(trimmed).is_some();
        if pending_use.is_some() && starts_declaration {
            pending_use = None;
        }
        if pending_use.is_some() || is_use_start(trimmed) {
            let start_line = pending_use
                .as_ref()
                .map(|(start, _)| *start)
                .unwrap_or(line_no);
            let mut buffer = pending_use.take().map(|(_, text)| text).unwrap_or_default();
            if !buffer.is_empty() {
                buffer.push(' ');
            }
            buffer.push_str(trimmed);
            if buffer.contains(';') {
                if type_stack.is_empty() && !pending_type {
                    imports.extend(parse_use_statement(&buffer, start_line));
                }
            } else {
                pending_use = Some((start_line, buffer));
            }
            continue;
        }
        if type_stack.is_empty() && !pending_type {
            if namespace.is_empty() {
                if let Some(declared) = parse_namespace_line(trimmed) {
                    namespace = declared;
                }
            }
            if let Some((kind, name)) = parse_type_at_start(trimmed) {
                symbols.push(PhpSymbol {
                    name,
                    kind,
                    line: line_no,
                });
                pending_type = true;
            } else if let Some(name) = parse_function_at_start(trimmed) {
                symbols.push(PhpSymbol {
                    name,
                    kind: PhpSymbolKind::Function,
                    line: line_no,
                });
            }
        }
        update_php_braces(line, &mut brace_depth, &mut type_stack, &mut pending_type);
    }
    (namespace, imports, symbols)
}

fn is_use_start(line: &str) -> bool {
    keyword_rest(line, "use").is_some()
}

fn update_php_braces(
    line: &str,
    brace_depth: &mut i32,
    type_stack: &mut Vec<i32>,
    pending_type: &mut bool,
) {
    for character in line.chars() {
        if character == '{' {
            *brace_depth += 1;
            if *pending_type {
                type_stack.push(*brace_depth);
                *pending_type = false;
            }
        } else if character == '}' {
            if type_stack.last() == Some(brace_depth) {
                type_stack.pop();
            }
            *brace_depth -= 1;
        }
    }
}

fn parse_namespace_line(line: &str) -> Option<String> {
    let rest = keyword_rest(line, "namespace")?.trim();
    let rest = rest
        .trim_end_matches('{')
        .trim()
        .trim_end_matches(';')
        .trim()
        .trim_start_matches('\\');
    if rest.is_empty() {
        return Some(String::new());
    }
    let token = rest.split_whitespace().next().unwrap_or("");
    let token = token
        .trim_end_matches(';')
        .trim_end_matches('{')
        .trim_matches('\\');
    if token.is_empty() || !namespace_ok(token) {
        return None;
    }
    Some(token.to_owned())
}

fn namespace_ok(token: &str) -> bool {
    token
        .split('\\')
        .all(|part| php_ident(part).is_some_and(|ident| ident == part))
}

fn parse_type_at_start(line: &str) -> Option<(PhpSymbolKind, String)> {
    let mut rest = line.trim();
    loop {
        let trimmed = rest.trim_start();
        if let Some(next) = keyword_rest(trimmed, "abstract")
            .or_else(|| keyword_rest(trimmed, "final"))
            .or_else(|| keyword_rest(trimmed, "readonly"))
        {
            rest = next.trim_start();
            continue;
        }
        break;
    }
    let rest = rest.trim_start();
    let (kind, after) = if let Some(after) = keyword_rest(rest, "class") {
        (PhpSymbolKind::Class, after)
    } else if let Some(after) = keyword_rest(rest, "interface") {
        (PhpSymbolKind::Interface, after)
    } else if let Some(after) = keyword_rest(rest, "trait") {
        (PhpSymbolKind::Trait, after)
    } else if let Some(after) = keyword_rest(rest, "enum") {
        (PhpSymbolKind::Enum, after)
    } else {
        return None;
    };
    let name = php_ident(after.trim_start())?.to_owned();
    if name.is_empty() {
        return None;
    }
    Some((kind, name))
}

fn parse_function_at_start(line: &str) -> Option<String> {
    let rest = keyword_rest(line, "function")?.trim_start();
    let rest = rest.strip_prefix('&').unwrap_or(rest).trim_start();
    let name = php_ident(rest)?.to_owned();
    if name.is_empty() {
        None
    } else {
        Some(name)
    }
}

fn keyword_rest<'a>(line: &'a str, keyword: &str) -> Option<&'a str> {
    let trimmed = line.trim_start();
    let rest = trimmed.strip_prefix(keyword)?;
    if rest.is_empty() {
        return Some(rest);
    }
    let next = rest.chars().next()?;
    if next.is_alphanumeric() || next == '_' {
        return None;
    }
    Some(rest)
}

fn php_ident(value: &str) -> Option<&str> {
    let mut chars = value.chars();
    let first = chars.next()?;
    if first != '_' && !first.is_alphabetic() {
        return None;
    }
    let mut len = first.len_utf8();
    for character in chars {
        if character == '_' || character.is_alphanumeric() {
            len += character.len_utf8();
        } else {
            break;
        }
    }
    Some(&value[..len])
}

fn parse_use_statement(buffer: &str, line: usize) -> Vec<PhpImport> {
    let text = buffer.trim().trim_end_matches(';').trim();
    let Some(rest) = keyword_rest(text, "use") else {
        return Vec::new();
    };
    let rest = rest.trim();
    let (kind, rest) = if let Some(rest) = keyword_rest(rest, "function") {
        ("function", rest.trim())
    } else if let Some(rest) = keyword_rest(rest, "const") {
        ("const", rest.trim())
    } else {
        ("", rest)
    };
    if let Some(open) = rest.find('{') {
        let prefix = rest[..open].trim().trim_end_matches('\\');
        let close = rest.rfind('}').unwrap_or(rest.len());
        if close < open {
            return Vec::new();
        }
        let inner = &rest[open + 1..close];
        return inner
            .split(',')
            .filter_map(|part| {
                let part = part.trim();
                if part.is_empty() {
                    return None;
                }
                let (name, alias) = split_as(part);
                if name.is_empty() {
                    return None;
                }
                let qualified = if prefix.is_empty() {
                    name
                } else {
                    format!("{prefix}\\{name}")
                };
                Some(php_import(kind, qualified, alias, line))
            })
            .collect();
    }
    let (name, alias) = split_as(rest.trim().trim_end_matches(';'));
    if name.is_empty() {
        return Vec::new();
    }
    vec![php_import(kind, name, alias, line)]
}

fn split_as(part: &str) -> (String, Option<String>) {
    let mut pieces = part.splitn(2, " as ");
    let name = pieces
        .next()
        .unwrap_or("")
        .trim()
        .trim_start_matches('\\')
        .to_owned();
    let alias = pieces
        .next()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    (name, alias)
}

fn php_import(kind: &str, qualified: String, alias: Option<String>, line: usize) -> PhpImport {
    let qualified = qualified.trim().trim_matches('\\').to_owned();
    let statement = match (kind, &alias) {
        ("", None) => format!("use {qualified};"),
        ("", Some(alias)) => format!("use {qualified} as {alias};"),
        (kind, None) => format!("use {kind} {qualified};"),
        (kind, Some(alias)) => format!("use {kind} {qualified} as {alias};"),
    };
    PhpImport {
        line,
        qualified,
        alias,
        statement,
    }
}

#[cfg(test)]
mod tests {
    use super::{discover_php_packages, parse_php_source, PhpSymbolKind};
    use crate::extract::extract_cargo_map;
    use crate::facts::FactBlock;
    use sha2::{Digest, Sha256};
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn fixture_root() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/php-sample")
    }

    #[test]
    fn language_id_encode_keeps_case_and_separators_distinct() {
        use crate::extract::{extract_cargo_map, language_id_encode};
        use crate::facts::FactBlock;
        assert_ne!(
            language_id_encode("Vendor\\Foo_Bar"),
            language_id_encode("Vendor\\Foo\\Bar")
        );
        assert_ne!(language_id_encode("Foo/Bar"), language_id_encode("foo/bar"));
        let map = extract_cargo_map(&fixture_root(), Some("PHP Sample")).expect("extract");
        let ids: Vec<_> = map
            .blocks
            .iter()
            .filter_map(|block| match block {
                FactBlock::Module(module) if module.language == "php" => {
                    Some(module.base.id.as_str())
                }
                _ => None,
            })
            .collect();
        let mut unique = ids.clone();
        unique.sort_unstable();
        unique.dedup();
        assert_eq!(ids.len(), unique.len(), "php block ids must stay injective");
    }

    fn temporary_directory(label: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "lightwell-php-{label}-{}-{unique}",
            std::process::id()
        ))
    }

    #[test]
    fn parse_keeps_symbols_after_comments_and_ignores_methods() {
        let source = "<?php\n/* block\n   comment */\nclass After {}\n";
        let (_, _, symbols) = parse_php_source(source);
        assert_eq!(symbols.len(), 1);
        assert_eq!(symbols[0].name, "After");
        assert_eq!(symbols[0].line, 4);
        let hidden = "<?php\n// class Fake\n/* class Hidden */\nclass Real {}\n";
        let (_, _, symbols) = parse_php_source(hidden);
        assert_eq!(symbols.len(), 1);
        assert_eq!(symbols[0].name, "Real");
        let methods = "<?php\nclass User {\n    public function name(): string { return \"a\"; }\n}\nfunction helper(): void {}\n";
        let (_, _, symbols) = parse_php_source(methods);
        assert!(symbols
            .iter()
            .any(|symbol| symbol.name == "User" && symbol.kind == PhpSymbolKind::Class));
        assert!(symbols
            .iter()
            .any(|symbol| symbol.name == "helper" && symbol.kind == PhpSymbolKind::Function));
        assert!(symbols.iter().all(|symbol| symbol.name != "name"));
    }

    #[test]
    fn parse_use_groups_aliases_and_survives_non_ascii() {
        let source = "<?php\n// 日本語 café\nnamespace App\\Models;\nuse Foo\\Bar;\nuse App\\Models\\{User, Post as Article};\nuse function App\\Support\\helper as h;\n";
        let (namespace, imports, _) = parse_php_source(source);
        assert_eq!(namespace, "App\\Models");
        assert!(imports.iter().any(|item| item.qualified == "Foo\\Bar"));
        assert!(imports
            .iter()
            .any(|item| item.qualified == "App\\Models\\User" && item.alias.is_none()));
        assert!(imports
            .iter()
            .any(|item| item.qualified == "App\\Models\\Post"
                && item.alias.as_deref() == Some("Article")));
        assert!(imports.iter().any(|item| {
            item.qualified == "App\\Support\\helper" && item.statement.starts_with("use function ")
        }));
    }

    #[test]
    fn fixture_lists_namespaces_symbols_and_skips_vendor() {
        let packages = discover_php_packages(&fixture_root()).expect("php fixture");
        assert!(packages.iter().all(|package| {
            package
                .files
                .iter()
                .all(|file| !file.path.to_string_lossy().contains("vendor"))
        }));
        let models = packages
            .iter()
            .find(|package| package.import_path == "acme/blog/App/Models")
            .expect("models namespace");
        assert_eq!(models.namespace, "App\\Models");
        assert!(models.files.iter().any(|file| {
            file.symbols
                .iter()
                .any(|symbol| symbol.name == "User" && symbol.kind == PhpSymbolKind::Class)
                && file
                    .symbols
                    .iter()
                    .any(|symbol| symbol.name == "user_label")
                && file.symbols.iter().all(|symbol| symbol.name != "name")
                && file
                    .imports
                    .iter()
                    .any(|item| item.qualified == "Acme\\Legacy\\Widget")
        }));
        assert!(models.files.iter().any(|file| {
            file.path.ends_with("Guest.php")
                && file.namespace == "App\\Models"
                && file.symbols.iter().any(|symbol| symbol.name == "Guest")
        }));
        assert!(models.files.iter().any(|file| {
            file.symbols
                .iter()
                .any(|symbol| symbol.kind == PhpSymbolKind::Interface && symbol.name == "Named")
                && file.symbols.iter().any(|symbol| {
                    symbol.kind == PhpSymbolKind::Trait && symbol.name == "Timestamps"
                })
                && file
                    .symbols
                    .iter()
                    .any(|symbol| symbol.kind == PhpSymbolKind::Enum && symbol.name == "Status")
        }));
        let controllers = packages
            .iter()
            .find(|package| package.import_path == "acme/blog/App/Http/Controllers")
            .expect("controllers");
        assert!(controllers.files.iter().any(|file| {
            file.path.ends_with("HealthController.php")
                && file
                    .symbols
                    .iter()
                    .any(|symbol| symbol.name == "HealthController" && symbol.line == 4)
        }));
        assert!(packages
            .iter()
            .any(|package| package.namespace == "Acme\\Legacy"));
    }

    #[test]
    fn laravel_signals_map_models_and_controllers_without_psr4() {
        let root = temporary_directory("laravel");
        fs::create_dir_all(root.join("app/Models")).expect("models");
        fs::create_dir_all(root.join("app/Http/Controllers")).expect("controllers");
        fs::write(
            root.join("composer.json"),
            "{\n  \"name\": \"acme/laravel\"\n}\n",
        )
        .expect("composer");
        fs::write(root.join("artisan"), "#!/usr/bin/env php\n").expect("artisan");
        fs::write(root.join("app/Models/Post.php"), "<?php\nclass Post {}\n").expect("post");
        fs::write(
            root.join("app/Http/Controllers/PostController.php"),
            "<?php\nclass PostController {}\n",
        )
        .expect("controller");
        let packages = discover_php_packages(&root).expect("discover");
        assert!(packages
            .iter()
            .any(|package| package.import_path == "acme/laravel/App/Models"
                && package.namespace == "App\\Models"));
        assert!(packages.iter().any(|package| {
            package.import_path == "acme/laravel/App/Http/Controllers"
                && package.namespace == "App\\Http\\Controllers"
        }));
        fs::remove_dir_all(&root).expect("cleanup");
    }

    #[test]
    fn plain_composer_does_not_invent_laravel_namespaces() {
        let root = temporary_directory("plain");
        fs::create_dir_all(root.join("app/Models")).expect("models");
        fs::write(
            root.join("composer.json"),
            "{\n  \"name\": \"acme/plain\"\n}\n",
        )
        .expect("composer");
        fs::write(root.join("app/Models/Post.php"), "<?php\nclass Post {}\n").expect("post");
        let packages = discover_php_packages(&root).expect("discover");
        assert_eq!(packages.len(), 1);
        assert_eq!(packages[0].import_path, "acme/plain");
        assert!(packages[0].namespace.is_empty());
        fs::remove_dir_all(&root).expect("cleanup");
    }

    #[test]
    fn skipped_directories_are_not_discovered() {
        let root = temporary_directory("skip");
        for dir in ["vendor", "node_modules", "target", "dist", ".git"] {
            fs::create_dir_all(root.join(dir)).expect("dir");
            fs::write(root.join(dir).join("Nope.php"), "<?php\nclass Nope {}\n").expect("php");
        }
        fs::create_dir_all(root.join("src")).expect("src");
        fs::write(
            root.join("composer.json"),
            "{\n  \"name\": \"acme/skip\"\n}\n",
        )
        .expect("composer");
        fs::write(
            root.join("src/Keep.php"),
            "<?php\nnamespace Keep;\nclass Keep {}\n",
        )
        .expect("keep");
        let packages = discover_php_packages(&root).expect("discover");
        let files: Vec<_> = packages
            .iter()
            .flat_map(|package| package.files.iter())
            .collect();
        assert_eq!(files.len(), 1);
        assert!(files[0].path.ends_with("Keep.php"));
        fs::remove_dir_all(&root).expect("cleanup");
    }

    #[test]
    fn composer_json_alone_extracts_php_blocks_and_use_edges() {
        let root = fixture_root();
        let map = extract_cargo_map(&root, Some("PHP Sample")).expect("extract");
        assert!(map.blocks.iter().any(|block| matches!(
            block,
            FactBlock::Workspace(workspace) if workspace.base.source_path.as_deref() == Some("composer.json")
        )));
        let modules = map
            .blocks
            .iter()
            .filter_map(|block| match block {
                FactBlock::Module(module) if module.language == "php" => Some(module),
                _ => None,
            })
            .collect::<Vec<_>>();
        let controller = modules
            .iter()
            .find(|module| module.module_path == "acme/blog/App/Http/Controllers/UserController")
            .expect("controller file");
        let user = modules
            .iter()
            .find(|module| module.module_path == "acme/blog/App/Models/User.User")
            .expect("user class");
        assert_eq!(user.cfg_attributes, vec!["class".to_owned()]);
        assert!(modules
            .iter()
            .any(|module| module.module_path == "acme/blog/App/Models/User.user_label"));
        assert!(modules
            .iter()
            .any(|module| module.module_path == "acme/blog/Acme/Legacy/Widget.Widget"));
        assert!(map.connections.iter().any(|connection| {
            matches!(
                connection,
                crate::facts::Connection::DependsOn { source, target, .. }
                    if source == &controller.base.id && target == &user.base.id
            )
        }));
        let workspace = map.blocks.iter().find_map(|block| match block {
            FactBlock::Workspace(workspace) => Some(workspace),
            _ => None,
        });
        let fingerprint = &workspace.expect("workspace").base.fingerprint;
        let packages = discover_php_packages(&root).expect("packages");
        let mut inputs = Vec::new();
        for package in &packages {
            for file in &package.files {
                let bytes = fs::read(&file.path).expect("file bytes");
                let hash = format!("{:x}", Sha256::digest(&bytes));
                let base = file
                    .path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("file");
                inputs.push(format!("php:{}:{base}:{hash}", package.import_path));
            }
        }
        inputs.sort();
        assert!(inputs.iter().any(
            |line| line.starts_with("php:acme/blog/App/Models:User.php:")
                && line.len() == "php:acme/blog/App/Models:User.php:".len() + 64
        ));
        assert!(
            inputs
                .iter()
                .any(|line| line
                    .starts_with("php:acme/blog/App/Http/Controllers:UserController.php:"))
        );
        let expected = format!("{:x}", Sha256::digest(inputs.join("\n").as_bytes()));
        assert_eq!(fingerprint, &expected);
    }
}
