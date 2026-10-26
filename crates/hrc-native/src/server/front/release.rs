//! Immutable native executable provenance. Never consult a Bun socket or caller env.
use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json};
use std::{fs, path::PathBuf};

pub struct Release {
    captured: Value,
    installed_link: Option<PathBuf>,
}
impl Release {
    pub fn capture(started_at: &str) -> Result<Self> {
        let binary = std::env::current_exe()?.canonicalize()?;
        let package = binary
            .parent()
            .context("native executable has no directory")?;
        let root = package.parent().context("native package has no parent")?;
        let atomic = package.file_name().is_some_and(|s| s == "bin")
            && root
                .parent()
                .and_then(|p| p.file_name())
                .is_some_and(|s| s == "hrc-runtime-releases")
            && root.file_name().and_then(|s| s.to_str()).is_some_and(|s| {
                s.starts_with("release-")
                    && s.len() > 8
                    && s[8..]
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
            });
        if !atomic {
            return Ok(Self {
                captured: json!({"mode":"unmanaged","packagePath":package,"processStartedAt":started_at}),
                installed_link: None,
            });
        }
        let manifest_path = root.join("praesidium-release.json");
        let manifest: Value = serde_json::from_slice(
            &fs::read(&manifest_path).context("native atomic release manifest missing")?,
        )?;
        exact(
            &manifest,
            &[
                "schema",
                "releaseId",
                "hrcBuild",
                "aspContracts",
                "installedAt",
            ],
        )?;
        ensure!(
            manifest["schema"] == 1
                && manifest["releaseId"] == root.file_name().unwrap().to_str().unwrap(),
            "native atomic release identity mismatch"
        );
        let b = &manifest["hrcBuild"];
        exact(
            b,
            &[
                "schema",
                "repository",
                "canonicalRemote",
                "sourceCommit",
                "setName",
                "setVersion",
                "builtAt",
            ],
        )?;
        ensure!(
            b["schema"] == 1 && b["repository"] == "hrc-runtime" && b["setName"] == "hrc",
            "invalid native build tuple"
        );
        for key in [
            "repository",
            "canonicalRemote",
            "sourceCommit",
            "setName",
            "setVersion",
            "builtAt",
        ] {
            nonempty(b, key)?;
        }
        ensure!(
            b["sourceCommit"] == env!("HRC_SOURCE_COMMIT"),
            "native executable sourceCommit differs from release manifest"
        );
        chrono::DateTime::parse_from_rfc3339(nonempty(b, "builtAt")?)?;
        chrono::DateTime::parse_from_rfc3339(nonempty(&manifest, "installedAt")?)?;
        let contracts = manifest["aspContracts"]
            .as_array()
            .context("aspContracts must be an array")?;
        ensure!(!contracts.is_empty(), "aspContracts must be nonempty");
        for entry in contracts {
            nonempty(entry, "name")?;
            nonempty(entry, "version")?;
        }
        // Reconstruct the canonical field order, independent of manifest order.
        let build = json!({"schema":1,"repository":b["repository"],"canonicalRemote":b["canonicalRemote"],"sourceCommit":b["sourceCommit"],"setName":b["setName"],"setVersion":b["setVersion"],"builtAt":b["builtAt"]});
        Ok(Self {
            captured: json!({"mode":"atomic","releaseId":manifest["releaseId"],"releasePath":root,"manifestPath":manifest_path,"hrcBuild":build,"aspContracts":contracts.iter().map(|v|json!({"name":v["name"],"version":v["version"]})).collect::<Vec<_>>(),"installedAt":manifest["installedAt"],"processStartedAt":started_at}),
            installed_link: Some(
                root.parent()
                    .unwrap()
                    .parent()
                    .unwrap()
                    .join("hrc-runtime-current"),
            ),
        })
    }
    pub fn status(&self) -> Value {
        let mut value = self.captured.clone();
        value["runningEqualsInstalled"] = self
            .installed_link
            .as_ref()
            .and_then(|p| fs::canonicalize(p).ok())
            .is_some_and(|p| {
                value["releasePath"]
                    .as_str()
                    .is_some_and(|root| p == std::path::Path::new(root))
            })
            .into();
        value
    }
}
fn nonempty<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value[key]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .with_context(|| format!("release {key} must be a nonempty string"))
}
fn exact(value: &Value, fields: &[&str]) -> Result<()> {
    let object = value.as_object().context("release must be an object")?;
    if object.len() != fields.len() || fields.iter().any(|key| !object.contains_key(*key)) {
        bail!("invalid release manifest fields");
    }
    Ok(())
}
