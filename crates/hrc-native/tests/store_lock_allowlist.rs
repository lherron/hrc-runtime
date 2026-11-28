use proc_macro2::{Delimiter, TokenStream, TokenTree};
use std::{collections::BTreeMap, fs, path::Path};
use syn::{
    Attribute, Expr, ImplItemFn, ItemFn, ItemMod, Macro, Member, Meta,
    visit::{self, Visit},
};

#[derive(Default)]
struct Locks<'a> {
    path: &'a str,
    function: Option<String>,
    counts: BTreeMap<String, usize>,
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

fn is_store(expr: &Expr) -> bool {
    match expr {
        Expr::Field(field) => matches!(&field.member, Member::Named(name) if name == "store"),
        Expr::Paren(paren) => is_store(&paren.expr),
        Expr::Group(group) => is_store(&group.expr),
        Expr::Reference(reference) => is_store(&reference.expr),
        _ => false,
    }
}

// Macro input (for example json!({ ... server.store.lock() ... })) is
// opaque to the expression visitor. Scan its tokens without matching strings.
fn macro_locks(stream: TokenStream) -> usize {
    let tokens: Vec<_> = stream.into_iter().collect();
    let dot = |token: &TokenTree| matches!(token, TokenTree::Punct(p) if p.as_char() == '.');
    let here = tokens
        .windows(5)
        .filter(|window| {
            dot(&window[0])
                && matches!(&window[1], TokenTree::Ident(id) if id == "store")
                && dot(&window[2])
                && matches!(&window[3], TokenTree::Ident(id) if id == "lock")
                && matches!(&window[4], TokenTree::Group(group)
                    if group.delimiter() == Delimiter::Parenthesis && group.stream().is_empty())
        })
        .count();
    here + tokens
        .into_iter()
        .map(|token| match token {
            TokenTree::Group(group) => macro_locks(group.stream()),
            _ => 0,
        })
        .sum::<usize>()
}

impl Locks<'_> {
    fn record(&mut self, count: usize) {
        if count != 0 {
            let function = self.function.as_deref().unwrap_or("<outside function>");
            *self
                .counts
                .entry(format!("{}:{function}", self.path))
                .or_default() += count;
        }
    }

    fn visit_function(&mut self, attrs: &[Attribute], name: &syn::Ident, block: &syn::Block) {
        if !test_only(attrs) {
            let outer = self.function.replace(name.to_string());
            self.visit_block(block);
            self.function = outer;
        }
    }
}

impl<'ast> Visit<'ast> for Locks<'_> {
    fn visit_item_mod(&mut self, item: &'ast ItemMod) {
        if !test_only(&item.attrs) {
            visit::visit_item_mod(self, item);
        }
    }

    fn visit_item_fn(&mut self, item: &'ast ItemFn) {
        self.visit_function(&item.attrs, &item.sig.ident, &item.block);
    }

    fn visit_impl_item_fn(&mut self, item: &'ast ImplItemFn) {
        self.visit_function(&item.attrs, &item.sig.ident, &item.block);
    }

    fn visit_expr_method_call(&mut self, call: &'ast syn::ExprMethodCall) {
        if call.method == "lock" && call.args.is_empty() && is_store(&call.receiver) {
            self.record(1);
        }
        visit::visit_expr_method_call(self, call);
    }

    fn visit_macro(&mut self, invocation: &'ast Macro) {
        self.record(macro_locks(invocation.tokens.clone()));
    }
}

fn scan(root: &Path, dir: &Path, counts: &mut BTreeMap<String, usize>) -> anyhow::Result<()> {
    for entry in fs::read_dir(dir)? {
        let path = entry?.path();
        let name = path.file_name().unwrap().to_str().unwrap();
        if path.is_dir() {
            scan(root, &path, counts)?;
        } else if name.ends_with(".rs") && name != "tests.rs" && !name.ends_with("_tests.rs") {
            // The crate's out-of-line #[cfg(test)] modules use tests.rs or *_tests.rs.
            let relative = path.strip_prefix(root)?.to_str().unwrap();
            let syntax = syn::parse_file(&fs::read_to_string(&path)?)?;
            let mut locks = Locks {
                path: relative,
                ..Locks::default()
            };
            locks.visit_file(&syntax);
            counts.extend(locks.counts);
        }
    }
    Ok(())
}

#[test]
fn raw_store_locks_do_not_grow() -> anyhow::Result<()> {
    let limits: BTreeMap<_, usize> = include_str!("../store-lock-allowlist.txt")
        .lines()
        .map(|line| {
            let (key, limit) = line.split_once(' ').expect("path:fn count");
            (key, limit.parse().expect("numeric count"))
        })
        .collect();
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let mut counts = BTreeMap::new();
    scan(root, &root.join("src"), &mut counts)?;
    // The writer access point itself is permanent and may acquire once.
    assert_eq!(
        counts.remove("src/server/front/store_lock.rs:write"),
        Some(1),
        "Server::write must acquire the store exactly once"
    );
    let violations: Vec<_> = counts
        .iter()
        .filter_map(|(key, &actual)| {
            let allowed = limits.get(key.as_str()).copied().unwrap_or(0);
            (actual > allowed).then(|| format!("{key} has {actual}, allowed {allowed}"))
        })
        .collect();
    assert!(
        violations.is_empty(),
        "raw store lock growth:\n{}",
        violations.join("\n")
    );
    Ok(())
}
