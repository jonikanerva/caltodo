//! Real answers against the OpenAPI document: each answered status of an
//! `/api` operation is documented with the answered content type, and each
//! JSON body has the documented required properties.

use axum::http::{Method, StatusCode};
use caltodo::application::ports::GoogleError;
use serde_json::{Value, json};
use sqlx::PgPool;

use crate::support::{Reply, TestApp, request, task_event};

fn document() -> Value {
    serde_json::from_str(&caltodo::http::openapi::document_json().unwrap()).unwrap()
}

/// Resolves a `$ref` of the document.
fn resolve<'a>(doc: &'a Value, schema: &'a Value) -> &'a Value {
    match schema["$ref"].as_str() {
        Some(reference) => {
            let name = reference.rsplit('/').next().unwrap();
            &doc["components"]["schemas"][name]
        }
        None => schema,
    }
}

/// Checks the JSON value against the required properties and the types of
/// the schema, recursively.
fn check(doc: &Value, schema: &Value, value: &Value, at: &str) {
    let schema = resolve(doc, schema);
    // Fail on a schema form that this checker does not read, so a new form
    // cannot pass without a check.
    for unsupported in ["allOf", "anyOf", "not", "nullable", "additionalProperties"] {
        assert!(
            schema.get(unsupported).is_none(),
            "{at}: unsupported {unsupported}"
        );
    }
    assert!(
        schema.get("type").is_some()
            || schema.get("oneOf").is_some()
            || schema.get("$ref").is_some(),
        "{at}: schema without a type: {schema}"
    );
    if let Some(options) = schema["oneOf"].as_array() {
        let matched = options.iter().any(|option| {
            let option = resolve(doc, option);
            match option["type"].as_str() {
                Some("null") => value.is_null(),
                _ => !value.is_null(),
            }
        });
        assert!(matched, "{at}: {value} matches no option");
        if !value.is_null() {
            let option = options
                .iter()
                .map(|option| resolve(doc, option))
                .find(|option| option["type"] != "null")
                .unwrap();
            check(doc, option, value, at);
        }
        return;
    }
    let types: Vec<&str> = match &schema["type"] {
        Value::String(single) => vec![single.as_str()],
        Value::Array(many) => many.iter().filter_map(Value::as_str).collect(),
        _ => vec![],
    };
    let kind = match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(number) if number.is_i64() || number.is_u64() => "integer",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    };
    if !types.is_empty() {
        assert!(
            types.contains(&kind) || (kind == "integer" && types.contains(&"number")),
            "{at}: {kind} not in {types:?}"
        );
    }
    if let Some(allowed) = schema["enum"].as_array() {
        assert!(allowed.contains(value), "{at}: {value} not in {allowed:?}");
    }
    if let (Some(required), Some(object)) = (schema["required"].as_array(), value.as_object()) {
        for name in required {
            assert!(
                object.contains_key(name.as_str().unwrap()),
                "{at}: missing {name}"
            );
        }
    }
    if let (Some(properties), Some(object)) = (schema["properties"].as_object(), value.as_object())
    {
        for (name, property) in properties {
            if let Some(field) = object.get(name) {
                check(doc, property, field, &format!("{at}.{name}"));
            }
        }
        for name in object.keys() {
            assert!(properties.contains_key(name), "{at}: undocumented {name}");
        }
    }
    if let (Some(items), Some(array)) = (schema.get("items"), value.as_array()) {
        for (index, item) in array.iter().enumerate() {
            check(doc, items, item, &format!("{at}[{index}]"));
        }
    }
}

fn assert_documented(doc: &Value, method: &Method, path: &str, reply: &Reply) {
    let operation = &doc["paths"][path][method.as_str().to_ascii_lowercase()];
    assert!(operation.is_object(), "{method} {path} is not documented");
    let status = reply.status.as_u16().to_string();
    let response = &operation["responses"][&status];
    assert!(
        response.is_object(),
        "{method} {path} {status} is not documented: {}",
        reply.text()
    );
    let content_type = reply.header("content-type").unwrap();
    let media = content_type.split(';').next().unwrap();
    let schema = &response["content"][media]["schema"];
    assert!(
        schema.is_object(),
        "{method} {path} {status}: {media} is not documented"
    );
    check(
        doc,
        schema,
        &reply.json(),
        &format!("{method} {path} {status}"),
    );
}

#[sqlx::test(migrator = "caltodo::db::MIGRATOR")]
async fn answers_match_the_document(pool: PgPool) {
    let doc = document();
    let app = TestApp::new(pool);
    let anonymous = app
        .send(request(Method::GET, "/api/auth/user").build())
        .await;
    assert_documented(&doc, &Method::GET, "/api/auth/user", &anonymous);

    let client = app.sign_in("sub-k", "k@example.com", "K").await;
    let mut cases: Vec<(Method, &str, String, Option<Value>)> = vec![
        (Method::GET, "/api/auth/user", "/api/auth/user".into(), None),
        (Method::GET, "/api/settings", "/api/settings".into(), None),
        (Method::GET, "/api/tasks", "/api/tasks".into(), None),
        (
            Method::POST,
            "/api/tasks",
            "/api/tasks".into(),
            Some(json!({"title": "T"})),
        ),
        (
            Method::POST,
            "/api/tasks/reload",
            "/api/tasks/reload".into(),
            None,
        ),
        (
            Method::POST,
            "/api/tasks/reschedule-all",
            "/api/tasks/reschedule-all".into(),
            None,
        ),
    ];
    cases.push((Method::GET, "/api/calendars", "/api/calendars".into(), None));
    for (method, template, path, body) in &cases {
        let mut builder = client.request(method.clone(), path);
        if let Some(body) = body {
            builder = builder.json(body);
        }
        let reply = app.send(builder.build()).await;
        assert_documented(&doc, method, template, &reply);
    }

    app.configure_calendar(&client, "UTC").await;
    app.calendars(&[("primary", "Main", true)]);
    app.calendar.put_event(
        "primary",
        task_event(
            "t1",
            "One",
            "2026-03-03T10:00:00Z",
            "2026-03-03T10:30:00Z",
            Some(false),
        ),
    );
    app.calendar.put_event(
        "primary",
        task_event(
            "t2",
            "Two",
            "2026-03-03T09:00:00Z",
            "2026-03-03T09:30:00Z",
            Some(true),
        ),
    );
    let calls: Vec<(Method, &str, String, Option<Value>)> = vec![
        (Method::GET, "/api/settings", "/api/settings".into(), None),
        (
            Method::PATCH,
            "/api/settings",
            "/api/settings".into(),
            Some(
                json!({"workStartHour": 8, "workEndHour": 18, "timezone": "UTC", "defaultDuration": 30, "eventColor": "1"}),
            ),
        ),
        (
            Method::PATCH,
            "/api/settings",
            "/api/settings".into(),
            Some(json!({})),
        ),
        (Method::GET, "/api/calendars", "/api/calendars".into(), None),
        (Method::GET, "/api/tasks", "/api/tasks".into(), None),
        (
            Method::POST,
            "/api/tasks",
            "/api/tasks".into(),
            Some(json!({"title": "New", "details": "D"})),
        ),
        (
            Method::POST,
            "/api/tasks",
            "/api/tasks".into(),
            Some(json!({"title": ""})),
        ),
        (
            Method::PATCH,
            "/api/tasks/{id}",
            "/api/tasks/t1".into(),
            Some(json!({"completed": true})),
        ),
        (
            Method::PATCH,
            "/api/tasks/{id}",
            "/api/tasks/none".into(),
            Some(json!({"completed": true})),
        ),
        (
            Method::PATCH,
            "/api/tasks/{id}",
            "/api/tasks/t1".into(),
            Some(json!({})),
        ),
        (
            Method::POST,
            "/api/tasks/reorder",
            "/api/tasks/reorder".into(),
            Some(json!({"taskIds": ["t1", "t2"]})),
        ),
        (
            Method::POST,
            "/api/tasks/reorder",
            "/api/tasks/reorder".into(),
            Some(json!({"taskIds": ["none"]})),
        ),
        (
            Method::POST,
            "/api/tasks/reorder",
            "/api/tasks/reorder".into(),
            Some(json!({"taskIds": []})),
        ),
        (
            Method::POST,
            "/api/tasks/bulk-complete",
            "/api/tasks/bulk-complete".into(),
            Some(json!({"taskIds": ["t1"]})),
        ),
        (
            Method::POST,
            "/api/tasks/reschedule-all",
            "/api/tasks/reschedule-all".into(),
            None,
        ),
        (
            Method::POST,
            "/api/tasks/reload",
            "/api/tasks/reload".into(),
            None,
        ),
        (
            Method::POST,
            "/api/tasks/{id}/complete",
            "/api/tasks/t1/complete".into(),
            None,
        ),
        (
            Method::POST,
            "/api/tasks/{id}/complete",
            "/api/tasks/none/complete".into(),
            None,
        ),
        (
            Method::POST,
            "/api/tasks/{id}/reschedule",
            "/api/tasks/t1/reschedule".into(),
            None,
        ),
        (
            Method::POST,
            "/api/tasks/{id}/reschedule",
            "/api/tasks/none/reschedule".into(),
            None,
        ),
        (
            Method::POST,
            "/api/action/{token}",
            "/api/action/unknown".into(),
            Some(json!({"action": "complete"})),
        ),
        (
            Method::POST,
            "/api/action/{token}",
            "/api/action/unknown".into(),
            Some(json!({"action": "x"})),
        ),
    ];
    for (method, template, path, body) in &calls {
        let mut builder = client.request(method.clone(), path);
        if let Some(body) = body {
            builder = builder.json(body);
        }
        let reply = app.send(builder.build()).await;
        assert_documented(&doc, method, template, &reply);
    }

    // Failure classes: Google, no slot, CSRF, body limit.
    app.calendar.fail_list(Some(GoogleError::Status(503)));
    let google = app
        .send(client.request(Method::GET, "/api/tasks").build())
        .await;
    assert_eq!(google.status, StatusCode::BAD_GATEWAY);
    assert_documented(&doc, &Method::GET, "/api/tasks", &google);
    let reload = app
        .send(client.request(Method::POST, "/api/tasks/reload").build())
        .await;
    assert_eq!(reload.status, StatusCode::BAD_GATEWAY);
    assert_documented(&doc, &Method::POST, "/api/tasks/reload", &reload);
    app.calendar.fail_list(None);
    sqlx::query("UPDATE user_settings SET work_start_hour = 17, work_end_hour = 9")
        .execute(&app.pool)
        .await
        .unwrap();
    let conflict = app
        .send(
            client
                .request(Method::POST, "/api/tasks")
                .json(&json!({"title": "T"}))
                .build(),
        )
        .await;
    assert_eq!(conflict.status, StatusCode::CONFLICT);
    assert_documented(&doc, &Method::POST, "/api/tasks", &conflict);
    let csrf = app
        .send(
            client
                .request(Method::POST, "/api/tasks/reload")
                .without_header("x-csrf-token")
                .build(),
        )
        .await;
    assert_documented(&doc, &Method::POST, "/api/tasks/reload", &csrf);
    let big = app
        .send(
            client
                .request(Method::POST, "/api/tasks")
                .json(&json!({"title": "a".repeat(110 * 1024)}))
                .build(),
        )
        .await;
    assert_documented(&doc, &Method::POST, "/api/tasks", &big);
    let logout = app
        .send(client.request(Method::POST, "/api/auth/logout").build())
        .await;
    assert_documented(&doc, &Method::POST, "/api/auth/logout", &logout);
}

#[sqlx::test(migrator = "caltodo::db::MIGRATOR")]
async fn account_deletion_matches_the_document(pool: PgPool) {
    let doc = document();
    let app = TestApp::new(pool);
    let client = app.sign_in("sub-d", "d@example.com", "D").await;
    let reply = app
        .send(client.request(Method::DELETE, "/api/account").build())
        .await;
    assert_documented(&doc, &Method::DELETE, "/api/account", &reply);
}

#[test]
fn every_operation_documents_its_problem_statuses() {
    let doc = document();
    let paths = doc["paths"].as_object().unwrap();
    assert_eq!(paths.len(), 14);
    for (path, item) in paths {
        for (method, operation) in item.as_object().unwrap() {
            let responses = operation["responses"].as_object().unwrap();
            assert!(responses.contains_key("200"), "{method} {path}");
            assert!(responses.contains_key("429"), "{method} {path}");
            assert!(responses.contains_key("500"), "{method} {path}");
            for (status, response) in responses {
                let media = if status == "200" {
                    "application/json"
                } else {
                    "application/problem+json"
                };
                assert!(
                    response["content"][media].is_object(),
                    "{method} {path} {status}"
                );
            }
        }
    }
}
