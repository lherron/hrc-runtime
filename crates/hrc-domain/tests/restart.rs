//! Contract cases precede implementation. Response sampled from installed HRC
//! on the throwaway cody restart-probe seat (T-11496/restart-live-response.json).
use hrc_domain::restart::Restart;
use serde_json::json;

#[test]
fn input_is_an_hrc_generation_fence_without_force() {
    let valid = json!({"host_session_id":"hsid-probe","expected_generation":2});
    assert_eq!(
        Restart::parse(valid.clone()).unwrap().request(),
        json!({"hostSessionId":"hsid-probe","expectedGeneration":2})
    );
    for bad in [
        json!({}),
        json!({"host_session_id":" ","expected_generation":2}),
        json!({"host_session_id":"hs","expected_generation":-1}),
        json!({"host_session_id":"hs","expected_generation":1.5}),
        json!({"host_session_id":"hs","expected_generation":"2"}),
        json!({"host_session_id":"hs","expected_generation":2,"force":true}),
        json!({"host_session_id":"hs","expected_generation":2,"document_id":"hrc"}),
    ] {
        assert!(Restart::parse(bad).is_err());
    }
}

#[test]
fn response_preserves_rotation_even_if_launch_failed() {
    let response = json!({"priorHostSessionId":"hsid-a3ce33e5-f076-49cb-b420-3c1397445d3e","hostSessionId":"hsid-f777b3b2-b6f9-401c-8edd-81fa3aca1534","generation":2,"launch":{"status":"started","runtimeId":"rt-77d20681-db48-4e87-b25d-bacca630ef1a"}});
    let receipt = Restart::receipt(response.clone()).unwrap();
    assert_eq!(receipt["generation"], 2);
    assert_eq!(receipt["host_session_id"], response["hostSessionId"]);
    assert_eq!(
        receipt["prior_host_session_id"],
        response["priorHostSessionId"]
    );
    assert_eq!(receipt["launch"], response["launch"]);
    let mut failed = response.clone();
    failed["launch"] = json!({"status":"failed","code":"LAUNCH_FAILED","message":"launch failed"});
    assert_eq!(
        Restart::receipt(failed.clone()).unwrap()["launch"],
        failed["launch"]
    );
    for field in [
        "hostSessionId",
        "priorHostSessionId",
        "generation",
        "launch",
    ] {
        let mut bad = response.clone();
        bad.as_object_mut().unwrap().remove(field);
        assert!(Restart::receipt(bad).is_err());
    }
    for launch in [
        json!({}),
        json!({"status":"started"}),
        json!({"status":"failed"}),
        json!({"status":"other"}),
    ] {
        let mut bad = response.clone();
        bad["launch"] = launch;
        assert!(Restart::receipt(bad).is_err());
    }
}
