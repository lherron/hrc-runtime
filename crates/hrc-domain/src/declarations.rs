use serde_json::{Value, json};

/// Describe an operation's input fields for protocol 3 discovery.
pub(crate) fn described(mut declaration: Value) -> Value {
    for (name, field) in declaration["input"]["fields"]
        .as_object_mut()
        .expect("input fields")
    {
        field["description"] = json!(match name.as_str() {
            "session_ref" => "The HRC seat scope followed by /lane:main.",
            "host_session_id" => "The selected HRC host session identifier.",
            "expected_generation" => "The HRC generation that must still be current.",
            "fresh" => "Create a fresh seat, allowing HRC to suffix its name.",
            "continuation" => "Use resume to continue the seat's recorded conversation.",
            "request_id" => "The request identity HRC uses to replay a summon.",
            "provision" =>
                "Scalar profile overrides for this birth, such as {\"model\":\"fable\"}.",
            "text" => "The literal text to deliver to the seat.",
            "enter" => "Submit the literal text; defaults to true.",
            "delivery" => "Enqueue literal input or steer the current generation.",
            "principal_ref" => "The origin principal for an HRC steer submission.",
            "idempotency_key" => "The replay key passed verbatim to HRC's steer route.",
            "subject" => "Whether the annotation belongs to the seat or a generation.",
            "generation" => "The generation addressed by a generation annotation.",
            "ns" => "The annotation namespace.",
            "kind" => "The annotation kind within its namespace.",
            "id" => "The annotation identifier within its kind.",
            "body" => "The annotation body stored by HRC.",
            "expect" => "HRC annotation preconditions: generation, attentionAt or updatedAt.",
            "action" => "The action to append to the annotation ledger.",
            "attributes" => "The action's optional attributes.",
            _ => unreachable!("undescribed HRC field: {name}"),
        });
    }
    let seat = "agent:example:project:hrc-runtime:task:example/lane:main";
    let args = match declaration["name"].as_str().expect("operation name") {
        "seat.summon" => json!({"session_ref":seat,"request_id":"example-request"}),
        "seat.send" => {
            json!({"session_ref":seat,"host_session_id":"example-host-session","expected_generation":1,"text":"Continue the task."})
        }
        name => {
            let mut args = json!({"session_ref":seat,"subject":"seat","ns":"example","kind":"card","id":"one"});
            match name {
                "seat.annotation.put" => args["body"] = json!({"text":"Ready for review"}),
                "seat.annotation.act" => args["action"] = json!("sent"),
                "seat.annotation.delete" => (),
                _ => unreachable!("undeclared HRC operation: {name}"),
            }
            args
        }
    };
    declaration["examples"] = json!([{"args":args,"note":"Replace example seat and host identifiers with current HRC values."}]);
    declaration
}

/// The ops-only HRC provider.
pub fn declarations() -> Value {
    json!({"provider":"hrc","version":"1","node_families":[],"node_types":[],"operations":[crate::summon::declaration(),crate::send::declaration(),crate::annotation::put_declaration(),crate::annotation::act_declaration(),crate::annotation::delete_declaration()]})
}
