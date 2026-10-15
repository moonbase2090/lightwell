use lightwell_core::{
    extract_cargo_map, list_project_notes, open_block, remove_project_note, set_project_note,
    EditorSettings, MapWatchError, MapWatcher,
};
use std::env;
use std::error::Error;
use std::ffi::{OsStr, OsString};
use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::path::PathBuf;
use std::process::ExitCode;

const USAGE: &str = "Usage:\n  lightwell extract <repository> -o <facts.json> [--name <label>]\n  lightwell notes list\n  lightwell notes set <block-id> <text...>\n  lightwell notes rm <block-id>\n  lightwell open <block-id>\n  lightwell watch <repository> [--name <label>]\n  lightwell --version\n  lightwell help";

enum Invocation {
    Help,
    Extract(ExtractOptions),
    Notes(NotesCommand),
    Open(OpenOptions),
    Watch(WatchOptions),
}

enum NotesCommand {
    List,
    Set { block_id: String, text: String },
    Remove { block_id: String },
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
        Ok(Invocation::Notes(command)) => match run_notes_command(command) {
            Ok(()) => ExitCode::SUCCESS,
            Err(error) => {
                eprintln!("lightwell: {error}");
                ExitCode::FAILURE
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

    let command = if subcommand == OsStr::new("list") {
        if arguments.next().is_some() {
            return Err("`lightwell notes list` takes no arguments".to_owned());
        }
        NotesCommand::List
    } else if subcommand == OsStr::new("set") {
        let block_id = required_utf8(&mut arguments, "a block ID")?;
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
        NotesCommand::Set { block_id, text }
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

    Ok(Invocation::Notes(command))
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

fn run_notes_command(command: NotesCommand) -> Result<(), Box<dyn Error>> {
    let repository = env::current_dir()?;
    match command {
        NotesCommand::List => {
            let notes = list_project_notes(repository)?;
            if notes.is_empty() {
                println!(
                    "No project notes. Save one with `lightwell notes set <block-id> <text...>`."
                );
                return Ok(());
            }
            for note in notes {
                let status = if note.stale { "stale" } else { "current" };
                println!(
                    "[{status}] {} (source fingerprint {}): {}",
                    note.block_id, note.source_fingerprint, note.text
                );
            }
        }
        NotesCommand::Set { block_id, text } => {
            set_project_note(repository, &block_id, &text)?;
            println!("Saved note for `{block_id}` in `.lightwell/notes.json`.");
        }
        NotesCommand::Remove { block_id } => {
            if remove_project_note(repository, &block_id)? {
                println!("Removed note for `{block_id}`.");
            } else {
                println!("No saved note for `{block_id}`.");
            }
        }
    }
    Ok(())
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
