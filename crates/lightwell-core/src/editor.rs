use crate::extract::{block_base, map_workspace};
use crate::{discover_cargo_workspace, MapExtractionError};
use shell_words::split;
use std::env;
use std::error::Error;
use std::fmt::{Display, Formatter};
use std::num::NonZeroUsize;
use std::path::{Path, PathBuf};
use std::process::Command;

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

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct EditorSettings {
    pub command_template: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
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
    let workspace = discover_cargo_workspace(repository_path).map_err(MapExtractionError::from)?;
    let root = workspace.root.clone();
    let map = map_workspace(workspace, None)?;
    let block = map
        .blocks
        .iter()
        .find(|block| block_base(block).id == block_id)
        .ok_or_else(|| EditorError::BlockNotFound(block_id.to_owned()))?;
    let base = block_base(block);
    let source_path = base
        .source_path
        .as_deref()
        .ok_or_else(|| EditorError::BlockHasNoSource(block_id.to_owned()))?;

    open_target(
        &EditorTarget::at_file_start(root.join(source_path)),
        settings,
    )
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
    let status = Command::new(&command.program)
        .args(&command.arguments)
        .status()
        .map_err(|source| format!("could not start `{}`: {source}", command.program))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("exited with status {status}"))
    }
}

#[derive(Debug)]
pub enum EditorError {
    Extraction(MapExtractionError),
    BlockNotFound(String),
    BlockHasNoSource(String),
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
            Self::BlockNotFound(_)
            | Self::BlockHasNoSource(_)
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
        editor_attempts, try_editor_attempts, EditorCommand, EditorPlatform, EditorTarget,
        SourcePosition,
    };
    use std::path::PathBuf;

    fn target() -> EditorTarget {
        EditorTarget {
            path: PathBuf::from("/project with spaces/src/lib.rs"),
            position: SourcePosition::new(23, 7).unwrap(),
        }
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
