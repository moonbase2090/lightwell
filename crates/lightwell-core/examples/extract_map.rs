use lightwell_core::extract_cargo_map;
use std::env;
use std::error::Error;
use std::io;
use std::path::PathBuf;

fn main() -> Result<(), Box<dyn Error>> {
    let mut arguments = env::args_os().skip(1);
    let repository_path = arguments.next().map(PathBuf::from).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "Usage: extract_map <repository> [--name <label>]",
        )
    })?;
    let mut project_name = None;
    while let Some(argument) = arguments.next() {
        if argument == "--name" {
            project_name = Some(arguments.next().ok_or_else(|| {
                io::Error::new(io::ErrorKind::InvalidInput, "--name requires a label")
            })?);
        } else {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("Unexpected argument {}", argument.to_string_lossy()),
            )
            .into());
        }
    }
    let project_name = project_name.as_deref().map(|name| name.to_string_lossy());
    let map = extract_cargo_map(repository_path, project_name.as_deref())?;
    println!("{}", serde_json::to_string_pretty(&map)?);
    Ok(())
}
