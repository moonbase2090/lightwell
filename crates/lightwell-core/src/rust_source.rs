use crate::metadata::{CargoDiscoveryError, CargoTarget, RustModule};
use proc_macro2::LineColumn;
use quote::ToTokens;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use syn::punctuated::Punctuated;
use syn::spanned::Spanned;
use syn::{Attribute, Expr, Item, Lit, Meta, Token};

pub(super) fn populate_target_modules(target: &mut CargoTarget) -> Result<(), CargoDiscoveryError> {
    target.modules = modules_in_file(
        &target.source_path,
        &module_directory_for_source(&target.source_path),
        &mut HashSet::new(),
    )?;
    Ok(())
}

fn modules_in_file(
    source_path: &Path,
    parent_directory: &Path,
    active_sources: &mut HashSet<PathBuf>,
) -> Result<Vec<RustModule>, CargoDiscoveryError> {
    let source_key = source_path
        .canonicalize()
        .unwrap_or_else(|_| source_path.to_owned());
    if !active_sources.insert(source_key.clone()) {
        return Ok(Vec::new());
    }
    let result = (|| {
        let source =
            fs::read_to_string(source_path).map_err(|source| CargoDiscoveryError::SourceRead {
                path: source_path.to_owned(),
                source,
            })?;
        let file =
            syn::parse_file(&source).map_err(|source| CargoDiscoveryError::InvalidRustSource {
                path: source_path.to_owned(),
                reason: source.to_string(),
            })?;
        let mut modules = modules_from_items(
            &file.items,
            &source,
            source_path,
            parent_directory,
            active_sources,
        )?;
        if matches!(file.items.first(), Some(Item::Mod(module)) if !is_test_only(&module.attrs)) {
            if let Some(first_module) = modules.first_mut() {
                let mut attributes = source_attributes(&source, &file.attrs);
                attributes.append(&mut first_module.attributes);
                first_module.attributes = attributes;
            }
        }
        Ok(modules)
    })();
    active_sources.remove(&source_key);
    result
}

fn modules_from_items(
    items: &[Item],
    source: &str,
    declaration_path: &Path,
    parent_directory: &Path,
    active_sources: &mut HashSet<PathBuf>,
) -> Result<Vec<RustModule>, CargoDiscoveryError> {
    items
        .iter()
        .filter_map(|item| match item {
            Item::Mod(module) => Some(module),
            _ => None,
        })
        .filter(|module| !is_test_only(&module.attrs))
        .map(|module| {
            let identifier = module.ident.to_string();
            let name = identifier
                .strip_prefix("r#")
                .unwrap_or(&identifier)
                .to_owned();
            let path_attribute = path_attribute(&module.attrs);
            let source_path = if module.content.is_some() {
                Some(declaration_path.to_owned())
            } else {
                resolve_module_source(
                    &name,
                    path_attribute.as_deref(),
                    parent_directory,
                    declaration_path,
                )
            };
            let children = match (&module.content, &source_path) {
                (Some((_, items)), _) => modules_from_items(
                    items,
                    source,
                    declaration_path,
                    &parent_directory.join(&name),
                    active_sources,
                )?,
                (None, Some(source_path)) => modules_in_file(
                    source_path,
                    &module_directory_for_source(source_path),
                    active_sources,
                )?,
                (None, None) => Vec::new(),
            };
            let attributes = source_attributes(source, &module.attrs);

            Ok(RustModule {
                name,
                declaration_path: declaration_path.to_owned(),
                source_path,
                path_attribute,
                attributes,
                children,
            })
        })
        .collect()
}

fn resolve_module_source(
    name: &str,
    path_attribute: Option<&str>,
    parent_directory: &Path,
    declaration_path: &Path,
) -> Option<PathBuf> {
    if let Some(path_attribute) = path_attribute {
        let path = declaration_path.parent()?.join(path_attribute);
        return path.is_file().then_some(path);
    }
    [
        parent_directory.join(format!("{name}.rs")),
        parent_directory.join(name).join("mod.rs"),
    ]
    .into_iter()
    .find(|candidate| candidate.is_file())
}

fn path_attribute(attributes: &[Attribute]) -> Option<String> {
    attributes.iter().find_map(|attribute| {
        if !attribute.path().is_ident("path") {
            return None;
        }
        let Meta::NameValue(name_value) = &attribute.meta else {
            return None;
        };
        let Expr::Lit(expression) = &name_value.value else {
            return None;
        };
        let Lit::Str(path) = &expression.lit else {
            return None;
        };
        Some(path.value())
    })
}

fn is_test_only(attributes: &[Attribute]) -> bool {
    attributes.iter().any(|attribute| {
        if !attribute.path().is_ident("cfg") {
            return false;
        }
        attribute
            .parse_args::<Meta>()
            .is_ok_and(|expression| cfg_requires_test(&expression))
    })
}

fn cfg_requires_test(expression: &Meta) -> bool {
    match expression {
        Meta::Path(path) => path.is_ident("test"),
        Meta::List(list) if list.path.is_ident("all") => {
            nested_meta(list).is_some_and(|items| items.iter().any(cfg_requires_test))
        }
        Meta::List(list) if list.path.is_ident("any") => nested_meta(list)
            .is_some_and(|items| !items.is_empty() && items.iter().all(cfg_requires_test)),
        _ => false,
    }
}

fn nested_meta(list: &syn::MetaList) -> Option<Punctuated<Meta, Token![,]>> {
    list.parse_args_with(Punctuated::<Meta, Token![,]>::parse_terminated)
        .ok()
}

fn attribute_source(source: &str, attribute: &Attribute) -> String {
    let span = attribute.span();
    let start = source_offset(source, span.start());
    let end = source_offset(source, span.end());
    match (start, end) {
        (Some(start), Some(end)) if start <= end => source
            .get(start..end)
            .map(str::to_owned)
            .unwrap_or_else(|| attribute.to_token_stream().to_string()),
        _ => attribute.to_token_stream().to_string(),
    }
}

fn source_attributes(source: &str, attributes: &[Attribute]) -> Vec<String> {
    attributes
        .iter()
        .map(|attribute| attribute_source(source, attribute))
        .filter(|attribute| {
            let attribute = attribute.trim_start();
            attribute.starts_with("#[") || attribute.starts_with("#![")
        })
        .collect()
}

fn source_offset(source: &str, location: LineColumn) -> Option<usize> {
    if location.line == 0 {
        return None;
    }
    let mut line = 1;
    let mut offset: usize = 0;
    for text in source.split_inclusive('\n') {
        if line == location.line {
            return offset.checked_add(location.column);
        }
        offset += text.len();
        line += 1;
    }
    (line == location.line)
        .then_some(offset.checked_add(location.column))
        .flatten()
}

fn module_directory_for_source(source_path: &Path) -> PathBuf {
    let file_name = source_path.file_name().and_then(|name| name.to_str());
    if matches!(file_name, Some("mod.rs" | "lib.rs" | "main.rs" | "bin.rs")) {
        return source_path
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .to_owned();
    }
    source_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(source_path.file_stem().unwrap_or_default())
}
