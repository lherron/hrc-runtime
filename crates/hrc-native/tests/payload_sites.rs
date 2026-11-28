use proc_macro2::{TokenStream, TokenTree};
use std::{collections::BTreeMap, fs, path::Path};
use syn::{
    Attribute, ImplItemFn, ItemFn, ItemMod, LitStr, Macro, Meta,
    visit::{self, Visit},
};

const COLUMNS: &[&str] = &[
    "preparation_json",
    "spec_projection_json",
    "start_request_projection_json",
];

#[derive(Clone, Copy, Debug, Ord, PartialOrd, Eq, PartialEq)]
enum Access {
    Read,
    Write,
}

#[derive(Default)]
struct Function {
    sites: Vec<Access>,
    resolves: usize,
    externalizes: usize,
    resolve_projections: usize,
}

impl Function {
    fn literal(&mut self, text: &str) {
        let lower = text.to_ascii_lowercase();
        let words: Vec<_> = lower
            .split(|c: char| !c.is_ascii_alphanumeric() && c != '_')
            .filter(|w| !w.is_empty())
            .collect();
        let names_payload = words.iter().any(|w| COLUMNS.contains(w));
        if names_payload && words.iter().any(|w| matches!(*w, "insert" | "update")) {
            self.sites.push(Access::Write);
        }
        // A star in a SELECT list selects columns. A star inside COUNT(*)
        // does not. An unqualified star and an alias.* are both relevant.
        let mut depth = 0;
        let mut select_depths = Vec::new();
        let mut wildcard = false;
        let mut token = String::new();
        for c in lower.chars().chain([' ']) {
            if c.is_ascii_alphanumeric() || c == '_' {
                token.push(c);
                continue;
            }
            match token.as_str() {
                "select" => select_depths.push(depth),
                "from" if select_depths.last() == Some(&depth) => {
                    select_depths.pop();
                }
                _ => {}
            }
            token.clear();
            match c {
                '(' => depth += 1,
                ')' => depth -= 1,
                '*' if select_depths.last() == Some(&depth) => wildcard = true,
                _ => {}
            }
        }
        let target = words
            .iter()
            .any(|w| matches!(*w, "runtime_operations" | "broker_invocations"));
        if words.contains(&"select") && (names_payload || (wildcard && target)) {
            self.sites.push(Access::Read);
        }
    }

    fn macro_literals(&mut self, tokens: TokenStream) {
        for token in tokens {
            match token {
                TokenTree::Group(group) => self.macro_literals(group.stream()),
                TokenTree::Literal(literal) => {
                    if let Ok(string) = syn::parse2::<LitStr>(TokenTree::Literal(literal).into()) {
                        self.literal(&string.value());
                    }
                }
                _ => {}
            }
        }
    }
}

impl<'ast> Visit<'ast> for Function {
    fn visit_lit_str(&mut self, string: &'ast LitStr) {
        self.literal(&string.value());
    }

    fn visit_macro(&mut self, invocation: &'ast Macro) {
        self.macro_literals(invocation.tokens.clone());
    }

    fn visit_expr_method_call(&mut self, call: &'ast syn::ExprMethodCall) {
        match call.method.to_string().as_str() {
            "resolve_payloads" => self.resolves += 1,
            "resolve_projection" => self.resolve_projections += 1,
            _ => {}
        }
        visit::visit_expr_method_call(self, call);
    }

    fn visit_expr_call(&mut self, call: &'ast syn::ExprCall) {
        if let syn::Expr::Path(path) = &*call.func
            && path
                .path
                .segments
                .last()
                .is_some_and(|s| s.ident == "externalize_payloads")
        {
            self.externalizes += 1;
        }
        visit::visit_expr_call(self, call);
    }
}

fn test_only(attrs: &[Attribute]) -> bool {
    attrs.iter().any(|attr| {
        attr.path().is_ident("test")
            || (attr.path().is_ident("cfg")
                && attr
                    .parse_args::<Meta>()
                    .is_ok_and(|meta| meta.path().is_ident("test")))
    })
}

struct File<'a> {
    path: &'a str,
    functions: &'a mut BTreeMap<String, Function>,
}

impl File<'_> {
    fn function(&mut self, attrs: &[Attribute], name: &str, block: &syn::Block) {
        if !test_only(attrs) {
            let mut function = Function::default();
            function.visit_block(block);
            self.functions
                .insert(format!("{}:{name}", self.path), function);
        }
    }
}

impl<'ast> Visit<'ast> for File<'_> {
    fn visit_item_mod(&mut self, item: &'ast ItemMod) {
        if !test_only(&item.attrs) {
            visit::visit_item_mod(self, item);
        }
    }

    fn visit_item_fn(&mut self, item: &'ast ItemFn) {
        self.function(&item.attrs, &item.sig.ident.to_string(), &item.block);
    }

    fn visit_impl_item_fn(&mut self, item: &'ast ImplItemFn) {
        self.function(&item.attrs, &item.sig.ident.to_string(), &item.block);
    }

    fn visit_lit_str(&mut self, string: &'ast LitStr) {
        self.functions
            .entry(format!("{}:<outside function>", self.path))
            .or_default()
            .literal(&string.value());
    }

    fn visit_macro(&mut self, invocation: &'ast Macro) {
        self.functions
            .entry(format!("{}:<outside function>", self.path))
            .or_default()
            .macro_literals(invocation.tokens.clone());
    }
}

fn scan(root: &Path, dir: &Path, functions: &mut BTreeMap<String, Function>) -> anyhow::Result<()> {
    for entry in fs::read_dir(dir)? {
        let path = entry?.path();
        let name = path.file_name().unwrap().to_str().unwrap();
        if path.is_dir() {
            scan(root, &path, functions)?;
        } else if name.ends_with(".rs") && name != "tests.rs" && !name.ends_with("_tests.rs") {
            let relative = path.strip_prefix(root)?.to_str().unwrap();
            let syntax = syn::parse_file(&fs::read_to_string(&path)?)?;
            File {
                path: relative,
                functions,
            }
            .visit_file(&syntax);
        }
    }
    Ok(())
}

#[test]
fn invocation_payload_sites_are_guarded() -> anyhow::Result<()> {
    let mut expected = BTreeMap::new();
    for line in include_str!("../payload-sites.txt").lines() {
        let (site, treatment) = line.split_once(' ').expect("site and treatment");
        let access = match treatment {
            "externalize" => Access::Write,
            "resolve" => Access::Read,
            reason if reason.starts_with("stubs-ok ") && reason.len() > 9 => Access::Read,
            _ => panic!("invalid treatment for {site}"),
        };
        assert!(
            expected
                .insert((site.to_owned(), access), treatment)
                .is_none(),
            "{site}"
        );
    }
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let mut functions = BTreeMap::new();
    for entry in fs::read_dir(root)? {
        let src = entry?.path().join("src");
        if src.is_dir() {
            scan(root, &src, &mut functions)?;
        }
    }
    // Both projection readers share this adapter to preserve the exact inline
    // representation, including the caller's existing malformed-JSON handling.
    let adapter_resolves =
        functions["hrc-store/src/broker_reads.rs:resolve_projection"].resolves > 0;
    let mut errors = Vec::new();
    for (site, function) in functions {
        for access in function.sites {
            match expected.get(&(site.clone(), access)).copied() {
                Some("externalize") if function.externalizes == 0 => {
                    errors.push(format!("{site} is missing externalize_payloads"));
                }
                Some("resolve")
                    if function.resolves == 0
                        && !(site.starts_with("hrc-store/src/broker_reads.rs:")
                            && function.resolve_projections > 0
                            && adapter_resolves) =>
                {
                    errors.push(format!("{site} is missing payload resolution"));
                }
                Some(_) => {}
                None => errors.push(format!("{site} has an unlisted {access:?}")),
            }
        }
    }
    assert!(errors.is_empty(), "{}", errors.join("\n"));
    Ok(())
}
