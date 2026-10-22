use lightwell_core::{extract_cargo_map, FactBlock};
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

fn temporary_directory(label: &str) -> PathBuf {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    std::env::temp_dir().join(format!("lightwell-{label}-{}-{unique}", std::process::id()))
}

fn block_ids(map: &lightwell_core::FactMap) -> Vec<String> {
    map.blocks
        .iter()
        .map(|block| match block {
            FactBlock::Workspace(inner) => inner.base.id.clone(),
            FactBlock::Crate(inner) => inner.base.id.clone(),
            FactBlock::Module(inner) => inner.base.id.clone(),
            FactBlock::App(inner) => inner.base.id.clone(),
            FactBlock::CargoFeature(inner) => inner.base.id.clone(),
        })
        .collect()
}

/// A fresh `create-next-app` root has no `Cargo.toml`. Opening it must map the
/// TypeScript sources instead of failing with `No Cargo.toml`.
/// See https://github.com/moonbase2090/lightwell/issues/161.
#[test]
fn nextjs_project_opens_without_cargo_toml() {
    let root = temporary_directory("nextjs-open");
    fs::create_dir_all(root.join("app")).expect("app dir");
    fs::create_dir_all(root.join("public")).expect("public dir");
    fs::write(
        root.join("package.json"),
        "{\n  \"name\": \"next-repro\",\n  \"version\": \"0.1.0\",\n  \"private\": true,\n  \"dependencies\": {\n    \"next\": \"15.5.4\",\n    \"react\": \"19.2.0\",\n    \"react-dom\": \"19.2.0\"\n  }\n}\n",
    )
    .expect("package.json");
    fs::write(
        root.join("tsconfig.json"),
        "{\n  \"compilerOptions\": {\n    \"target\": \"ES2017\",\n    \"jsx\": \"preserve\",\n    \"paths\": { \"@/*\": [\"./*\"] }\n  },\n  \"include\": [\"next-env.d.ts\", \"**/*.ts\", \"**/*.tsx\"],\n  \"exclude\": [\"node_modules\"]\n}\n",
    )
    .expect("tsconfig.json");
    fs::write(
        root.join("next.config.ts"),
        "import type { NextConfig } from \"next\";\nconst nextConfig: NextConfig = {};\nexport default nextConfig;\n",
    )
    .expect("next.config.ts");
    fs::write(
        root.join("next-env.d.ts"),
        "/// <reference types=\"next\" />\n/// <reference types=\"next/image-types/global\" />\n",
    )
    .expect("next-env.d.ts");
    fs::write(
        root.join("app/layout.tsx"),
        "import type { Metadata } from \"next\";\nexport const metadata: Metadata = { title: \"Next repro\" };\nexport default function RootLayout({ children }: { children: React.ReactNode }) {\n  return (\n    <html lang=\"en\">\n      <body>{children}</body>\n    </html>\n  );\n}\n",
    )
    .expect("layout.tsx");
    fs::write(
        root.join("app/page.tsx"),
        "export default function Home() {\n  return <main><h1>Hello Next</h1></main>;\n}\n",
    )
    .expect("page.tsx");

    let map = extract_cargo_map(&root, None).expect("a Next.js project should extract");
    let ids = block_ids(&map);
    assert!(
        ids.iter().any(|id| id.contains("page")),
        "the app router page should have a map block, got: {ids:?}"
    );
    assert!(
        ids.iter().any(|id| id.contains("layout")),
        "the app router layout should have a map block, got: {ids:?}"
    );
}
