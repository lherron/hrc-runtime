use std::fs;
fn main() {
    let path = "../../packages/hrc-core/package.json";
    println!("cargo:rerun-if-changed={path}");
    let package: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap();
    println!(
        "cargo:rustc-env=HRC_API_VERSION={}",
        package["version"].as_str().unwrap()
    );
}
