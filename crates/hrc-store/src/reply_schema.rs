//! Pure embedded-mail reply schema compilation and validation.
//! This module never opens SQLite, resolves remote references, or runs an engine process.
use hrc_domain::store::json::{self, JsObject, JsString, JsValue};
use serde::Serialize;
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize)]
pub struct MailSchemaCompileError {
    pub name: &'static str,
    pub message: JsString,
}
impl MailSchemaCompileError {
    fn error(message: impl Into<JsString>) -> Self {
        Self {
            name: "Error",
            message: message.into(),
        }
    }
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailSchemaValidationError {
    pub instance_path: JsString,
    pub keyword: String,
    pub message: JsString,
    pub params: JsObject,
}
#[derive(Debug, Clone, Serialize)]
#[serde(untagged)]
pub enum MailReplyValidation {
    Valid {
        valid: bool,
    },
    Invalid {
        valid: bool,
        errors: Vec<MailSchemaValidationError>,
    },
}
#[derive(Clone)]
pub struct CompiledMailReplySchema {
    root: JsValue,
    patterns: BTreeMap<Vec<u16>, regress::Regex>,
    visited_references: std::collections::BTreeSet<String>,
}
#[derive(Default)]
struct CompileCache {
    schemas: BTreeMap<String, CompiledMailReplySchema>,
    ids: std::collections::BTreeSet<String>,
}
static COMPILED: std::sync::OnceLock<std::sync::Mutex<CompileCache>> = std::sync::OnceLock::new();
const DIALECT: &str = "https://json-schema.org/draft/2020-12/schema";
fn joined(prefix: &str, value: &JsString, suffix: &str) -> JsString {
    JsString::concat(&[prefix.into(), value.clone(), suffix.into()])
}
fn entries(object: &JsObject) -> Vec<(&JsString, &JsValue)> {
    fn index(key: &JsString) -> Option<u32> {
        let text = key.as_str()?;
        let n = text.parse::<u32>().ok()?;
        if n != u32::MAX && n.to_string() == text {
            Some(n)
        } else {
            None
        }
    }
    let mut items: Vec<_> = object.iter().collect();
    items.sort_by(|(a, _), (b, _)| match (index(a), index(b)) {
        (Some(a), Some(b)) => a.cmp(&b),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => std::cmp::Ordering::Equal,
    });
    items
}
fn pointer(path: &JsString, key: &JsString) -> JsString {
    let mut units = path.utf16().to_vec();
    units.push(47);
    for unit in key.utf16() {
        match unit {
            126 => units.extend([126, 48]),
            47 => units.extend([126, 49]),
            unit => units.push(*unit),
        }
    }
    JsString::from_utf16(units)
}
fn remote_refs(value: &JsValue, path: &JsString, refs: &mut Vec<JsString>) {
    match value {
        JsValue::Array(items) => {
            for (i, item) in items.iter().enumerate() {
                remote_refs(
                    item,
                    &JsString::concat(&[path.clone(), format!("[{i}]").into()]),
                    refs,
                )
            }
        }
        JsValue::Object(object) => {
            for (key, child) in entries(object) {
                let child_path = JsString::concat(&[path.clone(), ".".into(), key.clone()]);
                if matches!(key.as_str(), Some("$ref" | "$dynamicRef" | "$recursiveRef"))
                    && let Some(reference) = child.as_js_string()
                    && reference.utf16().first() != Some(&35)
                {
                    refs.push(JsString::concat(&[
                        child_path.clone(),
                        ": ".into(),
                        reference.clone(),
                    ]))
                }
                remote_refs(child, &child_path, refs)
            }
        }
        _ => {}
    }
}
fn type_matches(value: &JsValue, kind: &str) -> bool {
    match kind {
        "null" => value.is_null(),
        "object" => value.is_object(),
        "array" => value.is_array(),
        "string" => value.is_string(),
        "boolean" => value.is_boolean(),
        "number" => value.as_f64().is_some_and(f64::is_finite),
        "integer" => value
            .as_f64()
            .is_some_and(|n| n.is_finite() && n.fract() == 0.0),
        _ => false,
    }
}
fn regex_compile_error(message: &str) -> MailSchemaCompileError {
    let message = match message {
        "Unbalanced bracket" => "missing terminating ] for character class",
        other => other,
    };
    MailSchemaCompileError {
        name: "SyntaxError",
        message: format!("Invalid regular expression: {message}").into(),
    }
}
#[derive(Clone, Copy)]
enum SchemaData<'a> {
    Json(&'a JsValue),
    Function,
    Undefined,
    Prototype,
}
impl<'a> SchemaData<'a> {
    fn value(self) -> &'a JsValue {
        static EMPTY: std::sync::OnceLock<JsValue> = std::sync::OnceLock::new();
        static NULL: JsValue = JsValue::Null;
        match self {
            Self::Json(value) => value,
            Self::Function | Self::Undefined => &NULL,
            Self::Prototype => EMPTY.get_or_init(|| JsValue::Object(JsObject::new())),
        }
    }
    fn lookup(self, key: &JsString) -> Option<Self> {
        if let Some(value) = self.value().as_object()?.get_utf16(key) {
            return Some(Self::Json(value));
        }
        match key.as_str()? {
            "__proto__" => Some(if matches!(self, Self::Prototype) {
                Self::Json(&JsValue::Null)
            } else {
                Self::Prototype
            }),
            "constructor"
            | "toString"
            | "toLocaleString"
            | "valueOf"
            | "hasOwnProperty"
            | "isPrototypeOf"
            | "propertyIsEnumerable"
            | "__defineGetter__"
            | "__defineSetter__"
            | "__lookupGetter__"
            | "__lookupSetter__" => Some(Self::Function),
            _ => None,
        }
    }
    fn is_type(self, kind: &str) -> bool {
        !matches!(self, Self::Function | Self::Undefined) && type_matches(self.value(), kind)
    }
    fn equals(self, value: &JsValue) -> bool {
        !matches!(self, Self::Function | Self::Undefined) && self.value() == value
    }
}
#[derive(Default)]
struct ValidationStack {
    active: std::collections::BTreeSet<(usize, usize, u8)>,
    cycle: bool,
}
thread_local! {
    static VALIDATION_STACK: std::cell::RefCell<ValidationStack> = std::cell::RefCell::default();
}
struct ValidationFrame((usize, usize, u8));
impl ValidationFrame {
    fn enter(schema: &JsValue, data: SchemaData<'_>) -> Option<Self> {
        let tag = match data {
            SchemaData::Json(_) => 0,
            SchemaData::Function => 1,
            SchemaData::Undefined => 2,
            SchemaData::Prototype => 3,
        };
        let key = (
            std::ptr::from_ref(schema) as usize,
            std::ptr::from_ref(data.value()) as usize,
            tag,
        );
        VALIDATION_STACK.with(|state| {
            let mut state = state.borrow_mut();
            if state.cycle {
                return None;
            }
            if !state.active.insert(key) {
                state.cycle = true;
                return None;
            }
            Some(Self(key))
        })
    }
    fn failed() -> bool {
        VALIDATION_STACK.with(|state| state.borrow().cycle)
    }
}
impl Drop for ValidationFrame {
    fn drop(&mut self) {
        VALIDATION_STACK.with(|state| {
            state.borrow_mut().active.remove(&self.0);
        });
    }
}
// Distinguish compile-time coverage from the runtime counter emitted by the
// qualified validator. Runtime `true` and an unset variable have observable
// coercion behavior at unevaluatedItems; neither is a static all-items marker.
#[derive(Clone, Copy)]
struct EvaluatedItems {
    dynamic: bool,
    value: Option<usize>,
}
impl EvaluatedItems {
    fn absent() -> Self {
        Self {
            dynamic: false,
            value: None,
        }
    }
    fn merge(&mut self, next: Self, conditional: bool, selected: bool) {
        if next.value.is_none() && !next.dynamic {
            return;
        }
        if !self.dynamic && self.value == Some(usize::MAX) {
            return;
        }
        if conditional {
            self.dynamic = true;
            if !selected {
                return;
            }
        }
        if next.dynamic {
            self.dynamic = true;
        }
        if let Some(value) = next.value {
            self.value = Some(self.value.map_or(value, |old| old.max(value)));
        }
    }
}
impl CompiledMailReplySchema {
    pub fn compile(schema: &JsValue) -> Result<Self, MailSchemaCompileError> {
        let encoded = crate::canonical_mail_json(schema);
        if encoded.len() > 65536 {
            return Err(MailSchemaCompileError::error(format!(
                "reply schema is {} bytes; maximum is 65536",
                encoded.len()
            )));
        }
        if schema.is_null() {
            return Err(MailSchemaCompileError {
                name: "TypeError",
                message: "null is not an object (evaluating 'schema.$schema')".into(),
            });
        }
        if let Some(dialect) = schema.get("$schema")
            && !matches!(
                dialect.as_str(),
                Some(DIALECT) | Some("https://json-schema.org/draft/2020-12/schema#")
            )
        {
            return Err(MailSchemaCompileError::error(format!(
                "reply schema dialect must be {DIALECT}; received {}",
                dialect.as_str().unwrap_or(&dialect.stringify())
            )));
        }
        let mut refs = vec![];
        remote_refs(schema, &"$".into(), &mut refs);
        if !refs.is_empty() {
            let mut units = vec![];
            for (i, reference) in refs.iter().enumerate() {
                if i > 0 {
                    units.extend(", ".encode_utf16())
                }
                units.extend(reference.utf16())
            }
            return Err(MailSchemaCompileError::error(joined(
                "reply schema must be self-contained; remote references: ",
                &JsString::from_utf16(units),
                "",
            )));
        }
        let mut cache = COMPILED
            .get_or_init(Default::default)
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        if let Some(compiled) = cache.schemas.get(&encoded) {
            return Ok(compiled.clone());
        }
        if let Some(id) = schema.get("$id").and_then(JsValue::as_str) {
            let id = id
                .strip_suffix("#/")
                .or_else(|| id.strip_suffix('#'))
                .unwrap_or(id);
            if !id.is_empty() && !id.starts_with('#') && !cache.ids.insert(id.to_owned()) {
                return Err(MailSchemaCompileError::error(format!(
                    "schema with key or id \"{id}\" already exists"
                )));
            }
        }
        if let Some(id) = schema.get("$id")
            && !id.is_string()
            && (id.is_object()
                || id.is_array()
                || id.as_bool() == Some(true)
                || id.as_f64().is_some_and(|n| n != 0.0))
        {
            return Err(MailSchemaCompileError { name: "TypeError", message: "id.replace is not a function. (In 'id.replace(TRAILING_SLASH_HASH, \"\")', 'id.replace' is undefined)".into() });
        }
        if !schema.is_object() && !schema.is_array() && !schema.is_boolean() {
            return Err(MailSchemaCompileError::error(
                "schema must be object or boolean",
            ));
        }
        Self::validate_meta(schema)?;
        let mut compiled = Self {
            root: schema.clone(),
            patterns: BTreeMap::new(),
            visited_references: Default::default(),
        };
        let base = schema
            .get("$id")
            .and_then(JsValue::as_str)
            .map(|id| format!("{}#", id.trim_end_matches('#')))
            .unwrap_or_else(|| "#".into());
        compiled.strict(schema, &base.into(), &[])?;
        cache.schemas.insert(encoded, compiled.clone());
        Ok(compiled)
    }
    fn validate_meta(schema: &JsValue) -> Result<(), MailSchemaCompileError> {
        // Qualified immutable meta-schema data, evaluated in process without
        // package loading, remote resolution, or a JavaScript runtime.
        static META: std::sync::OnceLock<CompiledMailReplySchema> = std::sync::OnceLock::new();
        let meta = META.get_or_init(|| {
            let root = json::parse(include_str!("reply_schema_meta.json"))
                .expect("bundled meta-schema JSON");
            let mut patterns = BTreeMap::new();
            fn collect(value: &JsValue, patterns: &mut BTreeMap<Vec<u16>, regress::Regex>) {
                if let Some(pattern) = value.get("pattern").and_then(JsValue::as_js_string) {
                    let points = char::decode_utf16(pattern.utf16().iter().copied()).map(|c| {
                        c.map(u32::from)
                            .unwrap_or_else(|e| u32::from(e.unpaired_surrogate()))
                    });
                    patterns.insert(
                        pattern.utf16().to_vec(),
                        regress::Regex::from_unicode(points, "u").expect("bundled meta pattern"),
                    );
                }
                match value {
                    JsValue::Object(object) => {
                        for (_, child) in object.iter() {
                            collect(child, patterns);
                        }
                    }
                    JsValue::Array(items) => {
                        for child in items {
                            collect(child, patterns);
                        }
                    }
                    _ => {}
                }
            }
            collect(&root, &mut patterns);
            CompiledMailReplySchema {
                root,
                patterns,
                visited_references: Default::default(),
            }
        });
        if let MailReplyValidation::Invalid { errors, .. } = meta.validate(schema)? {
            let mut units = "schema is invalid: ".encode_utf16().collect::<Vec<_>>();
            for (index, error) in errors.iter().enumerate() {
                if index > 0 {
                    units.extend(", ".encode_utf16());
                }
                units.extend("data".encode_utf16());
                units.extend(error.instance_path.utf16());
                units.push(32);
                units.extend(error.message.utf16());
            }
            return Err(MailSchemaCompileError::error(JsString::from_utf16(units)));
        }
        Ok(())
    }
    fn strict(
        &mut self,
        schema: &JsValue,
        path: &JsString,
        inherited: &[String],
    ) -> Result<(), MailSchemaCompileError> {
        if schema.is_boolean() {
            return Ok(());
        }
        let Some(object) = schema.as_object() else {
            if schema.is_array() {
                return Err(MailSchemaCompileError::error(format!(
                    "schema is invalid: {}",
                    ["data must be object,boolean"; 8].join(", ")
                )));
            }
            return Err(MailSchemaCompileError::error(
                "schema must be object or boolean",
            ));
        };
        for key in [
            "maxLength",
            "minLength",
            "maxItems",
            "minItems",
            "maxProperties",
            "minProperties",
            "minContains",
            "maxContains",
        ] {
            if let Some(limit) = object.get(key) {
                if limit
                    .as_f64()
                    .is_none_or(|n| !n.is_finite() || n.fract() != 0.0)
                {
                    return Err(MailSchemaCompileError::error(format!(
                        "schema is invalid: data/{key} must be integer"
                    )));
                }
                if limit.as_f64().is_some_and(|n| n < 0.0) {
                    return Err(MailSchemaCompileError::error(format!(
                        "schema is invalid: data/{key} must be >= 0"
                    )));
                }
            }
        }
        if object
            .get("multipleOf")
            .and_then(JsValue::as_f64)
            .is_some_and(|n| n <= 0.0)
        {
            return Err(MailSchemaCompileError::error(
                "schema is invalid: data/multipleOf must be > 0",
            ));
        }
        if object.get("uniqueItems").is_some_and(|v| !v.is_boolean()) {
            return Err(MailSchemaCompileError::error(
                "schema is invalid: data/uniqueItems must be boolean",
            ));
        }
        if object.get("required").is_some_and(|v| !v.is_array()) {
            return Err(MailSchemaCompileError::error(
                "schema is invalid: data/required must be array",
            ));
        }
        for key in [
            "properties",
            "patternProperties",
            "$defs",
            "definitions",
            "dependentSchemas",
            "dependentRequired",
            "dependencies",
        ] {
            if object.get(key).is_some_and(|v| !v.is_object()) {
                return Err(MailSchemaCompileError::error(format!(
                    "schema is invalid: data/{key} must be object"
                )));
            }
        }
        if object
            .get("items")
            .is_some_and(|v| !v.is_object() && !v.is_boolean())
        {
            return Err(MailSchemaCompileError::error(format!(
                "schema is invalid: {}",
                ["data/items must be object,boolean"; 8].join(", ")
            )));
        }
        if object
            .get("enum")
            .and_then(JsValue::as_array)
            .is_some_and(Vec::is_empty)
        {
            return Err(MailSchemaCompileError::error(
                "enum must have non-empty array",
            ));
        }
        if object.contains_key("nullable") && !object.contains_key("type") {
            return Err(MailSchemaCompileError::error(
                "\"nullable\" cannot be used without \"type\"",
            ));
        }
        if let Some(types) = object.get("type").and_then(JsValue::as_array) {
            if types.is_empty() {
                return Err(MailSchemaCompileError::error(
                    "schema is invalid: data/type must be equal to one of the allowed values, data/type must NOT have fewer than 1 items, data/type must match a schema in anyOf",
                ));
            }
            for i in (1..types.len()).rev() {
                for j in (0..i).rev() {
                    if types[i] == types[j] {
                        return Err(MailSchemaCompileError::error(format!(
                            "schema is invalid: data/type must be equal to one of the allowed values, data/type must NOT have duplicate items (items ## {j} and {i} are identical), data/type must match a schema in anyOf"
                        )));
                    }
                }
            }
            if types.iter().any(|ty| ty.as_str() == Some("null"))
                && object.get("nullable") == Some(&JsValue::Bool(false))
            {
                return Err(MailSchemaCompileError::error(
                    "type: null contradicts nullable: false",
                ));
            }
        }
        for key in [
            "maximum",
            "minimum",
            "exclusiveMaximum",
            "exclusiveMinimum",
            "multipleOf",
        ] {
            if object.get(key).is_some_and(|v| !v.is_number()) {
                return Err(MailSchemaCompileError::error(format!(
                    "schema is invalid: data/{key} must be number"
                )));
            }
        }
        if let Some(required) = object.get("required").and_then(JsValue::as_array) {
            for i in (1..required.len()).rev() {
                for j in (0..i).rev() {
                    if required[i] == required[j] {
                        return Err(MailSchemaCompileError::error(format!(
                            "schema is invalid: data/required must NOT have duplicate items (items ## {i} and {j} are identical)"
                        )));
                    }
                }
            }
        }

        const KNOWN: &[&str] = &[
            "$schema",
            "$id",
            "$ref",
            "$dynamicRef",
            "$dynamicAnchor",
            "$defs",
            "definitions",
            "$comment",
            "$vocabulary",
            "type",
            "nullable",
            "const",
            "enum",
            "allOf",
            "anyOf",
            "oneOf",
            "not",
            "if",
            "then",
            "else",
            "maximum",
            "minimum",
            "exclusiveMaximum",
            "exclusiveMinimum",
            "multipleOf",
            "maxLength",
            "minLength",
            "pattern",
            "format",
            "maxItems",
            "minItems",
            "uniqueItems",
            "prefixItems",
            "items",
            "contains",
            "minContains",
            "maxContains",
            "unevaluatedItems",
            "maxProperties",
            "minProperties",
            "required",
            "properties",
            "patternProperties",
            "additionalProperties",
            "dependentRequired",
            "dependentSchemas",
            "dependencies",
            "propertyNames",
            "unevaluatedProperties",
            "title",
            "description",
            "default",
            "deprecated",
            "readOnly",
            "writeOnly",
            "examples",
            "contentEncoding",
            "contentMediaType",
            "contentSchema",
        ];
        for (key, _) in entries(object) {
            if !key.as_str().is_some_and(|key| KNOWN.contains(&key)) {
                return Err(MailSchemaCompileError::error(joined(
                    "strict mode: unknown keyword: \"",
                    key,
                    "\"",
                )));
            }
        }
        let mut types = vec![];
        if let Some(kind) = object.get("type") {
            if let Some(kind) = kind.as_str() {
                types.push(kind.to_owned())
            } else if let Some(kinds) = kind.as_array() {
                for kind in kinds {
                    if let Some(kind) = kind.as_str() {
                        types.push(kind.to_owned())
                    } else {
                        return Err(MailSchemaCompileError::error(
                            "schema is invalid: data/type must be equal to one of the allowed values, data/type must be array, data/type must match a schema in anyOf",
                        ));
                    }
                }
            } else {
                return Err(MailSchemaCompileError::error(
                    "schema is invalid: data/type must be equal to one of the allowed values, data/type must be array, data/type must match a schema in anyOf",
                ));
            }
            if types.iter().any(|kind| {
                ![
                    "null", "boolean", "object", "array", "number", "string", "integer",
                ]
                .contains(&kind.as_str())
            }) {
                return Err(MailSchemaCompileError::error(
                    "schema is invalid: data/type must be equal to one of the allowed values, data/type must be array, data/type must match a schema in anyOf",
                ));
            }
            if types.len() > 1 && !(types.len() == 2 && types.iter().any(|kind| kind == "null")) {
                return Err(MailSchemaCompileError::error(joined(
                    "strict mode: use allowUnionTypes to allow union type keyword at \"",
                    path,
                    "\" (strictTypes)",
                )));
            }
        }
        if types.is_empty() {
            types = inherited.to_vec()
        }
        // Match the qualified Ajv vocabulary's rule registration order.
        for (keyword, kinds) in [
            ("maximum", &["number"] as &[&str]),
            ("minimum", &["number"] as &[&str]),
            ("exclusiveMaximum", &["number"] as &[&str]),
            ("exclusiveMinimum", &["number"] as &[&str]),
            ("multipleOf", &["number"] as &[&str]),
            ("maxLength", &["string"] as &[&str]),
            ("minLength", &["string"] as &[&str]),
            ("pattern", &["string"] as &[&str]),
            ("maxProperties", &["object"] as &[&str]),
            ("minProperties", &["object"] as &[&str]),
            ("required", &["object"] as &[&str]),
            ("maxItems", &["array"] as &[&str]),
            ("minItems", &["array"] as &[&str]),
            ("uniqueItems", &["array"] as &[&str]),
            ("propertyNames", &["object"] as &[&str]),
            ("additionalProperties", &["object"] as &[&str]),
            ("dependencies", &["object"] as &[&str]),
            ("properties", &["object"] as &[&str]),
            ("patternProperties", &["object"] as &[&str]),
            ("prefixItems", &["array"] as &[&str]),
            ("items", &["array"] as &[&str]),
            ("contains", &["array"] as &[&str]),
            ("format", &["number", "string"] as &[&str]),
            ("dependentRequired", &["object"] as &[&str]),
            ("dependentSchemas", &["object"] as &[&str]),
            ("maxContains", &["array"] as &[&str]),
            ("minContains", &["array"] as &[&str]),
            ("unevaluatedProperties", &["object"] as &[&str]),
            ("unevaluatedItems", &["array"] as &[&str]),
        ] {
            if object.contains_key(keyword)
                && !kinds.iter().any(|kind| {
                    types
                        .iter()
                        .any(|ty| ty == kind || (*kind == "number" && ty == "integer"))
                })
            {
                return Err(MailSchemaCompileError::error(JsString::concat(&[
                    format!(
                        "strict mode: missing type \"{}\" for keyword \"{keyword}\" at \"",
                        kinds.join(",")
                    )
                    .into(),
                    path.clone(),
                    "\" (strictTypes)".into(),
                ])));
            }
        }
        if object.contains_key("if") && !object.contains_key("then") && !object.contains_key("else")
        {
            return Err(MailSchemaCompileError::error(
                "strict mode: \"if\" without \"then\" and \"else\" is ignored",
            ));
        }
        for keyword in ["then", "else"] {
            if object.contains_key(keyword) && !object.contains_key("if") {
                return Err(MailSchemaCompileError::error(format!(
                    "strict mode: \"{keyword}\" without \"if\" is ignored"
                )));
            }
        }
        if let Some(tuple) = object.get("prefixItems").and_then(JsValue::as_array) {
            let n = tuple.len() as u64;
            if object.get("minItems").and_then(JsValue::as_u64) != Some(n)
                || !(object.get("items") == Some(&JsValue::Bool(false))
                    || object.get("maxItems").and_then(JsValue::as_u64) == Some(n))
            {
                return Err(MailSchemaCompileError::error(JsString::concat(&[format!("strict mode: \"prefixItems\" is {n}-tuple, but minItems or maxItems/items are not specified or different at path \"").into(),path.clone(),"\"".into()])));
            }
        }

        for keyword in ["maxContains", "minContains"] {
            if object.contains_key(keyword) && !object.contains_key("contains") {
                return Err(MailSchemaCompileError::error(format!(
                    "strict mode: \"{keyword}\" without \"contains\" is ignored"
                )));
            }
        }
        if object.contains_key("contains") {
            let min = object
                .get("minContains")
                .and_then(JsValue::as_u64)
                .unwrap_or(1);
            let max = object.get("maxContains").and_then(JsValue::as_u64);
            if min == 0 && max.is_none() {
                return Err(MailSchemaCompileError::error(
                    "strict mode: \"minContains\" == 0 without \"maxContains\": \"contains\" keyword ignored",
                ));
            }
            if max.is_some_and(|max| min > max) {
                return Err(MailSchemaCompileError::error(
                    "strict mode: \"minContains\" > \"maxContains\" is always invalid",
                ));
            }
        }
        if let Some(reference) = object.get("$ref").and_then(JsValue::as_str) {
            let identity = format!("{reference}:{inherited:?}");
            if self.visited_references.insert(identity) {
                let target = self.resolve(reference).cloned().ok_or_else(|| {
                    MailSchemaCompileError::error(format!(
                        "can't resolve reference {reference} from id {}",
                        self.root
                            .get("$id")
                            .and_then(JsValue::as_str)
                            .unwrap_or("#")
                    ))
                })?;
                let base = self
                    .root
                    .get("$id")
                    .and_then(JsValue::as_str)
                    .unwrap_or("")
                    .trim_end_matches('#');
                self.strict(&target, &format!("{base}{reference}").into(), &types)?;
            }
        }
        for keyword in ["pattern"] {
            if let Some(pattern) = object.get(keyword).and_then(JsValue::as_js_string) {
                let points: Vec<u32> = char::decode_utf16(pattern.utf16().iter().copied())
                    .map(|c| {
                        c.map(u32::from)
                            .unwrap_or_else(|e| e.unpaired_surrogate() as u32)
                    })
                    .collect();
                let regex = regress::Regex::from_unicode(points.into_iter(), "u")
                    .map_err(|e| regex_compile_error(&e.to_string()))?;
                self.patterns.insert(pattern.utf16().to_vec(), regex);
            }
        }
        let properties = object.get("properties").and_then(JsValue::as_object);
        if let Some(required) = object.get("required").and_then(JsValue::as_array) {
            for key in required {
                if let Some(key) = key.as_js_string()
                    && !properties.is_some_and(|p| p.get_utf16(key).is_some())
                {
                    return Err(MailSchemaCompileError::error(JsString::concat(&[
                        "strict mode: required property \"".into(),
                        key.clone(),
                        "\" is not defined at \"".into(),
                        path.clone(),
                        "\" (strictRequired)".into(),
                    ])));
                }
            }
        }
        for keyword in ["properties", "patternProperties", "dependentSchemas"] {
            if let Some(children) = object.get(keyword).and_then(JsValue::as_object) {
                for (key, child) in entries(children) {
                    if key.as_str().is_none() {
                        return Err(MailSchemaCompileError {
                            name: "URIError",
                            message: "String contained an illegal UTF-16 sequence.".into(),
                        });
                    }
                    if keyword == "patternProperties" {
                        let points: Vec<u32> = char::decode_utf16(key.utf16().iter().copied())
                            .map(|c| {
                                c.map(u32::from)
                                    .unwrap_or_else(|e| e.unpaired_surrogate() as u32)
                            })
                            .collect();
                        let regex = regress::Regex::from_unicode(points.into_iter(), "u")
                            .map_err(|e| regex_compile_error(&e.to_string()))?;
                        self.patterns.insert(key.utf16().to_vec(), regex);
                        if let Some(properties) =
                            object.get("properties").and_then(JsValue::as_object)
                        {
                            for property in properties.keys() {
                                if property.as_str() != Some("__proto__")
                                    && self.matches(key, property)
                                {
                                    return Err(MailSchemaCompileError::error(JsString::concat(
                                        &[
                                            "strict mode: property ".into(),
                                            property.clone(),
                                            " matches pattern ".into(),
                                            key.clone(),
                                            " (use allowMatchingProperties)".into(),
                                        ],
                                    )));
                                }
                            }
                        }
                    }
                    let inherited = if keyword == "dependentSchemas" {
                        types.as_slice()
                    } else {
                        &[]
                    };
                    self.strict(
                        child,
                        &pointer(&pointer(path, &keyword.into()), key),
                        inherited,
                    )?;
                }
            }
        }
        for keyword in ["anyOf", "oneOf", "allOf", "prefixItems"] {
            if let Some(children) = object.get(keyword).and_then(JsValue::as_array) {
                for (i, child) in children.iter().enumerate() {
                    self.strict(
                        child,
                        &pointer(&pointer(path, &keyword.into()), &i.to_string().into()),
                        if keyword == "prefixItems" {
                            &[]
                        } else {
                            &types
                        },
                    )?
                }
            }
        }
        for keyword in [
            "not",
            "if",
            "then",
            "else",
            "items",
            "contains",
            "additionalProperties",
            "propertyNames",
            "unevaluatedItems",
            "unevaluatedProperties",
        ] {
            if let Some(child) = object.get(keyword) {
                let property_names_type = vec!["string".to_owned()];
                let inherited = if matches!(keyword, "not" | "if" | "then" | "else") {
                    types.as_slice()
                } else if keyword == "propertyNames" {
                    property_names_type.as_slice()
                } else {
                    &[]
                };
                self.strict(child, &pointer(path, &keyword.into()), inherited)?;
            }
        }
        Ok(())
    }
    fn resolve(&self, reference: &str) -> Option<&JsValue> {
        fn anchor<'a>(value: &'a JsValue, name: &str) -> Option<&'a JsValue> {
            if value
                .get("$anchor")
                .or_else(|| value.get("$dynamicAnchor"))
                .and_then(JsValue::as_str)
                == Some(name)
            {
                return Some(value);
            }
            match value {
                JsValue::Object(object) => object.iter().find_map(|(_, v)| anchor(v, name)),
                JsValue::Array(items) => items.iter().find_map(|v| anchor(v, name)),
                _ => None,
            }
        }
        fn decode(s: &str) -> Option<String> {
            let mut result = vec![];
            let bytes = s.as_bytes();
            let mut i = 0;
            while i < bytes.len() {
                if bytes[i] == b'%' {
                    result.push(u8::from_str_radix(s.get(i + 1..i + 3)?, 16).ok()?);
                    i += 3
                } else {
                    result.push(bytes[i]);
                    i += 1
                }
            }
            String::from_utf8(result).ok()
        }
        if reference == "#" {
            return Some(&self.root);
        }
        if let Some(name) = reference.strip_prefix('#')
            && !name.starts_with('/')
        {
            return anchor(&self.root, &decode(name)?);
        }
        let tail = decode(reference.strip_prefix("#/")?)?;
        let mut value = &self.root;
        for part in tail.split('/') {
            let key = part.replace("~1", "/").replace("~0", "~");
            value = if let Some(object) = value.as_object() {
                object.get(&key)?
            } else {
                value.as_array()?.get(key.parse::<usize>().ok()?)?
            };
        }
        Some(value)
    }
    fn matches(&self, pattern: &JsString, text: &JsString) -> bool {
        self.patterns
            .get(pattern.utf16())
            .is_some_and(|regex| regex.find_from_utf16(text.utf16(), 0).next().is_some())
    }
    fn evaluated(
        &self,
        schema: &JsValue,
        data: SchemaData<'_>,
        include_post: bool,
    ) -> (std::collections::BTreeSet<Vec<u16>>, usize) {
        let mut props = std::collections::BTreeSet::new();
        let mut items = 0;
        if ValidationFrame::failed() {
            return (props, items);
        }
        let Some(object) = schema.as_object() else {
            return (props, items);
        };
        if let Some(properties) = data.value().as_object() {
            if let Some(declared) = object.get("properties").and_then(JsValue::as_object) {
                for key in declared.keys() {
                    if key.as_str() != Some("__proto__") {
                        props.insert(key.utf16().to_vec());
                    }
                }
            }
            if let Some(patterns) = object.get("patternProperties").and_then(JsValue::as_object) {
                for key in properties.keys() {
                    if patterns.keys().any(|pattern| self.matches(pattern, key)) {
                        props.insert(key.utf16().to_vec());
                    }
                }
            }
            if object.contains_key("additionalProperties")
                || (include_post && object.contains_key("unevaluatedProperties"))
            {
                props.extend(properties.keys().map(|key| key.utf16().to_vec()))
            }
        }
        if data.value().is_array() {
            if let Some(prefix) = object.get("prefixItems").and_then(JsValue::as_array) {
                items = prefix.len()
            }
            if object.contains_key("items")
                || object.contains_key("contains")
                || (include_post && object.contains_key("unevaluatedItems"))
            {
                items = usize::MAX
            }
        }
        let mut merge = |next: (std::collections::BTreeSet<Vec<u16>>, usize)| {
            props.extend(next.0);
            items = items.max(next.1);
        };
        for keyword in ["$ref", "$dynamicRef"] {
            if let Some(reference) = object.get(keyword).and_then(JsValue::as_str)
                && let Some(child) = self.resolve(reference)
            {
                merge(self.evaluated(child, data, true));
            }
        }
        if let Some(children) = object.get("allOf").and_then(JsValue::as_array) {
            for child in children {
                merge(self.evaluated(child, data, true));
            }
        }
        for keyword in ["anyOf", "oneOf"] {
            if let Some(children) = object.get(keyword).and_then(JsValue::as_array) {
                for child in children {
                    let mut errors = vec![];
                    self.visit_data(child, data, &JsString::default(), &mut errors);
                    if errors.is_empty() {
                        merge(self.evaluated(child, data, true));
                        if keyword == "oneOf" {
                            break;
                        }
                    }
                }
            }
        }
        if let Some(condition) = object.get("if") {
            let mut errors = vec![];
            self.visit_data(condition, data, &JsString::default(), &mut errors);
            let then_selected = errors.is_empty();
            let keyword = if then_selected { "then" } else { "else" };
            if let Some(clause) = object.get(keyword) {
                errors.clear();
                self.visit_data(clause, data, &JsString::default(), &mut errors);
                if errors.is_empty() {
                    if then_selected || !object.contains_key("then") {
                        merge(self.evaluated(condition, data, true));
                    }
                    merge(self.evaluated(clause, data, true));
                }
            }
        }
        for keyword in ["dependentSchemas", "dependencies"] {
            if let Some(dependencies) = object.get(keyword).and_then(JsValue::as_object) {
                for (key, child) in entries(dependencies) {
                    if !child.is_array() && data.lookup(key).is_some() {
                        let mut errors = vec![];
                        self.visit_data(child, data, &JsString::default(), &mut errors);
                        if errors.is_empty() {
                            merge(self.evaluated(child, data, true));
                        }
                    }
                }
            }
        }
        (props, items)
    }
    fn evaluated_items(
        &self,
        schema: &JsValue,
        data: SchemaData<'_>,
        include_post: bool,
    ) -> EvaluatedItems {
        let mut result = EvaluatedItems::absent();
        if ValidationFrame::failed() {
            return result;
        }
        let Some(object) = schema.as_object() else {
            return result;
        };
        for keyword in ["$ref", "$dynamicRef"] {
            if let Some(reference) = object.get(keyword).and_then(JsValue::as_str)
                && let Some(child) = self.resolve(reference)
            {
                result.merge(self.evaluated_items(child, data, true), false, true);
            }
        }
        for keyword in ["anyOf", "oneOf"] {
            if let Some(children) = object.get(keyword).and_then(JsValue::as_array) {
                let mut matched = false;
                for child in children {
                    let mut errors = vec![];
                    self.visit_data(child, data, &JsString::default(), &mut errors);
                    let valid = errors.is_empty();
                    let mark = self.evaluated_items(child, data, true);
                    result.merge(mark, true, valid && !(keyword == "oneOf" && matched));
                    matched |= valid;
                }
            }
        }
        if let Some(children) = object.get("allOf").and_then(JsValue::as_array) {
            for child in children {
                result.merge(self.evaluated_items(child, data, true), false, true);
            }
        }
        if let Some(condition) = object.get("if") {
            let mut errors = vec![];
            self.visit_data(condition, data, &JsString::default(), &mut errors);
            let selected_then = errors.is_empty();
            for keyword in ["then", "else"] {
                if let Some(clause) = object.get(keyword) {
                    let mut mark = self.evaluated_items(clause, data, true);
                    if keyword == "then" || !object.contains_key("then") {
                        mark.merge(self.evaluated_items(condition, data, true), false, true);
                    }
                    errors.clear();
                    self.visit_data(clause, data, &JsString::default(), &mut errors);
                    result.merge(
                        mark,
                        true,
                        (keyword == "then") == selected_then && errors.is_empty(),
                    );
                }
            }
        }
        if let Some(prefix) = object.get("prefixItems").and_then(JsValue::as_array) {
            result.merge(
                EvaluatedItems {
                    dynamic: false,
                    value: Some(prefix.len()),
                },
                false,
                true,
            );
        }
        if object.contains_key("items")
            || object.contains_key("contains")
            || (include_post && object.contains_key("unevaluatedItems"))
        {
            result = EvaluatedItems {
                dynamic: false,
                value: Some(usize::MAX),
            };
        }
        result
    }
    fn dynamic_evaluated_props(&self, schema: &JsValue, data: SchemaData<'_>) -> bool {
        let Some(object) = schema.as_object() else {
            return false;
        };
        for keyword in ["anyOf", "oneOf"] {
            if let Some(children) = object.get(keyword).and_then(JsValue::as_array) {
                for child in children {
                    let mut errors = vec![];
                    self.visit_data(child, data, &JsString::default(), &mut errors);
                    if errors.is_empty() {
                        if !self.evaluated(child, data, true).0.is_empty() {
                            return true;
                        }
                        if keyword == "oneOf" {
                            break;
                        }
                    }
                }
            }
        }
        if let Some(children) = object.get("allOf").and_then(JsValue::as_array)
            && children
                .iter()
                .any(|child| self.dynamic_evaluated_props(child, data))
        {
            return true;
        }
        for keyword in ["$ref", "$dynamicRef"] {
            if let Some(reference) = object.get(keyword).and_then(JsValue::as_str)
                && let Some(child) = self.resolve(reference)
                && self.dynamic_evaluated_props(child, data)
            {
                return true;
            }
        }
        for keyword in ["dependentSchemas", "dependencies"] {
            if let Some(dependencies) = object.get(keyword).and_then(JsValue::as_object) {
                for (key, child) in entries(dependencies) {
                    if !child.is_array() && data.lookup(key).is_some() {
                        let mut errors = vec![];
                        self.visit_data(child, data, &JsString::default(), &mut errors);
                        if errors.is_empty() && !self.evaluated(child, data, true).0.is_empty() {
                            return true;
                        }
                    }
                }
            }
        }
        if let Some(child) = object.get("if") {
            let mut errors = vec![];
            self.visit_data(child, data, &JsString::default(), &mut errors);
            let keyword = if errors.is_empty() { "then" } else { "else" };
            if let Some(child) = object.get(keyword) {
                errors.clear();
                self.visit_data(child, data, &JsString::default(), &mut errors);
                if errors.is_empty() && !self.evaluated(child, data, true).0.is_empty() {
                    return true;
                }
            }
        }
        false
    }
    pub fn validate(&self, value: &JsValue) -> Result<MailReplyValidation, MailSchemaCompileError> {
        VALIDATION_STACK.with(|state| *state.borrow_mut() = ValidationStack::default());
        let mut errors = vec![];
        self.visit(&self.root, value, &JsString::default(), &mut errors);
        if ValidationFrame::failed() {
            return Err(MailSchemaCompileError {
                name: "RangeError",
                message: "Maximum call stack size exceeded.".into(),
            });
        }
        Ok(if errors.is_empty() {
            MailReplyValidation::Valid { valid: true }
        } else {
            MailReplyValidation::Invalid {
                valid: false,
                errors,
            }
        })
    }
    fn visit(
        &self,
        schema: &JsValue,
        value: &JsValue,
        path: &JsString,
        errors: &mut Vec<MailSchemaValidationError>,
    ) {
        self.visit_data(schema, SchemaData::Json(value), path, errors)
    }
    fn visit_data(
        &self,
        schema: &JsValue,
        data: SchemaData<'_>,
        path: &JsString,
        errors: &mut Vec<MailSchemaValidationError>,
    ) {
        let Some(_frame) = ValidationFrame::enter(schema, data) else {
            return;
        };
        let value = data.value();
        let push = |errors: &mut Vec<_>, keyword: &str, message: JsString, params: JsValue| {
            errors.push(MailSchemaValidationError {
                instance_path: path.clone(),
                keyword: keyword.into(),
                message,
                params: params.as_object().cloned().unwrap_or_default(),
            });
        };
        if schema == &JsValue::Bool(false) {
            push(
                errors,
                "false schema",
                "boolean schema is false".into(),
                json::json!({}),
            );
            return;
        }
        let Some(object) = schema.as_object() else {
            return;
        };
        for keyword in ["$ref", "$dynamicRef"] {
            if let Some(reference) = object.get(keyword).and_then(JsValue::as_str) {
                let target = if keyword == "$dynamicRef" {
                    Some(&self.root)
                } else {
                    self.resolve(reference)
                };
                if let Some(target) = target {
                    self.visit_data(target, data, path, errors)
                }
            }
        }
        let mut type_errors = vec![];
        if let Some(kind) = object.get("type") {
            let kinds: Vec<_> = if let Some(kind) = kind.as_str() {
                vec![kind]
            } else {
                kind.as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(JsValue::as_str)
                    .collect()
            };
            if !kinds.iter().any(|kind| data.is_type(kind))
                && !(data.is_type("null")
                    && object.get("nullable").and_then(JsValue::as_bool) == Some(true))
            {
                push(
                    &mut type_errors,
                    "type",
                    format!("must be {}", kinds.join(",")).into(),
                    json::json!({"type":kind}),
                );
            }
        }
        let defer_type = object
            .get("type")
            .and_then(JsValue::as_str)
            .is_some_and(|kind| {
                let keys: &[&str] = match kind {
                    "object" => &[
                        "maxProperties",
                        "minProperties",
                        "required",
                        "properties",
                        "patternProperties",
                        "additionalProperties",
                        "dependentRequired",
                        "dependentSchemas",
                        "dependencies",
                        "propertyNames",
                        "unevaluatedProperties",
                    ],
                    "array" => &[
                        "maxItems",
                        "minItems",
                        "items",
                        "prefixItems",
                        "uniqueItems",
                        "contains",
                        "unevaluatedItems",
                    ],
                    "string" => &["maxLength", "minLength", "pattern", "format"],
                    "number" => &[
                        "maximum",
                        "minimum",
                        "exclusiveMaximum",
                        "exclusiveMinimum",
                        "multipleOf",
                        "format",
                    ],
                    _ => &[],
                };
                keys.iter().any(|key| object.contains_key(key))
            })
            && object.get("nullable") != Some(&JsValue::Bool(true));
        if !defer_type {
            errors.extend(type_errors.clone())
        }
        if let Some(constant) = object.get("const")
            && !data.equals(constant)
        {
            push(
                errors,
                "const",
                "must be equal to constant".into(),
                json::json!({"allowedValue":constant}),
            );
        }
        if let Some(options) = object.get("enum").and_then(JsValue::as_array)
            && !options.iter().any(|option| data.equals(option))
        {
            push(
                errors,
                "enum",
                "must be equal to one of the allowed values".into(),
                json::json!({"allowedValues":options}),
            );
        }
        if let Some(child) = object.get("not") {
            let mut branch = vec![];
            self.visit_data(child, data, path, &mut branch);
            if branch.is_empty() {
                push(errors, "not", "must NOT be valid".into(), json::json!({}));
            }
        }
        for keyword in ["anyOf", "oneOf"] {
            if let Some(children) = object.get(keyword).and_then(JsValue::as_array) {
                let mut branch_errors = vec![];
                let mut passing = vec![];
                for (i, child) in children.iter().enumerate() {
                    let mut branch = vec![];
                    self.visit_data(child, data, path, &mut branch);
                    if branch.is_empty() {
                        passing.push(i)
                    } else {
                        branch_errors.extend(branch)
                    }
                }
                if keyword == "anyOf" && passing.is_empty() {
                    errors.extend(branch_errors);
                    push(
                        errors,
                        "anyOf",
                        "must match a schema in anyOf".into(),
                        json::json!({}),
                    );
                } else if keyword == "oneOf" && passing.len() != 1 {
                    if passing.is_empty() {
                        errors.extend(branch_errors)
                    }
                    let passing = if passing.is_empty() {
                        JsValue::Null
                    } else {
                        json::json!(passing.into_iter().take(2).collect::<Vec<_>>())
                    };
                    push(
                        errors,
                        "oneOf",
                        "must match exactly one schema in oneOf".into(),
                        json::json!({"passingSchemas":passing}),
                    );
                }
            }
        }
        if let Some(children) = object.get("allOf").and_then(JsValue::as_array) {
            for child in children {
                self.visit_data(child, data, path, errors)
            }
        }
        if let Some(child) = object.get("if") {
            let mut branch = vec![];
            self.visit_data(child, data, path, &mut branch);
            let keyword = if branch.is_empty() { "then" } else { "else" };
            if let Some(child) = object.get(keyword) {
                let before = errors.len();
                self.visit_data(child, data, path, errors);
                if before != errors.len() {
                    push(
                        errors,
                        "if",
                        format!("must match \"{keyword}\" schema").into(),
                        json::json!({"failingKeyword":keyword}),
                    );
                }
            }
        }
        if defer_type {
            errors.extend(type_errors)
        }
        if !matches!(data, SchemaData::Function)
            && let Some(number) = value.as_f64()
        {
            for (keyword, comparison, predicate) in [
                ("maximum", "<=", number.is_finite()),
                ("minimum", ">=", number.is_finite()),
                ("exclusiveMaximum", "<", number.is_finite()),
                ("exclusiveMinimum", ">", number.is_finite()),
            ] {
                if let Some(limit) = object.get(keyword).and_then(JsValue::as_f64) {
                    let valid = predicate
                        && match keyword {
                            "maximum" => number <= limit,
                            "minimum" => number >= limit,
                            "exclusiveMaximum" => number < limit,
                            _ => number > limit,
                        };
                    if !valid {
                        push(
                            errors,
                            keyword,
                            format!(
                                "must be {comparison} {}",
                                JsValue::Number(limit).stringify()
                            )
                            .into(),
                            json::json!({"comparison":comparison,"limit":limit}),
                        );
                    }
                }
            }
            if let Some(divisor) = object.get("multipleOf").and_then(JsValue::as_f64) {
                let quotient = number / divisor;
                if divisor == 0.0 || quotient.fract() != 0.0 {
                    push(
                        errors,
                        "multipleOf",
                        format!(
                            "must be multiple of {}",
                            JsValue::Number(divisor).stringify()
                        )
                        .into(),
                        json::json!({"multipleOf":divisor}),
                    );
                }
            }
        }
        if !matches!(data, SchemaData::Function)
            && let Some(text) = value.as_js_string()
        {
            let length = char::decode_utf16(text.utf16().iter().copied()).count();
            for (keyword, comparison, valid) in
                [("maxLength", "more", true), ("minLength", "fewer", false)]
            {
                if let Some(limit) = object.get(keyword).and_then(JsValue::as_u64)
                    && if valid {
                        length > limit as usize
                    } else {
                        length < (limit as usize)
                    }
                {
                    push(
                        errors,
                        keyword,
                        format!("must NOT have {comparison} than {limit} characters").into(),
                        json::json!({"limit":limit}),
                    );
                }
            }
            if let Some(pattern) = object.get("pattern").and_then(JsValue::as_js_string)
                && !self.matches(pattern, text)
            {
                push(
                    errors,
                    "pattern",
                    joined("must match pattern \"", pattern, "\""),
                    json::json!({"pattern":pattern}),
                );
            }
        }
        if !matches!(data, SchemaData::Function)
            && let Some(items) = value.as_array()
        {
            for (keyword, comparison, maximum) in
                [("maxItems", "more", true), ("minItems", "fewer", false)]
            {
                if let Some(limit) = object.get(keyword).and_then(JsValue::as_u64)
                    && if maximum {
                        items.len() > limit as usize
                    } else {
                        items.len() < (limit as usize)
                    }
                {
                    push(
                        errors,
                        keyword,
                        format!("must NOT have {comparison} than {limit} items").into(),
                        json::json!({"limit":limit}),
                    );
                }
            }
            let mut prefix = 0;
            if let Some(tuple) = object.get("prefixItems").and_then(JsValue::as_array) {
                prefix = tuple.len();
                for (i, (child, item)) in tuple.iter().zip(items).enumerate() {
                    self.visit(child, item, &pointer(path, &i.to_string().into()), errors)
                }
            }
            if let Some(child) = object.get("items") {
                if child == &JsValue::Bool(false) && object.contains_key("prefixItems") {
                    if items.len() > prefix {
                        push(
                            errors,
                            "items",
                            format!("must NOT have more than {prefix} items").into(),
                            json::json!({"limit":prefix}),
                        );
                    }
                } else {
                    for (i, item) in items.iter().enumerate().skip(prefix) {
                        self.visit(child, item, &pointer(path, &i.to_string().into()), errors)
                    }
                }
            }
            if let Some(child) = object.get("contains") {
                let min = object
                    .get("minContains")
                    .and_then(JsValue::as_u64)
                    .unwrap_or(1);
                let max = object.get("maxContains").and_then(JsValue::as_u64);
                let mut count = 0;
                let mut branch_errors = vec![];
                for (i, item) in items.iter().enumerate() {
                    let mut branch = vec![];
                    self.visit(
                        child,
                        item,
                        &pointer(path, &i.to_string().into()),
                        &mut branch,
                    );
                    if branch.is_empty() {
                        count += 1
                    } else {
                        branch_errors.extend(branch)
                    }
                }
                if count < min || max.is_some_and(|max| count > max) {
                    errors.extend(branch_errors);
                    let mut params = json::json!({"minContains":min});
                    let message = if let Some(max) = max {
                        params["maxContains"] = json::json!(max);
                        format!("must contain at least {min} and no more than {max} valid item(s)")
                    } else {
                        format!("must contain at least {min} valid item(s)")
                    };
                    push(errors, "contains", message.into(), params)
                }
            }
            if object.get("uniqueItems").and_then(JsValue::as_bool) == Some(true) {
                let kinds = object
                    .get("items")
                    .and_then(|v| v.get("type"))
                    .map(|v| {
                        if let Some(kind) = v.as_str() {
                            vec![kind]
                        } else {
                            v.as_array()
                                .into_iter()
                                .flatten()
                                .filter_map(JsValue::as_str)
                                .collect()
                        }
                    })
                    .unwrap_or_default();
                if !kinds.is_empty() && !kinds.iter().any(|k| matches!(*k, "object" | "array")) {
                    let mut indices: BTreeMap<Vec<u16>, usize> = BTreeMap::new();
                    for i in (0..items.len()).rev() {
                        let item = &items[i];
                        if !kinds.iter().any(|kind| type_matches(item, kind)) {
                            continue;
                        }
                        let mut key = if let Some(text) = item.as_js_string() {
                            text.utf16().to_vec()
                        } else {
                            item.stringify().encode_utf16().collect()
                        };
                        if item.is_string() && kinds.len() > 1 {
                            key.push(95)
                        }
                        // Source uses an ordinary object for this primitive index.
                        if key == "__proto__".encode_utf16().collect::<Vec<_>>() {
                            continue;
                        }
                        if let Some(j) = indices.get(&key) {
                            push(errors,"uniqueItems",format!("must NOT have duplicate items (items ## {j} and {i} are identical)").into(),json::json!({"i":i,"j":j}));
                            break;
                        }
                        indices.insert(key, i);
                    }
                } else {
                    'outer: for i in (1..items.len()).rev() {
                        for j in (0..i).rev() {
                            if items[i] == items[j] {
                                push(errors,"uniqueItems",format!("must NOT have duplicate items (items ## {j} and {i} are identical)").into(),json::json!({"i":i,"j":j}));
                                break 'outer;
                            }
                        }
                    }
                }
            }
        }
        if let Some(array) = value.as_array()
            && let Some(child) = object.get("unevaluatedItems")
        {
            let evaluated = self.evaluated_items(schema, data, false);
            if !(evaluated.dynamic && evaluated.value.is_none()) {
                let dynamic_all = evaluated.dynamic && evaluated.value == Some(usize::MAX);
                let start = if dynamic_all {
                    1
                } else {
                    evaluated.value.unwrap_or(0)
                };
                if array.len() > start {
                    if child == &JsValue::Bool(false) {
                        let limit = if dynamic_all {
                            JsValue::Bool(true)
                        } else {
                            json::json!(start)
                        };
                        let message = if dynamic_all {
                            "true".to_owned()
                        } else {
                            start.to_string()
                        };
                        push(
                            errors,
                            "unevaluatedItems",
                            format!("must NOT have more than {message} items").into(),
                            json::json!({"limit":limit}),
                        );
                    } else {
                        if dynamic_all {
                            self.visit_data(
                                child,
                                SchemaData::Undefined,
                                &pointer(path, &"true".into()),
                                errors,
                            );
                        }
                        for (i, item) in
                            array
                                .iter()
                                .enumerate()
                                .skip(if dynamic_all { 2 } else { start })
                        {
                            self.visit(child, item, &pointer(path, &i.to_string().into()), errors);
                        }
                    }
                }
            }
        }

        if !matches!(data, SchemaData::Function)
            && let Some(properties) = value.as_object()
        {
            for (keyword, comparison, maximum) in [
                ("maxProperties", "more", true),
                ("minProperties", "fewer", false),
            ] {
                if let Some(limit) = object.get(keyword).and_then(JsValue::as_u64)
                    && if maximum {
                        properties.len() > limit as usize
                    } else {
                        properties.len() < (limit as usize)
                    }
                {
                    push(
                        errors,
                        keyword,
                        format!("must NOT have {comparison} than {limit} properties").into(),
                        json::json!({"limit":limit}),
                    );
                }
            }
            if let Some(required) = object.get("required").and_then(JsValue::as_array) {
                for key in required {
                    if let Some(key) = key.as_js_string()
                        && data.lookup(key).is_none()
                    {
                        push(
                            errors,
                            "required",
                            joined("must have required property '", key, "'"),
                            json::json!({"missingProperty":key}),
                        );
                    }
                }
            }
            let declared = object.get("properties").and_then(JsValue::as_object);
            let patterns = object.get("patternProperties").and_then(JsValue::as_object);
            if let Some(names) = object.get("propertyNames") {
                for (key, _) in entries(properties) {
                    let before = errors.len();
                    self.visit(names, &JsValue::String(key.clone()), path, errors);
                    if errors.len() != before {
                        push(
                            errors,
                            "propertyNames",
                            "property name must be valid".into(),
                            json::json!({"propertyName":key}),
                        );
                    }
                }
            }
            for (key, child) in entries(properties) {
                let known = declared.is_some_and(|p| {
                    key.as_str() != Some("__proto__") && p.get_utf16(key).is_some()
                }) || patterns
                    .is_some_and(|p| p.keys().any(|pattern| self.matches(pattern, key)));
                if !known && let Some(schema) = object.get("additionalProperties") {
                    if schema == &JsValue::Bool(false) {
                        push(
                            errors,
                            "additionalProperties",
                            "must NOT have additional properties".into(),
                            json::json!({"additionalProperty":key}),
                        );
                    } else {
                        self.visit(schema, child, &pointer(path, key), errors)
                    }
                }
            }
            for keyword in ["dependentRequired", "dependencies"] {
                if let Some(dependencies) = object.get(keyword).and_then(JsValue::as_object) {
                    for (key, dependency) in entries(dependencies) {
                        if data.lookup(key).is_some()
                            && let Some(deps) = dependency.as_array()
                        {
                            for missing in deps {
                                if let Some(missing) = missing.as_js_string()
                                    && properties.get_utf16(missing).is_none()
                                {
                                    let deps_text = deps
                                        .iter()
                                        .filter_map(JsValue::as_js_string)
                                        .cloned()
                                        .collect::<Vec<_>>();
                                    let mut units = vec![];
                                    for (i, key) in deps_text.iter().enumerate() {
                                        if i > 0 {
                                            units.extend(", ".encode_utf16())
                                        }
                                        units.extend(key.utf16())
                                    }
                                    push(
                                        errors,
                                        keyword,
                                        JsString::concat(&[
                                            "must have propert".into(),
                                            if deps.len() == 1 {
                                                "y ".into()
                                            } else {
                                                "ies ".into()
                                            },
                                            JsString::from_utf16(units.clone()),
                                            " when property ".into(),
                                            key.clone(),
                                            " is present".into(),
                                        ]),
                                        json::json!({"property":key,"missingProperty":missing,"depsCount":deps.len(),"deps":JsString::from_utf16(units)}),
                                    );
                                }
                            }
                        }
                    }
                }
            }
            if let Some(declared) = declared {
                for (key, child) in entries(declared) {
                    if key.as_str() == Some("__proto__") {
                        continue;
                    }
                    if let Some(value) = data.lookup(key) {
                        self.visit_data(child, value, &pointer(path, key), errors)
                    }
                }
            }
            if let Some(patterns) = patterns {
                for (pattern, child) in entries(patterns) {
                    for (key, value) in entries(properties) {
                        if self.matches(pattern, key) {
                            self.visit(child, value, &pointer(path, key), errors)
                        }
                    }
                }
            }
            if let Some(dependencies) = object.get("dependencies").and_then(JsValue::as_object) {
                for (key, child) in entries(dependencies) {
                    if !child.is_array() && data.lookup(key).is_some() {
                        self.visit_data(child, data, path, errors)
                    }
                }
            }
            if let Some(dependencies) = object.get("dependentSchemas").and_then(JsValue::as_object)
            {
                for (key, child) in entries(dependencies) {
                    if data.lookup(key).is_some() {
                        self.visit_data(child, data, path, errors)
                    }
                }
            }
            if let Some(child_schema) = object.get("unevaluatedProperties") {
                let evaluated = self.evaluated(schema, data, false).0;
                // Conditional annotations use Ajv's ordinary JS object map;
                // static annotations use literal key comparisons instead.
                let dynamic = self.dynamic_evaluated_props(schema, data);
                for (key, child) in entries(properties) {
                    if !evaluated.contains(key.utf16())
                        && !(dynamic && SchemaData::Prototype.lookup(key).is_some())
                    {
                        if child_schema == &JsValue::Bool(false) {
                            push(
                                errors,
                                "unevaluatedProperties",
                                "must NOT have unevaluated properties".into(),
                                json::json!({"unevaluatedProperty":key}),
                            );
                        } else {
                            self.visit(child_schema, child, &pointer(path, key), errors)
                        }
                    }
                }
            }
        }
    }
}
