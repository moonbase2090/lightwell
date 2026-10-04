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
            "{} {} {}: {} target(s)",
            package.name,
            package.version,
            package.description.as_deref().unwrap_or("<no description>"),
            package.targets.len()
        );
        for feature in &package.features {
            println!("  feature {feature}");
        }
        for dependency in &package.dependencies {
            let kind = match dependency.kind {
                lightwell_core::CargoDependencyKind::Normal => "normal",
                lightwell_core::CargoDependencyKind::Build => "build",
                lightwell_core::CargoDependencyKind::Dev => "dev",
            };
            let path = dependency.path.as_ref().map_or_else(
                || "<registry>".to_owned(),
                |path| path.display().to_string(),
            );
            println!("  dependency {kind} {}: {path}", dependency.name);
        }
        for target in package.targets {
            println!(
                "  {} [{}] {}: {} module(s)",
                target.name,
                target.kind.join(", "),
                target.source_path.display(),
                target.modules.len()
            );
            for module in &target.modules {
                print_module(module, 4);
            }
        }
    }

    Ok(())
}

fn print_module(module: &lightwell_core::RustModule, indentation: usize) {
    let padding = " ".repeat(indentation);
    let attributes = if module.attributes.is_empty() {
        String::new()
    } else {
        format!(" {}", module.attributes.join(" "))
    };
    let source_path = module.source_path.as_ref().map_or_else(
        || "unresolved".to_owned(),
        |path| path.display().to_string(),
    );
    println!("{padding}mod {}{attributes}: {source_path}", module.name);
    for child in &module.children {
        print_module(child, indentation + 2);
    }
}
