use crate::metadata::CargoDiscoveryError;
use crate::path_confinement::{confined_canonical, opened_root};
use std::collections::HashSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct TypeScriptModule {
    pub name: String,
    pub path: PathBuf,
    pub unreadable: bool,
    pub imports: Vec<TypeScriptImport>,
    pub symbols: Vec<TypeScriptSymbol>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct TypeScriptImport {
    pub line: usize,
    pub statement: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum TypeScriptSymbolKind {
    Function,
    Class,
    Interface,
    Type,
    Const,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct TypeScriptSymbol {
    pub name: String,
    pub kind: TypeScriptSymbolKind,
    pub line: usize,
}

impl TypeScriptSymbol {
    pub(crate) fn outline_label(&self) -> &'static str {
        match self.kind {
            TypeScriptSymbolKind::Function => "function",
            TypeScriptSymbolKind::Class => "class",
            TypeScriptSymbolKind::Interface => "interface",
            TypeScriptSymbolKind::Type => "type",
            TypeScriptSymbolKind::Const => "const",
        }
    }
}

pub(crate) fn discover_typescript_modules(
    repository_path: &Path,
) -> Result<Vec<TypeScriptModule>, CargoDiscoveryError> {
    let canonical_root = opened_root(repository_path)?;
    let mut files = Vec::new();
    let mut seen = HashSet::new();
    walk_typescript_files(repository_path, &canonical_root, &mut seen, &mut files)?;
    let mut modules = files
        .into_iter()
        .map(|path| module_from_file(repository_path, &path))
        .collect::<Result<Vec<_>, _>>()?;
    modules.sort_by(|left, right| left.name.cmp(&right.name).then(left.path.cmp(&right.path)));
    Ok(modules)
}

pub(crate) fn parse_typescript_source(
    source: &str,
) -> (Vec<TypeScriptImport>, Vec<TypeScriptSymbol>) {
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
        if state.block_comment {
            if line.contains("*/") {
                state.block_comment = false;
            }
            continue;
        }
        if state.quote.is_some() {
            scan_line(line, &mut state);
            continue;
        }
        if !scan_balanced(&state) || continued {
            logical.push('\n');
            logical.push_str(line);
            continued = scan_line(line, &mut state);
            if scan_balanced(&state) && state.quote.is_none() && !state.block_comment && !continued
            {
                classify(&logical, logical_line, &mut imports, &mut symbols);
                logical.clear();
            }
            continue;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with("//") {
            continue;
        }
        if line.len() != trimmed.len() {
            continue;
        }
        logical.clear();
        logical.push_str(line);
        logical_line = line_no;
        continued = scan_line(line, &mut state);
        if scan_balanced(&state) && state.quote.is_none() && !state.block_comment && !continued {
            classify(&logical, logical_line, &mut imports, &mut symbols);
            logical.clear();
        }
    }
    (imports, symbols)
}

fn module_from_file(root: &Path, path: &Path) -> Result<TypeScriptModule, CargoDiscoveryError> {
    let bytes = fs::read(path).map_err(|source| CargoDiscoveryError::TypeScriptSourceRead {
        path: path.to_owned(),
        source,
    })?;
    let Ok(source) = String::from_utf8(bytes) else {
        return Ok(TypeScriptModule {
            name: module_name(root, path),
            path: path.to_owned(),
            unreadable: true,
            imports: Vec::new(),
            symbols: Vec::new(),
        });
    };
    let (imports, symbols) = parse_typescript_source(&source);
    Ok(TypeScriptModule {
        name: module_name(root, path),
        path: path.to_owned(),
        unreadable: false,
        imports,
        symbols,
    })
}

fn walk_typescript_files(
    directory: &Path,
    root: &Path,
    seen: &mut HashSet<PathBuf>,
    files: &mut Vec<PathBuf>,
) -> Result<(), CargoDiscoveryError> {
    let canonical = match confined_typescript_path(directory, root) {
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
            walk_typescript_files(&path, root, seen, files)?;
            continue;
        }
        if !is_typescript_file(&path) {
            continue;
        }
        if confined_typescript_path(&path, root).is_none() {
            continue;
        }
        files.push(path);
    }
    Ok(())
}

fn confined_typescript_path(path: &Path, root: &Path) -> Option<PathBuf> {
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
    matches!(name, "node_modules" | "target" | "dist")
}

fn is_typescript_file(path: &Path) -> bool {
    let Some(file_name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    if file_name.ends_with(".d.ts") {
        return false;
    }
    matches!(
        path.extension().and_then(|ext| ext.to_str()),
        Some("ts" | "tsx" | "mts" | "cts")
    )
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
        parts.push(stem.to_owned());
    }
    parts.join(".")
}

#[derive(Clone, Copy, PartialEq)]
enum Quote {
    Single,
    Double,
    Backtick,
}

#[derive(Default)]
struct ScanState {
    quote: Option<Quote>,
    block_comment: bool,
    paren: i32,
    bracket: i32,
    brace: i32,
    angle: i32,
}

fn scan_balanced(state: &ScanState) -> bool {
    state.paren == 0 && state.bracket == 0 && state.brace == 0 && state.angle == 0
}

fn scan_line(line: &str, state: &mut ScanState) -> bool {
    let chars = line.chars().collect::<Vec<_>>();
    let mut index = 0;
    while index < chars.len() {
        if state.block_comment {
            if chars[index] == '*' && index + 1 < chars.len() && chars[index + 1] == '/' {
                index += 2;
                state.block_comment = false;
                continue;
            }
            index += 1;
            continue;
        }
        if let Some(quote) = state.quote {
            if quote == Quote::Backtick {
                if chars[index] == '\\' {
                    index += 2;
                    continue;
                }
                if chars[index] == '`' {
                    state.quote = None;
                }
                index += 1;
                continue;
            }
            if closes_quote(&chars, index, quote) {
                index += 1;
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
        if chars[index] == '/' && index + 1 < chars.len() {
            if chars[index + 1] == '/' {
                break;
            }
            if chars[index + 1] == '*' {
                index += 2;
                state.block_comment = true;
                continue;
            }
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
            '(' => state.paren += 1,
            ')' => state.paren -= 1,
            '[' => state.bracket += 1,
            ']' => state.bracket -= 1,
            '{' => state.brace += 1,
            '}' => state.brace -= 1,
            '<' => {
                if opens_angle(&chars, index) {
                    state.angle += 1;
                }
            }
            '>' => {
                if !(index > 0 && chars[index - 1] == '-')
                    && !(index + 1 < chars.len() && chars[index + 1] == '=')
                    && state.angle > 0
                {
                    state.angle -= 1;
                    if state.angle > 0 && index + 1 < chars.len() && chars[index + 1] == '>' {
                        state.angle -= 1;
                        index += 1;
                    }
                }
            }
            _ => {}
        }
        index += 1;
    }
    false
}

fn is_ident_part(character: char) -> bool {
    character.is_ascii_alphanumeric() || character == '_' || character == '$'
}

fn opens_angle(chars: &[char], index: usize) -> bool {
    if chars[index] != '<' {
        return false;
    }
    if index + 1 < chars.len() && chars[index + 1] == '=' {
        return false;
    }
    if index + 1 < chars.len() && chars[index + 1] == '<' {
        return false;
    }
    if index + 1 < chars.len() && chars[index + 1] == ' ' {
        return false;
    }
    if index > 0 && chars[index - 1] == '<' {
        return false;
    }
    if index + 1 < chars.len() {
        match chars[index + 1] {
            '+' | '(' | '.' | '!' | '/' => return false,
            _ => {}
        }
    }
    if index + 1 < chars.len() && chars[index + 1].is_ascii_digit() {
        return false;
    }
    if index + 2 < chars.len() && chars[index + 1] == '-' && chars[index + 2].is_ascii_digit() {
        return false;
    }
    if index + 2 < chars.len() && chars[index + 1] == '-' && is_ident_part(chars[index + 2]) {
        return false;
    }
    if index > 0 && (chars[index - 1] == ')' || chars[index - 1] == ']') {
        if index + 1 < chars.len() && is_ident_part(chars[index + 1]) {
            return false;
        }
    }
    if index + 1 < chars.len() && is_ident_part(chars[index + 1]) {
        let mut start = index;
        while start > 0 && is_ident_part(chars[start - 1]) {
            start -= 1;
        }
        if start < index {
            let first = chars[start];
            let next = chars[index + 1];
            let before_value = first.is_ascii_lowercase() || first == '_' || first == '$';
            if before_value
                && (next.is_ascii_lowercase() || next.is_ascii_digit() || next.is_ascii_uppercase())
            {
                return false;
            }
            if first.is_ascii_uppercase() && next.is_ascii_lowercase() {
                return false;
            }
        }
    }
    true
}

fn opens_quote(chars: &[char], index: usize) -> Option<Quote> {
    match chars[index] {
        '\'' => Some(Quote::Single),
        '"' => Some(Quote::Double),
        '`' => Some(Quote::Backtick),
        _ => None,
    }
}

fn closes_quote(chars: &[char], index: usize, quote: Quote) -> bool {
    match quote {
        Quote::Single => chars[index] == '\'' && !escaped(chars, index),
        Quote::Double => chars[index] == '"' && !escaped(chars, index),
        Quote::Backtick => chars[index] == '`' && !escaped(chars, index),
    }
}

fn quote_len(quote: Quote) -> usize {
    match quote {
        Quote::Single | Quote::Double | Quote::Backtick => 1,
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

fn classify(
    line: &str,
    line_no: usize,
    imports: &mut Vec<TypeScriptImport>,
    symbols: &mut Vec<TypeScriptSymbol>,
) {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return;
    }
    if trimmed.starts_with("import ") {
        let statement = trimmed
            .lines()
            .map(str::trim)
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join(" ");
        imports.push(TypeScriptImport {
            line: line_no,
            statement,
        });
        return;
    }
    if let Some(symbol) = parse_export_symbol(trimmed.lines().next().unwrap_or(trimmed)) {
        symbols.push(TypeScriptSymbol {
            name: symbol.0,
            kind: symbol.1,
            line: line_no,
        });
    }
}

fn parse_export_symbol(line: &str) -> Option<(String, TypeScriptSymbolKind)> {
    let mut rest = line.trim();
    if !rest.starts_with("export") {
        return None;
    }
    rest = rest.strip_prefix("export")?.trim_start();
    if rest.starts_with('*') || rest.starts_with('{') {
        return None;
    }
    if let Some(value) = rest.strip_prefix("default") {
        rest = value.trim_start();
    }
    rest = skip_keyword(rest, "declare");
    rest = skip_keyword(rest, "async");
    if let Some(name) = parse_keyword_name(rest, "function", TypeScriptSymbolKind::Function) {
        return Some(name);
    }
    if let Some(name) = parse_keyword_name(rest, "class", TypeScriptSymbolKind::Class) {
        return Some(name);
    }
    if let Some(name) = parse_keyword_name(rest, "interface", TypeScriptSymbolKind::Interface) {
        return Some(name);
    }
    if let Some(name) = parse_keyword_name(rest, "type", TypeScriptSymbolKind::Type) {
        return Some(name);
    }
    if let Some(name) = parse_keyword_name(rest, "const", TypeScriptSymbolKind::Const) {
        return Some(name);
    }
    None
}

fn skip_keyword<'a>(rest: &'a str, keyword: &str) -> &'a str {
    rest.strip_prefix(keyword)
        .map(|value| value.trim_start())
        .unwrap_or(rest)
}

fn parse_keyword_name(
    rest: &str,
    keyword: &str,
    kind: TypeScriptSymbolKind,
) -> Option<(String, TypeScriptSymbolKind)> {
    let rest = rest.strip_prefix(keyword)?.trim_start();
    let name = parse_identifier(rest)?;
    Some((name, kind))
}

fn parse_identifier(source: &str) -> Option<String> {
    let source = source.trim_start();
    let mut chars = source.chars();
    let first = chars.next()?;
    if !is_ident_start(first) {
        return None;
    }
    let mut name = String::new();
    name.push(first);
    for character in chars {
        if !is_ident_part(character) {
            break;
        }
        name.push(character);
    }
    Some(name)
}

fn is_ident_start(character: char) -> bool {
    character.is_ascii_alphabetic() || character == '_' || character == '$'
}

#[cfg(test)]
mod tests {
    use super::{discover_typescript_modules, parse_typescript_source, TypeScriptSymbolKind};
    use crate::extract::extract_cargo_map;
    use crate::facts::FactBlock;
    use crate::metadata::CargoDiscoveryError;
    use std::fs;
    use std::io;
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn fixture_root() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/typescript-sample")
    }

    #[test]
    fn fixture_lists_modules_imports_and_top_level_symbols() {
        let modules =
            discover_typescript_modules(&fixture_root()).expect("typescript fixture should parse");
        let lib = modules
            .iter()
            .find(|module| module.name == "lib")
            .expect("lib module");
        assert!(lib.imports.iter().any(|import| {
            import.statement == "import { readFile } from \"node:fs/promises\";"
        }));
        assert_eq!(
            lib.symbols
                .iter()
                .map(|symbol| (symbol.name.as_str(), symbol.kind))
                .collect::<Vec<_>>(),
            vec![
                ("loadConfig", TypeScriptSymbolKind::Function),
                ("Widget", TypeScriptSymbolKind::Class),
                ("Options", TypeScriptSymbolKind::Type),
            ]
        );
        let worker = modules
            .iter()
            .find(|module| module.name == "nested.worker")
            .expect("worker module");
        assert_eq!(worker.symbols.len(), 1);
        assert_eq!(worker.symbols[0].name, "run");
        assert_eq!(worker.symbols[0].kind, TypeScriptSymbolKind::Function);
    }

    #[test]
    fn multiline_import_is_kept_together() {
        let source = "import {\n  readFile,\n} from \"node:fs/promises\";\n";
        let (imports, symbols) = parse_typescript_source(source);
        assert_eq!(symbols.len(), 0);
        assert_eq!(imports.len(), 1);
        assert_eq!(
            imports[0].statement,
            "import { readFile, } from \"node:fs/promises\";"
        );
    }

    #[test]
    fn jsx_body_does_not_create_extra_top_level_exports() {
        let source = "\
export function Page() {
  return (
    <div>
export function Fake() {}
    </div>
  );
}
";
        let (_imports, symbols) = parse_typescript_source(source);
        assert_eq!(symbols.len(), 1);
        assert_eq!(symbols[0].name, "Page");
    }

    #[test]
    fn generic_and_arrow_jsx_exports_still_parse() {
        let source = "\
export function List<T>() {}
export const View = () => <div>ok</div>
";
        let (_imports, symbols) = parse_typescript_source(source);
        assert_eq!(
            symbols
                .iter()
                .map(|symbol| symbol.name.as_str())
                .collect::<Vec<_>>(),
            vec!["List", "View"]
        );
    }

    #[test]
    fn nested_generics_and_unspaced_comparisons_parse() {
        let nested = "\
export type Box = Array<Array<string>>;
export function after() {}
";
        let (_imports, symbols) = parse_typescript_source(nested);
        assert_eq!(
            symbols
                .iter()
                .map(|symbol| symbol.name.as_str())
                .collect::<Vec<_>>(),
            vec!["Box", "after"]
        );

        let map = "\
export function make(): Map<string, Array<number>> { return new Map(); }
export function later() {}
";
        let (_imports, symbols) = parse_typescript_source(map);
        assert_eq!(
            symbols
                .iter()
                .map(|symbol| symbol.name.as_str())
                .collect::<Vec<_>>(),
            vec!["make", "later"]
        );

        let unspaced = "\
export const min = a<b ? a : b;
export function next() {}
export const ok = a<b && c<d;
export function tail() {}
export const neg = n<0 ? -1 : 1;
export function afterNeg() {}
for (let i = 0; i<10; i++) {}
export function afterLoop() {}
export const cap = n<LIMIT;
export function afterCap() {}
export const negOne = n<-1 ? 0 : 1;
export function afterNegOne() {}
export const sized = size()<1;
export function afterSized() {}
export const indexed = a[i]<10;
export function afterIndexed() {}
export const underscored = _i<10;
export function afterUnderscore() {}
export const dollar = $n<1;
export function afterDollar() {}
export const upper = N<0;
export function afterUpper() {}
export const callLimit = size()<limit;
export function afterCallLimit() {}
export const indexCount = a[i]<count;
export function afterIndexCount() {}
export const negOffset = n<-offset;
export function afterNegOffset() {}
export const underCount = _i<count;
export function afterUnderCount() {}
export const dollarLimit = $n<limit;
export function afterDollarLimit() {}
export const plusOne = n<+1;
export function afterPlusOne() {}
export const grouped = n<(0);
export function afterGrouped() {}
export const fractional = n<.5;
export function afterFractional() {}
export const notFlag = n<!flag;
export function afterNotFlag() {}
export const jsx = <List<Item>ok</List>;
export function afterJsx() {}
";
        let (_imports, symbols) = parse_typescript_source(unspaced);
        assert_eq!(
            symbols
                .iter()
                .map(|symbol| symbol.name.as_str())
                .collect::<Vec<_>>(),
            vec![
                "min",
                "next",
                "ok",
                "tail",
                "neg",
                "afterNeg",
                "afterLoop",
                "cap",
                "afterCap",
                "negOne",
                "afterNegOne",
                "sized",
                "afterSized",
                "indexed",
                "afterIndexed",
                "underscored",
                "afterUnderscore",
                "dollar",
                "afterDollar",
                "upper",
                "afterUpper",
                "callLimit",
                "afterCallLimit",
                "indexCount",
                "afterIndexCount",
                "negOffset",
                "afterNegOffset",
                "underCount",
                "afterUnderCount",
                "dollarLimit",
                "afterDollarLimit",
                "plusOne",
                "afterPlusOne",
                "grouped",
                "afterGrouped",
                "fractional",
                "afterFractional",
                "notFlag",
                "afterNotFlag",
                "jsx",
                "afterJsx",
            ]
        );
    }

    #[test]
    fn comparison_and_shift_operators_do_not_block_later_exports() {
        let source = "\
export const min = a < b ? a : b;
export function next() {}
const gap = 1 << 2;
export class Tail {}
";
        let (_imports, symbols) = parse_typescript_source(source);
        assert_eq!(
            symbols
                .iter()
                .map(|symbol| symbol.name.as_str())
                .collect::<Vec<_>>(),
            vec!["min", "next", "Tail"]
        );
    }

    #[test]
    fn strings_do_not_create_top_level_symbols() {
        let source = "\
const text = \"export function hidden() {}\";
export function visible() {}
";
        let (_imports, symbols) = parse_typescript_source(source);
        assert_eq!(symbols.len(), 1);
        assert_eq!(symbols[0].name, "visible");
    }

    #[test]
    fn a_leading_bom_keeps_the_first_export() {
        let source = "\u{feff}export function loadConfig() {}\n";
        let (_imports, symbols) = parse_typescript_source(source);
        assert_eq!(symbols.len(), 1);
        assert_eq!(symbols[0].name, "loadConfig");
    }

    #[test]
    fn invalid_utf8_is_an_unresolved_typescript_module() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("lightwell-typescript-utf8-{unique}"));
        fs::create_dir_all(&root).expect("root");
        fs::write(root.join("good.ts"), "export function kept() {}\n").expect("good");
        fs::write(root.join("bad.ts"), [0xff, 0xfe, b'e', b'x']).expect("bad");
        let modules = discover_typescript_modules(&root).expect("discover continues");
        let bad = modules
            .iter()
            .find(|module| module.name == "bad")
            .expect("bad module");
        assert!(bad.unreadable);
        assert!(bad.imports.is_empty());
        assert!(bad.symbols.is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn skipped_paths_and_declaration_files_are_ignored() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("lightwell-typescript-skip-{unique}"));
        fs::create_dir_all(root.join("node_modules/pkg")).expect("node_modules");
        fs::create_dir_all(root.join("target")).expect("target");
        fs::write(root.join("kept.ts"), "export function kept() {}\n").expect("kept");
        fs::write(
            root.join("node_modules/pkg/hidden.ts"),
            "export function hidden() {}\n",
        )
        .expect("hidden");
        fs::write(root.join("types.d.ts"), "export interface Ignored {}\n").expect("d.ts");
        let modules = discover_typescript_modules(&root).expect("discover");
        assert!(modules.iter().any(|module| module.name == "kept"));
        assert!(modules
            .iter()
            .all(|module| module.name != "node_modules.pkg.hidden"));
        assert!(modules.iter().all(|module| module.name != "types"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn extract_includes_typescript_modules_by_default() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("lightwell-typescript-extract-{unique}"));
        fs::create_dir_all(root.join("src")).expect("src");
        fs::write(
            root.join("Cargo.toml"),
            "[package]\nname = \"tshost\"\nversion = \"0.1.0\"\nedition = \"2021\"\n",
        )
        .expect("manifest");
        fs::write(root.join("src/lib.rs"), "pub fn value() -> u8 { 1 }\n").expect("lib");
        fs::write(root.join("src/app.ts"), "export function loadApp() {}\n").expect("app");
        let map = extract_cargo_map(&root, Some("TS Host")).expect("extract");
        let typescript = map
            .blocks
            .iter()
            .filter_map(|block| match block {
                FactBlock::Module(module) if module.language == "typescript" => Some(module),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert!(typescript
            .iter()
            .any(|module| module.module_path == "src.app"));
        assert!(typescript.iter().any(|module| {
            module.module_path == "src.app.loadApp" && module.cfg_attributes == ["function"]
        }));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn typescript_source_read_error_message_is_specific() {
        let read_error = CargoDiscoveryError::TypeScriptSourceRead {
            path: PathBuf::from("src/bad.ts"),
            source: io::Error::new(io::ErrorKind::PermissionDenied, "denied"),
        };
        let message = read_error.to_string();
        assert!(message.contains("TypeScript source"));
        assert!(!message.contains("Rust source"));
    }
}
