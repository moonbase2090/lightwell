use lightwell_core::extract_cargo_map;
use std::env;
use std::error::Error;
use std::ffi::{OsStr, OsString};
use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::path::PathBuf;
use std::process::ExitCode;

const USAGE: &str =
    "Usage:\n  lightwell extract <repository> -o <facts.json> [--name <label>]\n  lightwell help";

enum Invocation {
    Help,
    Extract(ExtractOptions),
}

struct ExtractOptions {
    repository_path: PathBuf,
    output_path: PathBuf,
    project_name: Option<String>,
}

fn main() -> ExitCode {
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
