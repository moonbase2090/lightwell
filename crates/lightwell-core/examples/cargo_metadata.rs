use lightwell_core::discover_cargo_workspace;
use std::env;
use std::error::Error;
use std::path::PathBuf;

fn main() -> Result<(), Box<dyn Error>> {
    let repository_path = env::args_os()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    let workspace = discover_cargo_workspace(repository_path)?;

    println!(
        "{}: {} workspace package(s)",
        workspace.root.display(),
        workspace.packages.len()
    );
    for package in workspace.packages {
        println!(
            "{} {}: {} target(s), {} feature(s), {} dependency(ies)",
            package.name,
            package.version,
            package.targets.len(),
            package.features.len(),
            package.dependencies.len()
        );
        for target in package.targets {
            println!(
                "  {} [{}] {}",
                target.name,
                target.kind.join(", "),
                target.source_path.display()
            );
        }
    }

    Ok(())
}
