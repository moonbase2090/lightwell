use crate::metadata::CargoDiscoveryError;
use crate::path_confinement::{confined_canonical, is_confined_to, opened_root};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct RubyPackage {
    pub gem_name: String,
    pub import_path: String,
    pub name: String,
    pub directory: PathBuf,
    pub files: Vec<RubyFile>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct RubyFile {
    pub path: PathBuf,
    pub unreadable: bool,
    /// Path of this file within its unit, without `.rb` (`user`, `admin/user`).
    pub module_suffix: String,
    pub imports: Vec<RubyImport>,
    pub symbols: Vec<RubySymbol>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct RubyImport {
    pub line: usize,
    pub path: String,
    pub relative: bool,
    pub statement: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum RubySymbolKind {
    Module,
    Class,
    Def,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct RubySymbol {
    pub name: String,
    pub kind: RubySymbolKind,
    pub line: usize,
}

impl RubySymbol {
    pub(crate) fn outline_label(&self) -> &'static str {
        match self.kind {
            RubySymbolKind::Module => "module",
            RubySymbolKind::Class => "class",
            RubySymbolKind::Def => "def",
        }
    }
}

/// Discover Ruby files when a `Gemfile` is present. Returns an empty list otherwise.
/// Skips `vendor/` (including `vendor/bundle`), `.git`, `node_modules`, `tmp`, `log`, and `.bundle`.
pub(crate) fn discover_ruby_packages(
    repository_path: &Path,
) -> Result<Vec<RubyPackage>, CargoDiscoveryError> {
    let gemfile = repository_path.join("Gemfile");
    if !gemfile.is_file() {
        return Ok(Vec::new());
    }
    let canonical_root = opened_root(repository_path)?;
    let gemfile_text =
        fs::read_to_string(&gemfile).map_err(|source| CargoDiscoveryError::RepositoryPath {
            path: gemfile,
            source,
        })?;
    let gem_name =
        read_gemspec_name(repository_path).unwrap_or_else(|| directory_name(repository_path));
    let rails = rails_project(repository_path, &gemfile_text);
    let mut paths = Vec::new();
    let mut seen = HashSet::new();
    walk_ruby_files(repository_path, &canonical_root, &mut seen, &mut paths)?;
    paths.sort();
    let mut grouped: HashMap<String, Vec<RubyFile>> = HashMap::new();
    for path in paths {
        let relative = relative_slash(repository_path, &path);
        let unit_key = ruby_unit_key(&relative, rails);
        let module_suffix = ruby_file_suffix(&relative, &unit_key, rails);
        let ruby_file = load_ruby_file(&path, module_suffix)?;
        grouped.entry(unit_key).or_default().push(ruby_file);
    }
    let mut packages = grouped
        .into_iter()
        .map(|(unit_key, mut ruby_files)| {
            ruby_files.sort_by(|left, right| left.path.cmp(&right.path));
            let import_path = if unit_key.is_empty() {
                gem_name.clone()
            } else {
                format!("{gem_name}/{unit_key}")
            };
            let name = import_path
                .rsplit('/')
                .next()
                .unwrap_or(&import_path)
                .to_owned();
            let directory = ruby_files
                .first()
                .and_then(|file| file.path.parent().map(Path::to_path_buf))
                .unwrap_or_else(|| repository_path.to_path_buf());
            RubyPackage {
                gem_name: gem_name.clone(),
                import_path,
                name,
                directory,
                files: ruby_files,
            }
        })
        .collect::<Vec<_>>();
    packages.sort_by(|left, right| left.import_path.cmp(&right.import_path));
    Ok(packages)
}

pub(crate) fn parse_ruby_source(source: &str) -> (Vec<RubyImport>, Vec<RubySymbol>) {
    let (visible, code) = ruby_views(source);
    let mut imports = Vec::new();
    let mut symbols = Vec::new();
    let mut state = RubyScan::default();
    let code_lines: Vec<&str> = code.lines().collect();
    let visible_lines: Vec<&str> = visible.lines().collect();
    let line_count = code_lines.len().max(visible_lines.len());
    for index in 0..line_count {
        let line_no = index + 1;
        let code_line = code_lines.get(index).copied().unwrap_or("");
        let visible_line = visible_lines.get(index).copied().unwrap_or("");
        if let Some(import) = parse_require_line(code_line, visible_line, line_no) {
            imports.push(import);
        }
        apply_ruby_line(code_line, line_no, &mut state, &mut symbols);
    }
    (imports, symbols)
}

pub(crate) fn resolve_ruby_require(
    root: &Path,
    from: &Path,
    import: &RubyImport,
) -> Option<PathBuf> {
    // Canonicalize the opened root so Windows confinement matches discovered file paths
    // (canonical paths may carry a `\\?\` prefix that a raw fixture path lacks).
    let root = opened_root(root).ok()?;
    let relative_path = PathBuf::from(import.path.replace('\\', "/"));
    if import.relative {
        let parent = from.parent()?;
        return confined_ruby_file(&root, &with_rb_extension(parent.join(&relative_path)));
    }
    let relative = if import.path.ends_with(".rb") {
        import.path.trim_start_matches("./").replace('\\', "/")
    } else {
        format!(
            "{}.rb",
            import.path.trim_start_matches("./").replace('\\', "/")
        )
    };
    let relative = PathBuf::from(relative);
    for base in [
        root.join("lib"),
        root.clone(),
        root.join("app").join("models"),
        root.join("app").join("controllers"),
    ] {
        if let Some(found) = confined_ruby_file(&root, &base.join(&relative)) {
            return Some(found);
        }
    }
    None
}

fn confined_ruby_file(root: &Path, path: &Path) -> Option<PathBuf> {
    if !path.is_file() {
        return None;
    }
    confined_canonical(path, root).ok()
}

fn with_rb_extension(path: PathBuf) -> PathBuf {
    match path.extension().and_then(|ext| ext.to_str()) {
        Some("rb") => path,
        Some(_) => path,
        None => path.with_extension("rb"),
    }
}

#[derive(Default)]
struct RubyScan {
    depth: i32,
    struct_at: Vec<i32>,
    /// `for`/`while`/`until` already opened a block; a same-line `do` must not open again.
    expect_do: bool,
}

fn load_ruby_file(path: &Path, module_suffix: String) -> Result<RubyFile, CargoDiscoveryError> {
    let source = match fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(_) => {
            return Ok(RubyFile {
                path: path.to_path_buf(),
                unreadable: true,
                module_suffix,
                imports: Vec::new(),
                symbols: Vec::new(),
            });
        }
    };
    let (imports, symbols) = parse_ruby_source(&source);
    Ok(RubyFile {
        path: path.to_path_buf(),
        unreadable: false,
        module_suffix,
        imports,
        symbols,
    })
}

fn rails_project(root: &Path, gemfile: &str) -> bool {
    root.join("config").join("application.rb").is_file()
        || root.join("bin").join("rails").is_file()
        || gemfile_depends_on_rails(gemfile)
}

fn gemfile_depends_on_rails(source: &str) -> bool {
    for line in source.lines() {
        let code = line.split('#').next().unwrap_or("").trim();
        let Some(rest) = keyword_rest(code, "gem") else {
            continue;
        };
        let rest = rest.trim().trim_start_matches('(').trim();
        let Some(quote) = rest.chars().next() else {
            continue;
        };
        if quote != '"' && quote != '\'' {
            continue;
        }
        let body = &rest[1..];
        let Some(end) = body.find(quote) else {
            continue;
        };
        if &body[..end] == "rails" {
            return true;
        }
    }
    false
}

fn read_gemspec_name(root: &Path) -> Option<String> {
    let mut specs = Vec::new();
    for entry in fs::read_dir(root).ok()? {
        let path = entry.ok()?.path();
        if path.extension().and_then(|ext| ext.to_str()) == Some("gemspec") {
            specs.push(path);
        }
    }
    specs.sort();
    for path in specs {
        let Ok(text) = fs::read_to_string(&path) else {
            continue;
        };
        if let Some(name) = gemspec_name_from_source(&text) {
            return Some(name);
        }
    }
    None
}

fn gemspec_name_from_source(source: &str) -> Option<String> {
    for line in source.lines() {
        let code = line.split('#').next().unwrap_or("").trim();
        let Some((_, after)) = code.split_once(".name") else {
            continue;
        };
        let rest = after.trim().trim_start_matches('=').trim();
        let quote = rest.chars().next()?;
        if quote != '"' && quote != '\'' {
            continue;
        }
        let body = &rest[1..];
        let end = body.find(quote)?;
        let name = body[..end].trim();
        if !name.is_empty() {
            return Some(name.to_owned());
        }
    }
    None
}

fn directory_name(root: &Path) -> String {
    root.file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("ruby")
        .to_owned()
}

fn ruby_unit_key(relative: &str, rails: bool) -> String {
    if rails && (relative.starts_with("app/models/") || relative == "app/models") {
        return "models".to_owned();
    }
    if rails && (relative.starts_with("app/controllers/") || relative == "app/controllers") {
        return "controllers".to_owned();
    }
    match relative.rsplit_once('/') {
        Some((dir, _)) => dir.to_owned(),
        None => String::new(),
    }
}

fn ruby_file_suffix(relative: &str, unit_key: &str, rails: bool) -> String {
    let no_ext = relative.strip_suffix(".rb").unwrap_or(relative);
    if rails && unit_key == "models" {
        return no_ext
            .strip_prefix("app/models/")
            .unwrap_or(no_ext)
            .to_owned();
    }
    if rails && unit_key == "controllers" {
        return no_ext
            .strip_prefix("app/controllers/")
            .unwrap_or(no_ext)
            .to_owned();
    }
    no_ext.rsplit('/').next().unwrap_or(no_ext).to_owned()
}

fn relative_slash(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn walk_ruby_files(
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
        if name.starts_with('.') || skipped_ruby_directory(&name) {
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
            walk_ruby_files(&path, root, seen, files)?;
            continue;
        }
        if path.extension().and_then(|ext| ext.to_str()) != Some("rb") {
            continue;
        }
        if confined_canonical(&path, root).is_err() {
            continue;
        }
        files.push(path);
    }
    Ok(())
}

fn skipped_ruby_directory(name: &str) -> bool {
    matches!(
        name,
        "vendor" | "node_modules" | "tmp" | "log" | ".git" | ".bundle"
    )
}

fn ruby_views(source: &str) -> (String, String) {
    let source = source.strip_prefix('\u{feff}').unwrap_or(source);
    let chars: Vec<char> = source.chars().collect();
    let mut index = 0;
    let mut visible = String::new();
    let mut code = String::new();
    let mut line_start = true;
    while index < chars.len() {
        if line_start && starts_with_at(&chars, index, "=begin") {
            let after = index + "=begin".len();
            let boundary =
                after >= chars.len() || chars[after].is_whitespace() || chars[after] == '\n';
            if boundary {
                index = skip_begin_comment(&chars, index, &mut visible, &mut code);
                line_start = true;
                continue;
            }
        }
        let ch = chars[index];
        if ch == '#' {
            while index < chars.len() && chars[index] != '\n' {
                index += 1;
            }
            line_start = false;
            continue;
        }
        if ch == '\'' || ch == '"' {
            index = copy_ruby_string(&chars, index, &mut visible, &mut code);
            line_start = false;
            continue;
        }
        visible.push(ch);
        code.push(ch);
        index += 1;
        line_start = ch == '\n';
    }
    (visible, code)
}

fn skip_begin_comment(
    chars: &[char],
    start: usize,
    visible: &mut String,
    code: &mut String,
) -> usize {
    let mut index = start;
    while index < chars.len() && chars[index] != '\n' {
        index += 1;
    }
    if index < chars.len() && chars[index] == '\n' {
        visible.push('\n');
        code.push('\n');
        index += 1;
    }
    while index < chars.len() {
        let line_begin = index;
        while index < chars.len() && chars[index] != '\n' {
            index += 1;
        }
        let line: String = chars[line_begin..index].iter().collect();
        if index < chars.len() && chars[index] == '\n' {
            visible.push('\n');
            code.push('\n');
            index += 1;
        }
        let trimmed = line.trim();
        if trimmed == "=end" || trimmed.starts_with("=end ") || trimmed.starts_with("=end\t") {
            break;
        }
    }
    index
}

fn copy_ruby_string(
    chars: &[char],
    start: usize,
    visible: &mut String,
    code: &mut String,
) -> usize {
    let quote = chars[start];
    visible.push(quote);
    code.push(quote);
    let mut index = start + 1;
    while index < chars.len() {
        if chars[index] == '\\' {
            visible.push('\\');
            code.push(' ');
            index += 1;
            if index < chars.len() {
                visible.push(chars[index]);
                if chars[index] == '\n' {
                    code.push('\n');
                } else {
                    code.push(' ');
                }
                index += 1;
            }
            continue;
        }
        if chars[index] == quote {
            visible.push(quote);
            code.push(quote);
            index += 1;
            break;
        }
        visible.push(chars[index]);
        if chars[index] == '\n' {
            code.push('\n');
        } else {
            code.push(' ');
        }
        index += 1;
    }
    index
}

fn starts_with_at(chars: &[char], index: usize, text: &str) -> bool {
    chars[index..].iter().collect::<String>().starts_with(text)
}

#[derive(Debug)]
enum RubyTok {
    Word(String),
    Semi,
    Dot,
    Colon2,
    LBrace,
    RBrace,
}

fn tokenize_ruby(line: &str) -> Vec<RubyTok> {
    let chars: Vec<char> = line.chars().collect();
    let mut index = 0;
    let mut tokens = Vec::new();
    while index < chars.len() {
        let ch = chars[index];
        if ch.is_whitespace() {
            index += 1;
            continue;
        }
        if ch == '#' {
            break;
        }
        if ch == ';' {
            tokens.push(RubyTok::Semi);
            index += 1;
            continue;
        }
        if ch == '{' {
            tokens.push(RubyTok::LBrace);
            index += 1;
            continue;
        }
        if ch == '}' {
            tokens.push(RubyTok::RBrace);
            index += 1;
            continue;
        }
        if ch == '.' {
            tokens.push(RubyTok::Dot);
            index += 1;
            continue;
        }
        if ch == ':' && index + 1 < chars.len() && chars[index + 1] == ':' {
            tokens.push(RubyTok::Colon2);
            index += 2;
            continue;
        }
        if ch == '_' || ch.is_alphabetic() {
            let start = index;
            index += 1;
            while index < chars.len() && (chars[index].is_alphanumeric() || chars[index] == '_') {
                index += 1;
            }
            if index < chars.len()
                && (chars[index] == '?' || chars[index] == '!' || chars[index] == '=')
            {
                index += 1;
            }
            tokens.push(RubyTok::Word(chars[start..index].iter().collect()));
            continue;
        }
        index += 1;
    }
    tokens
}

fn apply_ruby_line(
    line: &str,
    line_no: usize,
    state: &mut RubyScan,
    symbols: &mut Vec<RubySymbol>,
) {
    let tokens = tokenize_ruby(line);
    let mut index = 0;
    let mut at_statement = true;
    while index < tokens.len() {
        match &tokens[index] {
            RubyTok::Semi => {
                at_statement = true;
                index += 1;
            }
            RubyTok::LBrace => {
                state.depth += 1;
                at_statement = false;
                index += 1;
            }
            RubyTok::RBrace => {
                close_ruby_block(state);
                at_statement = false;
                index += 1;
            }
            RubyTok::Dot | RubyTok::Colon2 => {
                at_statement = false;
                index += 1;
            }
            RubyTok::Word(word) if at_statement && (word == "module" || word == "class") => {
                let keyword_is_module = word == "module";
                if let Some((name, next)) = read_const_path(&tokens, index + 1) {
                    symbols.push(RubySymbol {
                        name,
                        kind: if keyword_is_module {
                            RubySymbolKind::Module
                        } else {
                            RubySymbolKind::Class
                        },
                        line: line_no,
                    });
                    index = next;
                } else {
                    index += 1;
                }
                state.depth += 1;
                state.struct_at.push(state.depth);
                at_statement = false;
            }
            RubyTok::Word(word) if at_statement && word == "def" => {
                let mut cursor = index + 1;
                if matches!(tokens.get(cursor), Some(RubyTok::Word(next)) if next == "self") {
                    cursor += 1;
                    if matches!(tokens.get(cursor), Some(RubyTok::Dot)) {
                        cursor += 1;
                    }
                }
                if state.struct_at.is_empty() {
                    if let Some(RubyTok::Word(name)) = tokens.get(cursor) {
                        if is_method_name(name) {
                            symbols.push(RubySymbol {
                                name: name.clone(),
                                kind: RubySymbolKind::Def,
                                line: line_no,
                            });
                        }
                    }
                }
                state.depth += 1;
                at_statement = false;
                index += 1;
            }
            RubyTok::Word(word)
                if at_statement && matches!(word.as_str(), "while" | "until" | "for") =>
            {
                state.depth += 1;
                state.expect_do = true;
                at_statement = false;
                index += 1;
            }
            RubyTok::Word(word)
                if at_statement && matches!(word.as_str(), "if" | "unless" | "case" | "begin") =>
            {
                state.depth += 1;
                state.expect_do = false;
                at_statement = false;
                index += 1;
            }
            RubyTok::Word(word) if word == "do" => {
                if state.expect_do {
                    state.expect_do = false;
                } else {
                    state.depth += 1;
                }
                at_statement = false;
                index += 1;
            }
            RubyTok::Word(word) if word == "end" => {
                state.expect_do = false;
                close_ruby_block(state);
                at_statement = false;
                index += 1;
            }
            RubyTok::Word(_) => {
                at_statement = false;
                index += 1;
            }
        }
    }
    state.expect_do = false;
}

fn close_ruby_block(state: &mut RubyScan) {
    if state.struct_at.last() == Some(&state.depth) {
        state.struct_at.pop();
    }
    state.depth = state.depth.saturating_sub(1);
}

fn read_const_path(tokens: &[RubyTok], start: usize) -> Option<(String, usize)> {
    let RubyTok::Word(first) = tokens.get(start)? else {
        return None;
    };
    if !is_const(first) {
        return None;
    }
    let mut name = first.clone();
    let mut cursor = start + 1;
    while matches!(tokens.get(cursor), Some(RubyTok::Colon2)) {
        let Some(RubyTok::Word(next)) = tokens.get(cursor + 1) else {
            break;
        };
        if !is_const(next) {
            break;
        }
        name.push_str("::");
        name.push_str(next);
        cursor += 2;
    }
    Some((name, cursor))
}

fn is_const(name: &str) -> bool {
    name.chars()
        .next()
        .is_some_and(|character| character.is_uppercase())
}

fn is_method_name(name: &str) -> bool {
    let mut chars = name.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if first != '_' && !first.is_alphabetic() {
        return false;
    }
    name.chars()
        .all(|character| character.is_alphanumeric() || matches!(character, '_' | '?' | '!' | '='))
}

fn parse_require_line(code_line: &str, visible_line: &str, line: usize) -> Option<RubyImport> {
    let code = code_line.trim();
    if keyword_rest(code, "require_relative").is_none() && keyword_rest(code, "require").is_none() {
        return None;
    }
    parse_require(visible_line.trim(), line)
}

fn parse_require(line: &str, line_no: usize) -> Option<RubyImport> {
    let (relative, rest) = if let Some(rest) = keyword_rest(line, "require_relative") {
        (true, rest.trim())
    } else if let Some(rest) = keyword_rest(line, "require") {
        (false, rest.trim())
    } else {
        return None;
    };
    let rest = rest.trim_start_matches('(').trim();
    let quote = rest.chars().next()?;
    if quote != '"' && quote != '\'' {
        return None;
    }
    let body = &rest[1..];
    let end = body.find(quote)?;
    let path = body[..end].trim();
    if path.is_empty() {
        return None;
    }
    let keyword = if relative {
        "require_relative"
    } else {
        "require"
    };
    Some(RubyImport {
        line: line_no,
        path: path.to_owned(),
        relative,
        statement: format!("{keyword} {quote}{path}{quote}"),
    })
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

#[cfg(test)]
mod tests {
    use super::{discover_ruby_packages, parse_ruby_source, resolve_ruby_require, RubySymbolKind};
    use crate::extract::{extract_cargo_map, language_id_encode};
    use crate::facts::FactBlock;
    use sha2::{Digest, Sha256};
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn fixture_root() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/ruby-sample")
    }

    #[test]
    fn for_do_does_not_drop_later_top_level_defs() {
        let source = "class Before\nend\nfor x in xs do\n  class A\n  end\nend\nmodule Foo\n  class Bar\n  end\nend\ndef top_level\nend\n";
        let (_, symbols) = parse_ruby_source(source);
        assert!(symbols
            .iter()
            .any(|symbol| symbol.name == "Before" && symbol.kind == RubySymbolKind::Class));
        assert!(symbols
            .iter()
            .any(|symbol| symbol.name == "A" && symbol.kind == RubySymbolKind::Class));
        assert!(symbols
            .iter()
            .any(|symbol| symbol.name == "Foo" && symbol.kind == RubySymbolKind::Module));
        assert!(symbols
            .iter()
            .any(|symbol| symbol.name == "Bar" && symbol.kind == RubySymbolKind::Class));
        assert!(
            symbols
                .iter()
                .any(|symbol| symbol.name == "top_level" && symbol.kind == RubySymbolKind::Def),
            "for..do must not leave depth stale so top_level disappears"
        );
    }

    #[test]
    fn language_id_encode_keeps_case_and_separators_distinct() {
        assert_eq!(language_id_encode("Foo"), "Foo");
        assert_eq!(language_id_encode("foo"), "foo");
        assert_ne!(language_id_encode("Foo"), language_id_encode("foo"));
        assert_eq!(language_id_encode("foo-bar"), "foo_2d_bar");
        assert_eq!(language_id_encode("foo_bar"), "foo_5f_bar");
        assert_ne!(
            language_id_encode("Vendor\\Foo_Bar"),
            language_id_encode("Vendor\\Foo\\Bar")
        );
        assert_ne!(
            language_id_encode("lib/foo-bar"),
            language_id_encode("lib/foo/bar")
        );
        let map = extract_cargo_map(&fixture_root(), Some("Ruby Sample")).expect("extract");
        let ids: Vec<_> = map
            .blocks
            .iter()
            .filter_map(|block| match block {
                FactBlock::Module(module) if module.language == "ruby" => {
                    Some(module.base.id.as_str())
                }
                _ => None,
            })
            .collect();
        let mut unique = ids.clone();
        unique.sort_unstable();
        unique.dedup();
        assert_eq!(
            ids.len(),
            unique.len(),
            "ruby block ids must stay injective"
        );
    }

    fn temporary_directory(label: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "lightwell-ruby-{label}-{}-{unique}",
            std::process::id()
        ))
    }

    #[test]
    fn parse_skips_block_comments_and_methods_inside_classes() {
        let source = "=begin\nclass Hidden\n=end\nclass Shown\nend\n";
        let (_, symbols) = parse_ruby_source(source);
        assert_eq!(symbols.len(), 1);
        assert_eq!(symbols[0].name, "Shown");
        assert_eq!(symbols[0].line, 4);
        assert_eq!(symbols[0].kind, RubySymbolKind::Class);
        let methods = "module Accounts\n  class User\n    def name\n    end\n  end\nend\ndef user_label\nend\n";
        let (_, symbols) = parse_ruby_source(methods);
        assert!(symbols
            .iter()
            .any(|symbol| symbol.name == "Accounts" && symbol.kind == RubySymbolKind::Module));
        assert!(symbols
            .iter()
            .any(|symbol| symbol.name == "User" && symbol.kind == RubySymbolKind::Class));
        assert!(symbols
            .iter()
            .any(|symbol| symbol.name == "user_label" && symbol.kind == RubySymbolKind::Def));
        assert!(symbols.iter().all(|symbol| symbol.name != "name"));
    }

    #[test]
    fn parse_require_keeps_paths_after_non_ascii_comments() {
        let source = "# 日本語 café\nrequire \"json\"\nrequire_relative \"../models/user\"\nclass After\nend\n";
        let (imports, symbols) = parse_ruby_source(source);
        assert_eq!(imports.len(), 2);
        assert_eq!(imports[0].path, "json");
        assert!(!imports[0].relative);
        assert!(imports[1].relative);
        assert_eq!(imports[1].path, "../models/user");
        assert_eq!(symbols.len(), 1);
        assert_eq!(symbols[0].name, "After");
    }

    #[test]
    fn fixture_maps_rails_units_and_skips_vendor_tmp_and_log() {
        let packages = discover_ruby_packages(&fixture_root()).expect("ruby fixture");
        assert!(packages.iter().all(|package| package.gem_name == "blog"));
        let root = fixture_root();
        assert!(packages.iter().all(|package| {
            package.files.iter().all(|file| {
                let relative = file.path.strip_prefix(&root).unwrap_or(&file.path);
                relative.components().all(|component| {
                    !matches!(
                        component.as_os_str().to_str(),
                        Some("vendor" | "tmp" | "log" | ".bundle" | "node_modules" | ".git")
                    )
                })
            })
        }));
        let models = packages
            .iter()
            .find(|package| package.import_path == "blog/models")
            .expect("models");
        assert!(models.files.iter().any(|file| {
            file.module_suffix == "user"
                && file.symbols.iter().any(|symbol| symbol.name == "Accounts")
                && file.symbols.iter().any(|symbol| symbol.name == "User")
                && file
                    .symbols
                    .iter()
                    .any(|symbol| symbol.name == "user_label")
                && file.symbols.iter().all(|symbol| symbol.name != "name")
        }));
        let controllers = packages
            .iter()
            .find(|package| package.import_path == "blog/controllers")
            .expect("controllers");
        assert!(controllers.files.iter().any(|file| {
            file.imports
                .iter()
                .any(|item| item.relative && item.path == "../models/user")
                && file
                    .symbols
                    .iter()
                    .any(|symbol| symbol.name == "UsersController")
                && file.symbols.iter().all(|symbol| symbol.name != "index")
        }));
        assert!(packages
            .iter()
            .any(|package| package.import_path == "blog/lib"));
        assert!(packages
            .iter()
            .any(|package| package.import_path == "blog/config"));
    }

    #[test]
    fn rails_gem_maps_models_and_plain_gemfile_keeps_directories() {
        let rails_root = temporary_directory("rails");
        fs::create_dir_all(rails_root.join("app/models")).expect("models");
        fs::write(rails_root.join("Gemfile"), "gem \"rails\", \"~> 7\"\n").expect("gemfile");
        fs::write(rails_root.join("app/models/user.rb"), "class User\nend\n").expect("user");
        let rails_packages = discover_ruby_packages(&rails_root).expect("rails");
        let gem_name = rails_root
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        assert!(rails_packages
            .iter()
            .any(|package| package.import_path == format!("{gem_name}/models")));
        assert!(rails_packages
            .iter()
            .all(|package| !package.import_path.contains("/app/")));
        fs::remove_dir_all(&rails_root).expect("cleanup rails");

        let plain = temporary_directory("plain");
        fs::create_dir_all(plain.join("app/models")).expect("models");
        fs::write(plain.join("Gemfile"), "source \"https://rubygems.org\"\n").expect("gemfile");
        fs::write(plain.join("app/models/user.rb"), "class User\nend\n").expect("user");
        let plain_packages = discover_ruby_packages(&plain).expect("plain");
        let plain_name = plain.file_name().unwrap().to_string_lossy().into_owned();
        assert!(plain_packages
            .iter()
            .any(|package| package.import_path == format!("{plain_name}/app/models")));
        fs::remove_dir_all(&plain).expect("cleanup plain");
    }

    #[test]
    fn skipped_ruby_directories_are_not_discovered() {
        let root = temporary_directory("skip");
        fs::create_dir_all(&root).expect("root");
        fs::write(root.join("Gemfile"), "source \"https://rubygems.org\"\n").expect("gemfile");
        for dir in [
            "vendor",
            "vendor/bundle",
            "node_modules",
            "tmp",
            "log",
            ".bundle",
            ".git",
        ] {
            fs::create_dir_all(root.join(dir)).expect("dir");
            fs::write(root.join(dir).join("nope.rb"), "class Nope\nend\n").expect("rb");
        }
        fs::create_dir_all(root.join("lib")).expect("lib");
        fs::write(root.join("lib/keep.rb"), "class Keep\nend\n").expect("keep");
        let packages = discover_ruby_packages(&root).expect("discover");
        let files: Vec<_> = packages
            .iter()
            .flat_map(|package| package.files.iter())
            .collect();
        assert_eq!(files.len(), 1);
        assert!(files[0].path.ends_with("keep.rb"));
        fs::remove_dir_all(&root).expect("cleanup");
    }

    #[test]
    fn gemfile_alone_extracts_ruby_blocks_and_require_edges() {
        let root = fixture_root();
        let packages = discover_ruby_packages(&root).expect("packages");
        let controllers = packages
            .iter()
            .find(|package| package.import_path == "blog/controllers")
            .expect("controllers");
        let controller = controllers
            .files
            .iter()
            .find(|file| file.module_suffix == "users_controller")
            .expect("controller file");
        let resolved = resolve_ruby_require(
            &root,
            &controller.path,
            controller.imports.iter().next().expect("import"),
        );
        assert_eq!(
            resolved
                .expect("resolved user")
                .file_name()
                .and_then(|name| name.to_str()),
            Some("user.rb")
        );
        let map = extract_cargo_map(&root, Some("Ruby Sample")).expect("extract");
        assert!(map.blocks.iter().any(|block| matches!(
            block,
            FactBlock::Workspace(workspace) if workspace.base.source_path.as_deref() == Some("Gemfile")
        )));
        let modules = map
            .blocks
            .iter()
            .filter_map(|block| match block {
                FactBlock::Module(module) if module.language == "ruby" => Some(module),
                _ => None,
            })
            .collect::<Vec<_>>();
        let controller_block = modules
            .iter()
            .find(|module| module.module_path == "blog/controllers/users_controller")
            .expect("controller block");
        let user_file = modules
            .iter()
            .find(|module| module.module_path == "blog/models/user")
            .expect("user file");
        assert!(modules
            .iter()
            .any(|module| module.module_path == "blog/models/user.User"
                && module.cfg_attributes == ["class".to_owned()]));
        assert!(modules
            .iter()
            .any(|module| module.module_path == "blog/models/user.user_label"));
        assert!(modules
            .iter()
            .all(|module| module.module_path != "blog/models/user.name"));
        assert!(map.connections.iter().any(|connection| {
            matches!(
                connection,
                crate::facts::Connection::DependsOn { source, target, .. }
                    if source == &controller_block.base.id && target == &user_file.base.id
            )
        }));
        let workspace = map.blocks.iter().find_map(|block| match block {
            FactBlock::Workspace(workspace) => Some(workspace),
            _ => None,
        });
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
                inputs.push(format!("ruby:{}:{base}:{hash}", package.import_path));
            }
        }
        inputs.sort();
        assert!(inputs
            .iter()
            .any(|line| line.starts_with("ruby:blog/models:user.rb:")
                && line.len() == "ruby:blog/models:user.rb:".len() + 64));
        assert!(inputs
            .iter()
            .any(|line| line.starts_with("ruby:blog/controllers:users_controller.rb:")));
        let expected = format!("{:x}", Sha256::digest(inputs.join("\n").as_bytes()));
        assert_eq!(
            workspace.expect("workspace").base.fingerprint.as_str(),
            expected.as_str()
        );
    }
}
