use lightwell_core::{
    discover_project_workspace, extract_cargo_map, list_project_notes, open_block,
    remove_project_note, set_project_note, BlockBase, EditorSettings, FactBlock, FactMap,
    MapWatchError, MapWatcher, NotesError,
};
use std::env;
use std::error::Error;
use std::ffi::{OsStr, OsString};
use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

const USAGE: &str = "Usage:\n  lightwell extract <repository> -o <facts.json> [--name <label>]\n  lightwell blocks [--json] [--file <path>]\n  lightwell notes list [--json] [--check]\n  lightwell notes set [--json] <block-id> <text...>\n  lightwell notes set --file <path> [--json] <text...>\n  lightwell notes rm [--json] <block-id>\n  lightwell open <block-id>\n  lightwell watch <repository> [--name <label>]\n  lightwell --version\n  lightwell help";

enum Invocation {
    Help,
    Extract(ExtractOptions),
    Blocks(BlocksOptions),
    Notes(NotesOptions),
    Open(OpenOptions),
    Watch(WatchOptions),
}

struct BlocksOptions {
    json: bool,
    file: Option<String>,
}

enum NotesCommand {
    List { check: bool },
    Set { target: SetTarget, text: String },
    Remove { block_id: String },
}

enum SetTarget {
    BlockId(String),
    File(String),
}

enum NotesOutput {
    Human,
    Json,
}

struct NotesOptions {
    command: NotesCommand,
    output: NotesOutput,
}

struct ExtractOptions {
    repository_path: PathBuf,
    output_path: PathBuf,
    project_name: Option<String>,
}

struct OpenOptions {
    block_id: String,
}

struct WatchOptions {
    repository_path: PathBuf,
    project_name: Option<String>,
}

fn main() -> ExitCode {
    if is_version_request(env::args_os().skip(1)) {
        println!("lightwell {}", env!("CARGO_PKG_VERSION"));
        return ExitCode::SUCCESS;
    }
    match parse_invocation(env::args_os().skip(1)) {
        Ok(Invocation::Help) => {
            println!("{USAGE}");
            ExitCode::SUCCESS
        }
        Ok(Invocation::Extract(options)) => match extract_to_file(options) {
            Ok(()) => ExitCode::SUCCESS,
            Err(error) => {
                eprintln!("lightwell: {error}");
                ExitCode::FAILURE
            }
        },
        Ok(Invocation::Blocks(options)) => match run_blocks_command(options) {
            Ok(exit) => exit,
            Err(error) => {
                eprintln!("lightwell: {error}");
                ExitCode::FAILURE
            }
        },
        Ok(Invocation::Notes(options)) => match run_notes_command(options) {
            Ok(exit) => exit,
            Err(error) => {
                eprintln!("lightwell: {error}");
                match error.downcast_ref::<NotesError>() {
                    Some(NotesError::NoteNotFound(_)) => ExitCode::from(3),
                    Some(NotesError::BlockNotFound(_)) => ExitCode::from(4),
                    _ => ExitCode::FAILURE,
                }
            }
        },
        Ok(Invocation::Open(options)) => match open_block_in_editor(options) {
            Ok(()) => ExitCode::SUCCESS,
            Err(error) => {
                eprintln!("lightwell: {error}");
                ExitCode::FAILURE
            }
        },
        Ok(Invocation::Watch(options)) => match watch_to_stdout(options) {
            Ok(()) => ExitCode::SUCCESS,
            Err(error) => {
                eprintln!("lightwell: {error}");
                ExitCode::FAILURE
            }
        },
        Err(error) => {
            eprintln!("lightwell: {error}\n\n{USAGE}");
            ExitCode::from(2)
        }
    }
}

fn parse_invocation(mut arguments: impl Iterator<Item = OsString>) -> Result<Invocation, String> {
    let Some(command) = arguments.next() else {
        return Ok(Invocation::Help);
    };
    if is_help(&command) {
        return Ok(Invocation::Help);
    }
    if command == OsStr::new("blocks") {
        return parse_blocks_command(arguments);
    }
    if command == OsStr::new("notes") {
        return parse_notes_command(arguments);
    }
    if command == OsStr::new("open") {
        return parse_open(arguments);
    }
    if command == OsStr::new("watch") {
        return parse_watch(arguments);
    }
    if command != OsStr::new("extract") {
        return Err(format!("unknown command `{}`", command.to_string_lossy()));
    }

    let mut repository_path = None;
    let mut output_path = None;
    let mut project_name = None;
    while let Some(argument) = arguments.next() {
        if is_help(&argument) {
            return Ok(Invocation::Help);
        }
        if argument == OsStr::new("-o") || argument == OsStr::new("--output") {
            if output_path.is_some() {
                return Err("the output option may appear only once".to_owned());
            }
            output_path = Some(PathBuf::from(required_value(&mut arguments, "-o")?));
        } else if argument == OsStr::new("--name") {
            if project_name.is_some() {
                return Err("the --name option may appear only once".to_owned());
            }
            let name = required_value(&mut arguments, "--name")?;
            project_name = Some(
                name.into_string()
                    .map_err(|_| "the project name must use UTF-8".to_owned())?,
            );
        } else if argument.to_string_lossy().starts_with('-') {
            return Err(format!("unknown option `{}`", argument.to_string_lossy()));
        } else if repository_path.is_none() {
            repository_path = Some(PathBuf::from(argument));
        } else {
            return Err(format!(
                "unexpected argument `{}`",
                argument.to_string_lossy()
            ));
        }
    }

    let repository_path =
        repository_path.ok_or_else(|| "the repository path is required".to_owned())?;
    let output_path = output_path.ok_or_else(|| "the output path is required".to_owned())?;
    Ok(Invocation::Extract(ExtractOptions {
        repository_path,
        output_path,
        project_name,
    }))
}

fn parse_notes_command(
    mut arguments: impl Iterator<Item = OsString>,
) -> Result<Invocation, String> {
    let Some(subcommand) = arguments.next() else {
        return Err("a notes command is required".to_owned());
    };
    if is_help(&subcommand) {
        return Ok(Invocation::Help);
    }

    let mut json = false;
    let mut check = false;
    let mut file: Option<String> = None;
    let mut parse_options = true;
    let mut positional = Vec::new();
    while let Some(argument) = arguments.next() {
        if parse_options && argument == OsStr::new("--") {
            parse_options = false;
        } else if parse_options && argument == OsStr::new("--json") {
            if json {
                return Err("the --json option may appear only once".to_owned());
            }
            json = true;
        } else if parse_options && argument == OsStr::new("--check") {
            if check {
                return Err("the --check option may appear only once".to_owned());
            }
            check = true;
        } else if parse_options && argument == OsStr::new("--file") {
            if file.is_some() {
                return Err("the --file option may appear only once".to_owned());
            }
            let value = arguments
                .next()
                .ok_or_else(|| "the --file option requires a path".to_owned())?
                .into_string()
                .map_err(|_| "the --file path must use UTF-8".to_owned())?;
            if value.is_empty() {
                return Err("the --file option requires a path".to_owned());
            }
            file = Some(value);
        } else if parse_options
            && (argument == OsStr::new("--help") || argument == OsStr::new("-h"))
        {
            return Ok(Invocation::Help);
        } else if parse_options && argument.to_string_lossy().starts_with('-') {
            return Err(format!("unknown option `{}`", argument.to_string_lossy()));
        } else {
            positional.push(argument);
        }
    }
    if check && subcommand != OsStr::new("list") {
        return Err("--check is only available for `lightwell notes list`".to_owned());
    }
    if file.is_some() && subcommand != OsStr::new("set") {
        return Err("--file is only available for `lightwell notes set`".to_owned());
    }
    let mut arguments = positional.into_iter();
    let command = if subcommand == OsStr::new("list") {
        if arguments.next().is_some() {
            return Err("`lightwell notes list` takes no arguments".to_owned());
        }
        NotesCommand::List { check }
    } else if subcommand == OsStr::new("set") {
        let target = match file {
            Some(path) => SetTarget::File(path),
            None => SetTarget::BlockId(required_utf8(&mut arguments, "a block ID")?),
        };
        let text = arguments
            .map(|part| {
                part.into_string()
                    .map_err(|_| "note text must use UTF-8".to_owned())
            })
            .collect::<Result<Vec<_>, _>>()?
            .join(" ");
        if text.is_empty() {
            return Err("`lightwell notes set` requires note text".to_owned());
        }
        NotesCommand::Set { target, text }
    } else if subcommand == OsStr::new("rm") {
        let block_id = required_utf8(&mut arguments, "a block ID")?;
        if arguments.next().is_some() {
            return Err("`lightwell notes rm` takes one block ID".to_owned());
        }
        NotesCommand::Remove { block_id }
    } else {
        return Err(format!(
            "unknown notes command `{}`",
            subcommand.to_string_lossy()
        ));
    };

    Ok(Invocation::Notes(NotesOptions {
        command,
        output: if json {
            NotesOutput::Json
        } else {
            NotesOutput::Human
        },
    }))
}

fn required_utf8(
    arguments: &mut impl Iterator<Item = OsString>,
    description: &str,
) -> Result<String, String> {
    arguments
        .next()
        .ok_or_else(|| format!("{description} is required"))?
        .into_string()
        .map_err(|_| format!("{description} must use UTF-8"))
}

fn run_notes_command(options: NotesOptions) -> Result<ExitCode, Box<dyn Error>> {
    let repository = env::current_dir()?;
    match options.command {
        NotesCommand::List { check } => {
            let notes = list_project_notes(repository)?;
            let stale_count = notes.iter().filter(|note| note.stale).count();
            match options.output {
                NotesOutput::Json => write_notes_json(serde_json::to_value(&notes)?)?,
                NotesOutput::Human => {
                    if notes.is_empty() {
                        println!(
                            "No project notes. Save one with `lightwell notes set <block-id> <text...>`."
                        );
                    }
                    for note in notes {
                        let status = if note.stale { "stale" } else { "current" };
                        println!(
                            "[{status}] {} (source fingerprint {}; author {}; updated {}): {}",
                            note.block_id,
                            note.source_fingerprint,
                            note.author,
                            note.updated_at,
                            note.text
                        );
                    }
                }
            }
            if check && stale_count > 0 {
                let noun = if stale_count == 1 { "note" } else { "notes" };
                eprintln!("lightwell: {stale_count} stale project {noun} found.");
                return Ok(ExitCode::from(5));
            }
        }
        NotesCommand::Set { target, text } => {
            let block_id = match target {
                SetTarget::BlockId(block_id) => block_id,
                SetTarget::File(path) => {
                    let (root, map) = current_workspace_map(&repository)?;
                    match resolve_file_block(&root, &map, &path) {
                        FileResolution::Unique(block_id) => block_id,
                        FileResolution::None => {
                            eprintln!("lightwell: No block for file `{path}`.");
                            for candidate in suggested_paths(&map, &path) {
                                eprintln!("lightwell: Did you mean `{candidate}`?");
                            }
                            return Ok(ExitCode::from(4));
                        }
                        FileResolution::Ambiguous(matches) => {
                            eprintln!(
                                "lightwell: File `{path}` matches {} blocks. Choose a block ID:",
                                matches.len()
                            );
                            for candidate in matches {
                                eprintln!("lightwell:   `{candidate}`");
                            }
                            return Ok(ExitCode::from(2));
                        }
                    }
                }
            };
            let note = match set_project_note(&repository, &block_id, &text) {
                Ok(note) => note,
                Err(error) => {
                    if let NotesError::BlockNotFound(_) = error {
                        eprintln!("lightwell: {error}");
                        if let Ok((_, map)) = current_workspace_map(&repository) {
                            for candidate in suggested_blocks(&map, &block_id) {
                                eprintln!("lightwell: Did you mean `{candidate}`?");
                            }
                        }
                        return Ok(ExitCode::from(4));
                    }
                    return Err(error.into());
                }
            };
            match options.output {
                NotesOutput::Human => {
                    println!("Saved note for `{block_id}` in `.lightwell/notes.json`.");
                }
                NotesOutput::Json => {
                    // Use the note returned from the write's extraction — do not
                    // re-extract via list_project_notes for JSON metadata.
                    write_notes_json(serde_json::json!({
                        "blockId": note.block_id,
                        "text": note.text,
                        "author": note.author,
                        "updatedAt": note.updated_at,
                    }))?;
                }
            }
        }
        NotesCommand::Remove { block_id } => {
            if !remove_project_note(repository, &block_id)? {
                return Err(NotesError::NoteNotFound(block_id).into());
            }
            match options.output {
                NotesOutput::Human => println!("Removed note for `{block_id}`."),
                NotesOutput::Json => write_notes_json(serde_json::json!({
                    "blockId": block_id,
                    "removed": true,
                }))?,
            }
        }
    }
    Ok(ExitCode::SUCCESS)
}

fn write_notes_json(value: serde_json::Value) -> Result<(), Box<dyn Error>> {
    let stdout = std::io::stdout();
    let mut output = BufWriter::new(stdout.lock());
    serde_json::to_writer(&mut output, &value)?;
    output.write_all(b"\n")?;
    output.flush()?;
    Ok(())
}

fn parse_blocks_command(
    mut arguments: impl Iterator<Item = OsString>,
) -> Result<Invocation, String> {
    let mut json = false;
    let mut file: Option<String> = None;
    while let Some(argument) = arguments.next() {
        if is_help(&argument) {
            return Ok(Invocation::Help);
        }
        if argument == OsStr::new("--json") {
            if json {
                return Err("the --json option may appear only once".to_owned());
            }
            json = true;
        } else if argument == OsStr::new("--file") {
            if file.is_some() {
                return Err("the --file option may appear only once".to_owned());
            }
            let value = arguments
                .next()
                .ok_or_else(|| "the --file option requires a path".to_owned())?
                .into_string()
                .map_err(|_| "the --file path must use UTF-8".to_owned())?;
            if value.is_empty() {
                return Err("the --file option requires a path".to_owned());
            }
            file = Some(value);
        } else if argument.to_string_lossy().starts_with('-') {
            return Err(format!("unknown option `{}`", argument.to_string_lossy()));
        } else {
            return Err(format!(
                "unexpected argument `{}`",
                argument.to_string_lossy()
            ));
        }
    }
    Ok(Invocation::Blocks(BlocksOptions { json, file }))
}

fn run_blocks_command(options: BlocksOptions) -> Result<ExitCode, Box<dyn Error>> {
    let repository = env::current_dir()?;
    let (root, map) = current_workspace_map(&repository)?;
    let wanted = options
        .file
        .as_deref()
        .map(|path| normalized_workspace_path(&root, path));
    let blocks = block_views(&map)
        .into_iter()
        .filter(|block| {
            wanted.as_deref().is_none_or(|path| {
                block
                    .source_path
                    .as_deref()
                    .is_some_and(|source| normalized_source_path(source) == path)
            })
        })
        .collect::<Vec<_>>();
    if options.json {
        let values = blocks
            .iter()
            .map(|block| {
                serde_json::json!({
                    "blockId": block.id,
                    "label": block.label,
                    "kind": block.kind,
                    "sourcePath": block.source_path,
                    "parentId": block.parent_id,
                })
            })
            .collect::<Vec<_>>();
        write_notes_json(serde_json::Value::Array(values))?;
    } else {
        for block in blocks {
            println!(
                "{}\t{}\t{}\t{}",
                block.id,
                block.label,
                block.kind,
                block.source_path.as_deref().unwrap_or("-")
            );
        }
    }
    Ok(ExitCode::SUCCESS)
}

fn current_workspace_map(repository: &Path) -> Result<(PathBuf, FactMap), Box<dyn Error>> {
    let root = discover_project_workspace(repository)?.root;
    let map = extract_cargo_map(repository, None)?;
    Ok((root, map))
}

struct BlockView {
    id: String,
    label: String,
    kind: &'static str,
    source_path: Option<String>,
    parent_id: Option<String>,
}

fn block_views(map: &FactMap) -> Vec<BlockView> {
    map.blocks
        .iter()
        .map(|block| {
            let (kind, base) = block_kind_and_base(block);
            BlockView {
                id: base.id.clone(),
                label: base.label.clone(),
                kind,
                source_path: base.source_path.clone(),
                parent_id: base.parent_id.clone(),
            }
        })
        .collect()
}

fn block_kind_and_base(block: &FactBlock) -> (&'static str, &BlockBase) {
    match block {
        FactBlock::Workspace(block) => ("workspace", &block.base),
        FactBlock::Crate(block) => ("crate", &block.base),
        FactBlock::App(block) => ("app", &block.base),
        FactBlock::Module(block) => ("module", &block.base),
        FactBlock::CargoFeature(block) => ("cargo_feature", &block.base),
    }
}

enum FileResolution {
    Unique(String),
    None,
    Ambiguous(Vec<String>),
}

fn resolve_file_block(root: &Path, map: &FactMap, file: &str) -> FileResolution {
    let wanted = normalized_workspace_path(root, file);
    let matches = block_views(map)
        .into_iter()
        .filter(|block| {
            block
                .source_path
                .as_deref()
                .is_some_and(|source| normalized_source_path(source) == wanted)
        })
        .map(|block| block.id)
        .collect::<Vec<_>>();
    match matches.len() {
        0 => FileResolution::None,
        1 => FileResolution::Unique(matches.into_iter().next().unwrap()),
        _ => FileResolution::Ambiguous(matches),
    }
}

fn normalized_workspace_path(root: &Path, file: &str) -> String {
    let path = Path::new(file);
    if let (Ok(canonical_root), Ok(canonical_file)) =
        (fs::canonicalize(root), fs::canonicalize(path))
    {
        if let Ok(relative) = canonical_file.strip_prefix(&canonical_root) {
            return normalized_source_path(&relative.to_string_lossy());
        }
    }
    let joined = if path.is_absolute() {
        path.to_path_buf()
    } else {
        root.join(path)
    };
    let normalized = normalize_path_components(&joined);
    let canonical_root = fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    for base in [
        normalize_path_components(&canonical_root),
        normalize_path_components(root),
    ] {
        if let Ok(relative) = normalized.strip_prefix(&base) {
            return normalized_source_path(&relative.to_string_lossy());
        }
    }
    if path.is_absolute() {
        normalized_source_path(file)
    } else {
        normalized_source_path(&normalize_path_components(path).to_string_lossy())
    }
}

fn normalize_path_components(path: &Path) -> PathBuf {
    use std::ffi::OsString;
    use std::path::Component;
    let mut prefix = PathBuf::new();
    let mut parts: Vec<OsString> = Vec::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix_component) => prefix.push(prefix_component.as_os_str()),
            Component::RootDir => prefix.push(std::path::MAIN_SEPARATOR.to_string()),
            Component::CurDir => {}
            Component::ParentDir => {
                if parts.last().is_some_and(|part| part != "..") {
                    parts.pop();
                } else if !path.is_absolute() {
                    parts.push(OsString::from(".."));
                }
            }
            Component::Normal(part) => parts.push(part.to_os_string()),
        }
    }
    let mut normalized = prefix;
    for part in parts {
        normalized.push(part);
    }
    normalized
}

fn normalized_source_path(path: &str) -> String {
    path.replace('\\', "/").trim_start_matches("./").to_owned()
}

fn suggested_blocks(map: &FactMap, query: &str) -> Vec<String> {
    let query = query.to_ascii_lowercase();
    let mut suggested: Vec<String> = Vec::new();
    for tier in 0..3 {
        let mut in_tier = block_views(map)
            .into_iter()
            .filter(|block| {
                let id = block.id.to_ascii_lowercase();
                let label = block.label.to_ascii_lowercase();
                match tier {
                    0 => id == query || label == query,
                    1 => id.contains(&query) || label.contains(&query),
                    _ => {
                        edit_distance(&label, &query) <= 2
                            || id
                                .rsplit("::")
                                .next()
                                .is_some_and(|tail| edit_distance(tail, &query) <= 2)
                    }
                }
            })
            .map(|block| block.id)
            .filter(|id| !suggested.contains(id))
            .collect::<Vec<_>>();
        in_tier.sort();
        suggested.extend(in_tier);
        if suggested.len() >= 3 {
            break;
        }
    }
    suggested.truncate(3);
    suggested
}

fn suggested_paths(map: &FactMap, file: &str) -> Vec<String> {
    let wanted = normalized_source_path(file);
    let wanted_name = wanted.rsplit('/').next().unwrap_or(&wanted);
    let mut paths = block_views(map)
        .into_iter()
        .filter_map(|block| block.source_path)
        .map(|source| normalized_source_path(&source))
        .filter(|source| {
            source.rsplit('/').next() == Some(wanted_name)
                || source.ends_with(&format!("/{wanted}"))
        })
        .collect::<Vec<_>>();
    paths.sort();
    paths.dedup();
    paths.truncate(3);
    paths
}

fn edit_distance(left: &str, right: &str) -> usize {
    let left: Vec<char> = left.chars().collect();
    let right: Vec<char> = right.chars().collect();
    let mut previous: Vec<usize> = (0..=right.len()).collect();
    for (i, left_char) in left.iter().enumerate() {
        let mut current = vec![i + 1];
        for (j, right_char) in right.iter().enumerate() {
            let substitution = previous[j] + usize::from(left_char != right_char);
            current.push(substitution.min(previous[j + 1] + 1).min(current[j] + 1));
        }
        previous = current;
    }
    previous[right.len()]
}

fn parse_open(mut arguments: impl Iterator<Item = OsString>) -> Result<Invocation, String> {
    let Some(block_id) = arguments.next() else {
        return Err("the block ID is required".to_owned());
    };
    if is_help(&block_id) {
        return Ok(Invocation::Help);
    }
    let block_id = block_id
        .into_string()
        .map_err(|_| "the block ID must use UTF-8".to_owned())?;
    if let Some(argument) = arguments.next() {
        return Err(format!(
            "unexpected argument `{}`",
            argument.to_string_lossy()
        ));
    }
    Ok(Invocation::Open(OpenOptions { block_id }))
}

fn parse_watch(mut arguments: impl Iterator<Item = OsString>) -> Result<Invocation, String> {
    let mut repository_path = None;
    let mut project_name = None;
    while let Some(argument) = arguments.next() {
        if is_help(&argument) {
            return Ok(Invocation::Help);
        }
        if argument == OsStr::new("--name") {
            if project_name.is_some() {
                return Err("the --name option may appear only once".to_owned());
            }
            let name = required_value(&mut arguments, "--name")?;
            project_name = Some(
                name.into_string()
                    .map_err(|_| "the project name must use UTF-8".to_owned())?,
            );
        } else if argument.to_string_lossy().starts_with('-') {
            return Err(format!("unknown option `{}`", argument.to_string_lossy()));
        } else if repository_path.is_none() {
            repository_path = Some(PathBuf::from(argument));
        } else {
            return Err(format!(
                "unexpected argument `{}`",
                argument.to_string_lossy()
            ));
        }
    }

    Ok(Invocation::Watch(WatchOptions {
        repository_path: repository_path
            .ok_or_else(|| "the repository path is required".to_owned())?,
        project_name,
    }))
}

fn is_version_request(mut arguments: impl Iterator<Item = OsString>) -> bool {
    match (arguments.next(), arguments.next()) {
        (Some(argument), None) => {
            argument == OsStr::new("--version") || argument == OsStr::new("-V")
        }
        _ => false,
    }
}

fn is_help(argument: &OsStr) -> bool {
    argument == OsStr::new("help")
        || argument == OsStr::new("--help")
        || argument == OsStr::new("-h")
}

fn required_value(
    arguments: &mut impl Iterator<Item = OsString>,
    option: &str,
) -> Result<OsString, String> {
    arguments
        .next()
        .ok_or_else(|| format!("{option} requires a value"))
}

fn extract_to_file(options: ExtractOptions) -> Result<(), Box<dyn Error>> {
    let map = extract_cargo_map(&options.repository_path, options.project_name.as_deref())?;
    if let Some(parent) = options
        .output_path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        fs::create_dir_all(parent)?;
    }

    let mut output = BufWriter::new(File::create(&options.output_path)?);
    serde_json::to_writer_pretty(&mut output, &map)?;
    output.write_all(b"\n")?;
    output.flush()?;
    println!(
        "Wrote {} blocks and {} connections to {}",
        map.stats.blocks,
        map.stats.connections,
        options.output_path.display()
    );
    Ok(())
}

fn open_block_in_editor(options: OpenOptions) -> Result<(), Box<dyn Error>> {
    let repository_path = env::current_dir()?;
    let command_template = env::var("LIGHTWELL_EDITOR_TEMPLATE")
        .ok()
        .filter(|template| !template.trim().is_empty());
    open_block(
        repository_path,
        &options.block_id,
        &EditorSettings { command_template },
    )?;
    println!("Opened source for block {}.", options.block_id);
    Ok(())
}

fn watch_to_stdout(options: WatchOptions) -> Result<(), Box<dyn Error>> {
    let mut watcher = MapWatcher::new(&options.repository_path, options.project_name.as_deref())?;
    let stdout = std::io::stdout();
    let mut output = BufWriter::new(stdout.lock());
    write_map(&mut output, watcher.current_map())?;
    loop {
        match watcher.next_changed_map() {
            Ok(map) => write_map(&mut output, &map)?,
            Err(error @ MapWatchError::Extraction(_)) => eprintln!("lightwell: {error}"),
            Err(error) => return Err(Box::new(error)),
        }
    }
}

fn write_map(output: &mut impl Write, map: &lightwell_core::FactMap) -> Result<(), std::io::Error> {
    serde_json::to_writer(&mut *output, map).map_err(std::io::Error::other)?;
    output.write_all(b"\n")?;
    output.flush()
}
