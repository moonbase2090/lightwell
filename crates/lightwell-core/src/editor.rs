use crate::extract::{block_base, map_workspace};
use crate::facts::{FactBlock, ModuleBlock};
use crate::metadata::{CargoTarget, CargoWorkspace, RustModule};
use crate::{discover_cargo_workspace, MapExtractionError};
use serde::{Deserialize, Serialize};
use shell_words::split;
use std::env;
use std::error::Error;
use std::fmt::{Display, Formatter};
use std::num::NonZeroUsize;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};

const FILE_PLACEHOLDER: &str = "{file}";
const LINE_PLACEHOLDER: &str = "{line}";
const COLUMN_PLACEHOLDER: &str = "{column}";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SourcePosition {
    line: NonZeroUsize,
    column: NonZeroUsize,
}

impl SourcePosition {
    pub fn new(line: usize, column: usize) -> Option<Self> {
        Some(Self {
            line: NonZeroUsize::new(line)?,
            column: NonZeroUsize::new(column)?,
        })
    }

    pub fn line(self) -> usize {
        self.line.get()
    }

    pub fn column(self) -> usize {
        self.column.get()
    }

    fn file_start() -> Self {
        Self {
            line: NonZeroUsize::MIN,
            column: NonZeroUsize::MIN,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EditorTarget {
    pub path: PathBuf,
    pub position: SourcePosition,
}

impl EditorTarget {
    pub fn at_file_start(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            position: SourcePosition::file_start(),
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct EditorSettings {
    pub command_template: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorTemplatePreset {
    pub name: &'static str,
    pub template: &'static str,
}

pub const EDITOR_TEMPLATE_PRESETS: &[EditorTemplatePreset] = &[
    EditorTemplatePreset {
        name: "JetBrains IDE",
        template: "idea --line {line} --column {column} {file}",
    },
    EditorTemplatePreset {
        name: "Kiro",
        template: "kiro {file}",
    },
    EditorTemplatePreset {
        name: "Zed",
        template: "zed {file}:{line}:{column}",
    },
    EditorTemplatePreset {
        name: "Visual Studio Code",
        template: "code --goto {file}:{line}:{column}",
    },
    EditorTemplatePreset {
        name: "Cursor",
        template: "cursor {file}",
    },
    EditorTemplatePreset {
        name: "Vim in a Linux terminal",
        template: "x-terminal-emulator -e vim \"+call cursor({line},{column})\" {file}",
    },
];

pub fn open_block(
    repository_path: impl AsRef<Path>,
    block_id: &str,
    settings: &EditorSettings,
) -> Result<(), EditorError> {
    let target = resolve_block_target(repository_path, block_id)?;
    open_target(&target, settings)
}

pub fn resolve_block_target(
    repository_path: impl AsRef<Path>,
    block_id: &str,
) -> Result<EditorTarget, EditorError> {
    let workspace = discover_cargo_workspace(repository_path).map_err(MapExtractionError::from)?;
    let root = workspace.root.clone();
    let map = map_workspace(workspace.clone(), None)?;
    let block = map
        .blocks
        .iter()
        .find(|block| block_base(block).id == block_id)
        .ok_or_else(|| EditorError::BlockNotFound(block_id.to_owned()))?;
    let (source_path, position) = match block {
        FactBlock::Module(module) => {
            let source_path = module
                .base
                .source_path
                .as_deref()
                .unwrap_or(&module.declared_by_path);
            let position = if module.base.source_path.as_deref()
                == Some(module.declared_by_path.as_str())
                || module.base.source_path.is_none()
            {
                module_source_position(&workspace, module)
                    .unwrap_or_else(SourcePosition::file_start)
            } else {
                SourcePosition::file_start()
            };
            (source_path, position)
        }
        _ => (
            block_base(block)
                .source_path
                .as_deref()
                .ok_or_else(|| EditorError::BlockHasNoSource(block_id.to_owned()))?,
            SourcePosition::file_start(),
        ),
    };

    let path = root
        .join(source_path)
        .canonicalize()
        .map_err(|source| EditorError::SourcePath {
            path: root.join(source_path),
            source,
        })?;
    if !path.starts_with(&root) {
        return Err(EditorError::SourceOutsideWorkspace(path));
    }
    Ok(EditorTarget { path, position })
}

fn module_source_position(
    workspace: &CargoWorkspace,
    block: &ModuleBlock,
) -> Option<SourcePosition> {
    workspace
        .packages
        .iter()
        .find(|package| package.name == block.package_name)?
        .targets
        .iter()
        .find_map(|target| {
            let module_root = if is_library_target(target) {
                "crate root"
            } else {
                target.name.as_str()
            };
            find_rust_module(&target.modules, module_root, &block.module_path)
        })
        .and_then(|module| {
            SourcePosition::new(
                module.declaration_line,
                module.declaration_column.checked_add(1)?,
            )
        })
}

fn is_library_target(target: &CargoTarget) -> bool {
    target.kind.iter().any(|kind| {
        matches!(
            kind.as_str(),
            "lib" | "rlib" | "dylib" | "cdylib" | "staticlib"
        )
    })
}

fn find_rust_module<'a>(
    modules: &'a [RustModule],
    parent_path: &str,
    expected_path: &str,
) -> Option<&'a RustModule> {
    modules.iter().find_map(|module| {
        let module_path = format!("{parent_path}::{}", module.name);
        if module_path == expected_path {
            Some(module)
        } else if expected_path
            .strip_prefix(&module_path)
            .is_some_and(|remainder| remainder.starts_with("::"))
        {
            find_rust_module(&module.children, &module_path, expected_path)
        } else {
            None
        }
    })
}

pub fn open_target(target: &EditorTarget, settings: &EditorSettings) -> Result<(), EditorError> {
    let attempts = editor_attempts(
        target,
        settings.command_template.as_deref(),
        env_value("VISUAL").as_deref(),
        env_value("EDITOR").as_deref(),
        EditorPlatform::current(),
    );
    try_editor_attempts(&target.path, attempts, run_editor_command)
}

fn env_value(name: &str) -> Option<String> {
    env::var(name).ok().filter(|value| !value.trim().is_empty())
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum EditorPlatform {
    MacOs,
    Linux,
    Other,
}

impl EditorPlatform {
    fn current() -> Self {
        match env::consts::OS {
            "macos" => Self::MacOs,
            "linux" => Self::Linux,
            _ => Self::Other,
        }
    }

    fn default_handler(self) -> Option<&'static str> {
        match self {
            Self::MacOs => Some("open"),
            Self::Linux => Some("xdg-open"),
            Self::Other => None,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct EditorCommand {
    program: String,
    arguments: Vec<String>,
}

impl EditorCommand {
    fn from_template(template: &str, target: &EditorTarget) -> Result<Self, String> {
        let mut words = split(template).map_err(|error| {
            format!("could not parse editor command template `{template}`: {error}")
        })?;
        if words.is_empty() {
            return Err("editor command template is empty".to_owned());
        }

        let file = target.path.to_string_lossy();
        let line = target.position.line().to_string();
        let column = target.position.column().to_string();
        let has_file_placeholder = words.iter().any(|word| word.contains(FILE_PLACEHOLDER));
        for word in &mut words {
            *word = word
                .replace(FILE_PLACEHOLDER, file.as_ref())
                .replace(LINE_PLACEHOLDER, &line)
                .replace(COLUMN_PLACEHOLDER, &column);
        }
        if !has_file_placeholder {
            words.push(file.into_owned());
        }

        let program = words.remove(0);
        if program.is_empty() {
            return Err("editor command template has an empty executable".to_owned());
        }
        Ok(Self {
            program,
            arguments: words,
        })
    }

    fn default_handler(program: &str, target: &EditorTarget) -> Self {
        Self {
            program: program.to_owned(),
            arguments: vec![target.path.to_string_lossy().into_owned()],
        }
    }
}

fn editor_attempts(
    target: &EditorTarget,
    command_template: Option<&str>,
    visual: Option<&str>,
    editor: Option<&str>,
    platform: EditorPlatform,
) -> Vec<Result<EditorCommand, String>> {
    let mut attempts = Vec::new();
    if let Some(template) = command_template.filter(|template| !template.trim().is_empty()) {
        attempts.push(EditorCommand::from_template(template, target));
    } else if let Some(program) = platform.default_handler() {
        attempts.push(Ok(EditorCommand::default_handler(program, target)));
    }

    for template in [visual, editor]
        .into_iter()
        .flatten()
        .filter(|template| !template.trim().is_empty())
    {
        attempts.push(EditorCommand::from_template(template, target));
    }
    attempts
}

fn try_editor_attempts(
    path: &Path,
    attempts: Vec<Result<EditorCommand, String>>,
    mut launch: impl FnMut(&EditorCommand) -> Result<(), String>,
) -> Result<(), EditorError> {
    let mut failures = Vec::new();
    for attempt in attempts {
        let command = match attempt {
            Ok(command) => command,
            Err(error) => {
                failures.push(error);
                continue;
            }
        };
        match launch(&command) {
            Ok(()) => return Ok(()),
            Err(error) => failures.push(format!("{}: {error}", command.program)),
        }
    }

    if failures.is_empty() {
        Err(EditorError::NoEditorAvailable(path.to_owned()))
    } else {
        Err(EditorError::LaunchFailed {
            path: path.to_owned(),
            attempts: failures,
        })
    }
}

fn run_editor_command(command: &EditorCommand) -> Result<(), String> {
    let mut child = Command::new(&command.program)
        .args(&command.arguments)
        .spawn()
        .map_err(|source| format!("could not start `{}`: {source}", command.program))?;
    // Return for long-running terminal editors, but retain fallback behavior for immediate failures.
    if let Ok(Some(status)) = child.try_wait() {
        if !status.success() {
            return Err(format!("exited with status {status}"));
        }
    } else {
        reap_editor_child(child);
    }
    Ok(())
}

fn reap_editor_child(child: Child) {
    if let Err(error) = std::thread::Builder::new()
        .name("lightwell-editor-reaper".to_owned())
        .spawn(move || {
            let mut child = child;
            if let Err(error) = child.wait() {
                eprintln!("Lightwell could not collect an editor process: {error}");
            }
        })
    {
        eprintln!("Lightwell could not monitor an editor process: {error}");
    }
}

#[derive(Debug)]
pub enum EditorError {
    Extraction(MapExtractionError),
    BlockNotFound(String),
    BlockHasNoSource(String),
    SourcePath {
        path: PathBuf,
        source: std::io::Error,
    },
    SourceOutsideWorkspace(PathBuf),
    NoEditorAvailable(PathBuf),
    LaunchFailed {
        path: PathBuf,
        attempts: Vec<String>,
    },
}

impl Display for EditorError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Extraction(source) => Display::fmt(source, formatter),
            Self::BlockNotFound(id) => write!(
                formatter,
                "No block with ID `{id}` exists in this workspace. Check the IDs in the output of `lightwell extract`."
            ),
            Self::BlockHasNoSource(id) => write!(
                formatter,
                "Block `{id}` has no resolved source path, so Lightwell cannot open it."
            ),
            Self::SourcePath { path, source } => write!(
                formatter,
                "Could not access source file {}: {source}",
                path.display()
            ),
            Self::SourceOutsideWorkspace(path) => write!(
                formatter,
                "Source file {} resolves outside the Rust workspace.",
                path.display()
            ),
            Self::NoEditorAvailable(path) => write!(
                formatter,
                "No OS file handler or editor is available for {}. Set `LIGHTWELL_EDITOR_TEMPLATE`, `VISUAL`, or `EDITOR`.",
                path.display()
            ),
            Self::LaunchFailed { path, attempts } => write!(
                formatter,
                "Could not open {} in an editor. Attempts failed: {}",
                path.display(),
                attempts.join("; ")
            ),
        }
    }
}

impl Error for EditorError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Extraction(source) => Some(source),
            Self::SourcePath { source, .. } => Some(source),
            Self::BlockNotFound(_)
            | Self::BlockHasNoSource(_)
            | Self::SourceOutsideWorkspace(_)
            | Self::NoEditorAvailable(_)
            | Self::LaunchFailed { .. } => None,
        }
    }
}

impl From<MapExtractionError> for EditorError {
    fn from(source: MapExtractionError) -> Self {
        Self::Extraction(source)
    }
}

#[cfg(test)]
mod tests {
    use super::{
        editor_attempts, resolve_block_target, try_editor_attempts, EditorCommand, EditorPlatform,
        EditorTarget, SourcePosition,
    };
    use crate::extract::{block_base, extract_cargo_map};
    use crate::facts::FactBlock;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn target() -> EditorTarget {
        EditorTarget {
            path: PathBuf::from("/project with spaces/src/lib.rs"),
            position: SourcePosition::new(23, 7).unwrap(),
        }
    }

    fn temporary_directory(label: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be after the Unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("lightwell-{label}-{}-{unique}", std::process::id()))
    }

    #[test]
    fn resolver_returns_module_declaration_and_external_file_positions() {
        let root = temporary_directory("editor-source-position");
        fs::create_dir_all(root.join("src")).expect("fixture source folder should be created");
        fs::write(
            root.join("Cargo.toml"),
            "[package]\nname = \"source-position-fixture\"\nversion = \"0.1.0\"\nedition = \"2021\"\n",
        )
        .expect("fixture manifest should be written");
        fs::write(
            root.join("src/lib.rs"),
            "#![allow(dead_code)]\npub mod outer {\n    pub mod inner {}\n}\npub mod external;\n",
        )
        .expect("fixture library source should be written");
        fs::write(root.join("src/external.rs"), "pub fn value() {}\n")
            .expect("external module source should be written");

        let map = extract_cargo_map(&root, None).expect("fixture map should extract");
        let inline_id = map
            .blocks
            .iter()
            .find(|block| {
                matches!(block, FactBlock::Module(module) if module.module_path == "crate root::outer::inner")
            })
            .map(|block| block_base(block).id.clone())
            .expect("inline module should have a map block");
        let external_id = map
            .blocks
            .iter()
            .find(|block| {
                matches!(block, FactBlock::Module(module) if module.module_path == "crate root::external")
            })
            .map(|block| block_base(block).id.clone())
            .expect("external module should have a map block");

        let inline = resolve_block_target(&root, &inline_id)
            .expect("inline module should resolve to its declaration");
        assert_eq!(inline.path, root.join("src/lib.rs").canonicalize().unwrap());
        assert_eq!(inline.position.line(), 3);
        assert_eq!(inline.position.column(), 13);

        let external = resolve_block_target(&root, &external_id)
            .expect("external module should resolve to its source file");
        assert_eq!(
            external.path,
            root.join("src/external.rs").canonicalize().unwrap()
        );
        assert_eq!(external.position.line(), 1);
        assert_eq!(external.position.column(), 1);

        fs::remove_dir_all(root).expect("fixture folder should be removed");
    }

    #[test]
    fn template_expansion_keeps_paths_with_spaces_in_one_argument() {
        let attempts = editor_attempts(
            &target(),
            Some("code --goto {file}:{line}:{column}"),
            None,
            None,
            EditorPlatform::Linux,
        );
        assert_eq!(
            attempts,
            vec![Ok(EditorCommand {
                program: "code".to_owned(),
                arguments: vec![
                    "--goto".to_owned(),
                    "/project with spaces/src/lib.rs:23:7".to_owned(),
                ],
            })]
        );
    }

    #[test]
    fn custom_template_failure_falls_back_to_visual_then_editor() {
        let attempts = editor_attempts(
            &target(),
            Some("custom-editor --goto {file}:{line}:{column}"),
            Some("visual-editor --wait"),
            Some("terminal-editor"),
            EditorPlatform::MacOs,
        );
        let mut launched = Vec::new();
        let result = try_editor_attempts(&target().path, attempts, |command| {
            launched.push(command.program.clone());
            if command.program == "terminal-editor" {
                Ok(())
            } else {
                Err("not available".to_owned())
            }
        });

        assert!(result.is_ok());
        assert_eq!(
            launched,
            vec![
                "custom-editor".to_owned(),
                "visual-editor".to_owned(),
                "terminal-editor".to_owned(),
            ]
        );

        let macos_attempts = editor_attempts(&target(), None, None, None, EditorPlatform::MacOs);
        assert_eq!(macos_attempts[0].as_ref().unwrap().program, "open");
    }

    #[test]
    fn os_handler_precedes_visual_then_editor() {
        let attempts = editor_attempts(
            &target(),
            None,
            Some("visual-editor"),
            Some("terminal-editor"),
            EditorPlatform::Linux,
        );
        let mut launched = Vec::new();
        let result = try_editor_attempts(&target().path, attempts, |command| {
            launched.push(command.program.clone());
            if command.program == "terminal-editor" {
                Ok(())
            } else {
                Err("not available".to_owned())
            }
        });

        assert!(result.is_ok());
        assert_eq!(
            launched,
            vec![
                "xdg-open".to_owned(),
                "visual-editor".to_owned(),
                "terminal-editor".to_owned(),
            ]
        );
    }

    #[test]
    fn visual_is_skipped_when_it_is_empty_and_other_platforms_use_editor() {
        let attempts = editor_attempts(
            &target(),
            None,
            Some("  "),
            Some("terminal-editor"),
            EditorPlatform::Other,
        );
        assert_eq!(attempts.len(), 1);
        assert_eq!(attempts[0].as_ref().unwrap().program, "terminal-editor");
    }
}
