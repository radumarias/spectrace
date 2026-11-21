#![allow(clippy::unwrap_used, clippy::expect_used)]
//! Job queue tests. Need `DATABASE_URL` (run `just db` first).
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};

use axum::{body::Body, http::Request, Router};
use futures_util::StreamExt;
use http_body_util::BodyExt;
use serde_json::{json, Value};
use spectrace_server::{app, jobs, AppState};
use sqlx::PgPool;
use tower::ServiceExt;
use uuid::Uuid;

fn router(pool: &PgPool) -> Router {
    app(AppState::new(pool.clone(), None))
}

async fn call(app: &Router, method: &str, uri: &str, body: Option<Value>) -> (u16, Value) {
    let mut req = Request::builder().method(method).uri(uri);
    let body = match body {
        Some(b) => {
            req = req.header("content-type", "application/json");
            Body::from(b.to_string())
        }
        None => Body::empty(),
    };
    let res = app.clone().oneshot(req.body(body).unwrap()).await.unwrap();
    let status = res.status().as_u16();
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    let v = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap()
    };
    (status, v)
}

/// Make a queued job claimable right now (skips the retry back-off).
async fn make_due(pool: &PgPool, id: Uuid) {
    sqlx::query("UPDATE jobs SET run_at = now() WHERE id = $1")
        .bind(id)
        .execute(pool)
        .await
        .unwrap();
}

// The task's "Done when": two workers, one queue, no job runs twice.
#[sqlx::test]
async fn two_workers_never_run_a_job_twice(pool: PgPool) {
    let project = Uuid::new_v4();
    const JOBS: usize = 60;
    for i in 0..JOBS {
        jobs::enqueue(&pool, project, "review", json!({ "n": i }), 3)
            .await
            .unwrap();
    }

    // job id -> workers that ran it
    let ran: Arc<Mutex<HashMap<Uuid, Vec<String>>>> = Arc::default();
    let mut handles = Vec::new();
    for w in ["worker-a", "worker-b"] {
        let (pool, ran) = (pool.clone(), ran.clone());
        handles.push(tokio::spawn(async move {
            let mut n = 0;
            while let Some(job) = jobs::claim(&pool, w, &[]).await.unwrap() {
                ran.lock()
                    .unwrap()
                    .entry(job.id)
                    .or_default()
                    .push(w.into());
                tokio::task::yield_now().await;
                jobs::complete(&pool, job.id, w, json!({})).await.unwrap();
                n += 1;
            }
            n
        }));
    }
    let mut total = 0;
    for h in handles {
        total += h.await.unwrap();
    }

    assert_eq!(total, JOBS, "every job ran exactly once in total");
    {
        let ran = ran.lock().unwrap();
        assert_eq!(ran.len(), JOBS);
        assert!(ran.values().all(|w| w.len() == 1), "a job ran twice");
    }
    let done: i64 =
        sqlx::query_scalar("SELECT count(*) FROM jobs WHERE status = 'succeeded' AND attempts = 1")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(done, JOBS as i64);
}

// Same check with simultaneous claims over HTTP, from four workers.
#[sqlx::test]
async fn parallel_http_claims_never_overlap(pool: PgPool) {
    let app = router(&pool);
    let project = Uuid::new_v4();
    for _ in 0..20 {
        jobs::enqueue(&pool, project, "review", json!({}), 3)
            .await
            .unwrap();
    }
    let mut handles = Vec::new();
    for w in 0..4 {
        let app = app.clone();
        handles.push(tokio::spawn(async move {
            let mut ids = Vec::new();
            loop {
                let body = json!({ "worker_id": format!("w{w}") });
                let (status, v) = call(&app, "POST", "/api/jobs/claim", Some(body)).await;
                if status == 204 {
                    return ids;
                }
                assert_eq!(status, 200);
                ids.push(v["id"].as_str().unwrap().to_string());
            }
        }));
    }
    let mut all = Vec::new();
    for h in handles {
        all.extend(h.await.unwrap());
    }
    let unique: std::collections::HashSet<_> = all.iter().collect();
    assert_eq!(all.len(), 20);
    assert_eq!(unique.len(), 20, "a job was handed to two workers");
}

#[sqlx::test]
async fn enqueue_validates_and_lists(pool: PgPool) {
    let app = router(&pool);
    let p = Uuid::new_v4();
    let uri = format!("/api/projects/{p}/jobs");

    let (s, job) = call(
        &app,
        "POST",
        &uri,
        Some(json!({ "kind": "review", "payload": { "pr": 7 } })),
    )
    .await;
    assert_eq!(s, 201);
    assert_eq!(job["status"], "queued");
    assert_eq!(job["max_attempts"], 3);
    assert_eq!(job["payload"]["pr"], 7);
    assert_eq!(job["project_id"], p.to_string());

    let (s, e) = call(&app, "POST", &uri, Some(json!({ "kind": "" }))).await;
    assert_eq!(s, 400);
    assert_eq!(e["error"]["code"], "bad_request");
    let (s, _) = call(
        &app,
        "POST",
        &uri,
        Some(json!({ "kind": "x", "max_attempts": 0 })),
    )
    .await;
    assert_eq!(s, 400);

    // Another project's jobs stay out of the list.
    jobs::enqueue(&pool, Uuid::new_v4(), "review", json!({}), 3)
        .await
        .unwrap();
    let (s, list) = call(&app, "GET", &uri, None).await;
    assert_eq!(s, 200);
    assert_eq!(list.as_array().unwrap().len(), 1);

    let id = job["id"].as_str().unwrap();
    let (s, got) = call(&app, "GET", &format!("/api/jobs/{id}"), None).await;
    assert_eq!(s, 200);
    assert_eq!(got["id"], job["id"]);
    let (s, _) = call(&app, "GET", &format!("/api/jobs/{}", Uuid::new_v4()), None).await;
    assert_eq!(s, 404);
}

#[sqlx::test]
async fn claim_respects_kinds_order_and_empty_queue(pool: PgPool) {
    let app = router(&pool);
    let p = Uuid::new_v4();
    let (s, _) = call(
        &app,
        "POST",
        "/api/jobs/claim",
        Some(json!({ "worker_id": "w" })),
    )
    .await;
    assert_eq!(s, 204);
    let (s, _) = call(
        &app,
        "POST",
        "/api/jobs/claim",
        Some(json!({ "worker_id": "" })),
    )
    .await;
    assert_eq!(s, 400);

    let first = jobs::enqueue(&pool, p, "review", json!({}), 3)
        .await
        .unwrap();
    let second = jobs::enqueue(&pool, p, "spec", json!({}), 3).await.unwrap();

    let (_, v) = call(
        &app,
        "POST",
        "/api/jobs/claim",
        Some(json!({ "worker_id": "w", "kinds": ["spec"] })),
    )
    .await;
    assert_eq!(v["id"], second.id.to_string());
    assert_eq!(v["status"], "running");
    assert_eq!(v["claimed_by"], "w");
    assert_eq!(v["attempts"], 1);

    let (_, v) = call(
        &app,
        "POST",
        "/api/jobs/claim",
        Some(json!({ "worker_id": "w" })),
    )
    .await;
    assert_eq!(v["id"], first.id.to_string());
}

#[sqlx::test]
async fn worker_calls_follow_the_job_through_its_life(pool: PgPool) {
    let app = router(&pool);
    let job = jobs::enqueue(&pool, Uuid::new_v4(), "review", json!({}), 3)
        .await
        .unwrap();
    let id = job.id;
    let me = json!({ "worker_id": "w1" });
    jobs::claim(&pool, "w1", &[]).await.unwrap().unwrap();

    let (s, v) = call(
        &app,
        "POST",
        &format!("/api/jobs/{id}/heartbeat"),
        Some(me.clone()),
    )
    .await;
    assert_eq!(s, 200);
    assert!(v["heartbeat_at"].is_string());

    let (s, _) = call(
        &app,
        "POST",
        &format!("/api/jobs/{id}/progress"),
        Some(json!({ "worker_id": "w1", "message": "checking out" })),
    )
    .await;
    assert_eq!(s, 200);

    // Someone else cannot touch it.
    let other = json!({ "worker_id": "w2" });
    for action in ["heartbeat", "complete"] {
        let (s, e) = call(
            &app,
            "POST",
            &format!("/api/jobs/{id}/{action}"),
            Some(other.clone()),
        )
        .await;
        assert_eq!(s, 409, "{action}");
        assert_eq!(e["error"]["code"], "conflict");
    }
    let (s, _) = call(
        &app,
        "POST",
        &format!("/api/jobs/{id}/progress"),
        Some(json!({ "worker_id": "w2", "message": "x" })),
    )
    .await;
    assert_eq!(s, 409);
    let (s, _) = call(
        &app,
        "POST",
        &format!("/api/jobs/{id}/fail"),
        Some(json!({ "worker_id": "w2", "error": "x" })),
    )
    .await;
    assert_eq!(s, 409);
    let (s, _) = call(
        &app,
        "POST",
        &format!("/api/jobs/{}/heartbeat", Uuid::new_v4()),
        Some(me.clone()),
    )
    .await;
    assert_eq!(s, 404);

    let (s, v) = call(
        &app,
        "POST",
        &format!("/api/jobs/{id}/complete"),
        Some(json!({ "worker_id": "w1", "result": { "ok": true } })),
    )
    .await;
    assert_eq!(s, 200);
    assert_eq!(v["status"], "succeeded");
    assert!(v["finished_at"].is_string());

    // A finished job cannot be completed or heartbeated again.
    let (s, _) = call(
        &app,
        "POST",
        &format!("/api/jobs/{id}/complete"),
        Some(me.clone()),
    )
    .await;
    assert_eq!(s, 409);
    let (s, _) = call(&app, "POST", &format!("/api/jobs/{id}/heartbeat"), Some(me)).await;
    assert_eq!(s, 409);
}

#[sqlx::test]
async fn failed_attempts_retry_with_backoff_then_fail(pool: PgPool) {
    let app = router(&pool);
    let job = jobs::enqueue(&pool, Uuid::new_v4(), "review", json!({}), 2)
        .await
        .unwrap();
    let id = job.id;

    jobs::claim(&pool, "w", &[]).await.unwrap().unwrap();
    let (s, v) = call(
        &app,
        "POST",
        &format!("/api/jobs/{id}/fail"),
        Some(json!({ "worker_id": "w", "error": "boom" })),
    )
    .await;
    assert_eq!(s, 200);
    assert_eq!(v["status"], "queued", "first failure retries");
    assert_eq!(v["error"], "boom");
    assert!(v["claimed_by"].is_null());
    assert!(
        jobs::claim(&pool, "w", &[]).await.unwrap().is_none(),
        "back-off keeps it unclaimable"
    );

    make_due(&pool, id).await;
    let again = jobs::claim(&pool, "w", &[]).await.unwrap().unwrap();
    assert_eq!(again.attempts, 2);
    let (_, v) = call(
        &app,
        "POST",
        &format!("/api/jobs/{id}/fail"),
        Some(json!({ "worker_id": "w", "error": "boom again" })),
    )
    .await;
    assert_eq!(v["status"], "failed", "out of attempts");
    assert!(v["finished_at"].is_string());
    make_due(&pool, id).await;
    assert!(jobs::claim(&pool, "w", &[]).await.unwrap().is_none());
}

#[sqlx::test]
async fn silent_workers_lose_their_jobs(pool: PgPool) {
    let p = Uuid::new_v4();
    let retry = jobs::enqueue(&pool, p, "review", json!({}), 2)
        .await
        .unwrap();
    jobs::claim(&pool, "dead", &[]).await.unwrap().unwrap();
    let last = jobs::enqueue(&pool, p, "review", json!({}), 1)
        .await
        .unwrap();
    jobs::claim(&pool, "dead", &[]).await.unwrap().unwrap();
    let alive = jobs::enqueue(&pool, p, "review", json!({}), 3)
        .await
        .unwrap();
    jobs::claim(&pool, "alive", &[]).await.unwrap().unwrap();

    // Age the two dead workers' heartbeats; leave the live one fresh.
    sqlx::query(
        "UPDATE jobs SET heartbeat_at = now() - interval '5 minutes' WHERE claimed_by = 'dead'",
    )
    .execute(&pool)
    .await
    .unwrap();

    let reaped = jobs::reap_stale(&pool, Duration::from_secs(60))
        .await
        .unwrap();
    assert_eq!(reaped.len(), 2);
    assert_eq!(
        jobs::get_job(&pool, retry.id).await.unwrap().status,
        "queued"
    );
    assert_eq!(
        jobs::get_job(&pool, last.id).await.unwrap().status,
        "failed"
    );
    assert_eq!(
        jobs::get_job(&pool, alive.id).await.unwrap().status,
        "running"
    );

    // The dead worker can no longer report on the job it lost.
    let err = jobs::heartbeat(&pool, retry.id, "dead").await.unwrap_err();
    assert_eq!(err.status(), 409);
    assert!(jobs::reap_stale(&pool, Duration::from_secs(60))
        .await
        .unwrap()
        .is_empty());
}

/// Read the stream until `want` has appeared (or 5 s pass); returns all text.
async fn read_until(
    body: &mut (impl futures_util::Stream<Item = Result<axum::body::Bytes, axum::Error>> + Unpin),
    seen: &mut String,
    want: &str,
) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while !seen.contains(want) {
            let chunk = body.next().await.expect("stream ended").unwrap();
            seen.push_str(std::str::from_utf8(&chunk).unwrap());
        }
    })
    .await
    .unwrap_or_else(|_| panic!("timed out waiting for {want:?}, got {seen:?}"));
}

#[sqlx::test]
async fn event_stream_replays_and_follows_one_project(pool: PgPool) {
    let app = router(&pool);
    let mine = Uuid::new_v4();
    let theirs = Uuid::new_v4();
    let job = jobs::enqueue(&pool, mine, "review", json!({}), 3)
        .await
        .unwrap();
    jobs::enqueue(&pool, theirs, "secret-kind", json!({}), 3)
        .await
        .unwrap();

    let res = app
        .clone()
        .oneshot(
            Request::get(format!("/api/projects/{mine}/jobs/events?after=0"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    assert_eq!(res.headers()["content-type"], "text/event-stream");
    let mut body = res.into_body().into_data_stream();
    let mut seen = String::new();

    // History is replayed...
    read_until(&mut body, &mut seen, "event: queued").await;
    // ...and new events arrive live.
    jobs::claim(&pool, "w", &[]).await.unwrap().unwrap();
    jobs::progress(&pool, job.id, "w", "halfway", json!({ "pct": 50 }))
        .await
        .unwrap();
    jobs::complete(&pool, job.id, "w", json!({})).await.unwrap();
    read_until(&mut body, &mut seen, "event: succeeded").await;

    let order: Vec<_> = [
        "event: queued",
        "event: started",
        "event: progress",
        "event: succeeded",
    ]
    .iter()
    .map(|e| seen.find(e).unwrap())
    .collect();
    assert!(
        order.windows(2).all(|w| w[0] < w[1]),
        "out of order: {seen}"
    );
    assert!(seen.contains("halfway"));
    assert!(
        !seen.contains("secret-kind"),
        "another project's events leaked"
    );
    assert!(!seen.contains(&theirs.to_string()));
}

#[sqlx::test]
async fn event_stream_starts_from_now_and_honours_last_event_id(pool: PgPool) {
    let app = router(&pool);
    let p = Uuid::new_v4();
    let old = jobs::enqueue(&pool, p, "old-job", json!({}), 3)
        .await
        .unwrap();
    let uri = format!("/api/projects/{p}/jobs/events");

    // No cursor: old history is skipped.
    let res = app
        .clone()
        .oneshot(Request::get(&uri).body(Body::empty()).unwrap())
        .await
        .unwrap();
    let mut body = res.into_body().into_data_stream();
    let mut seen = String::new();
    jobs::enqueue(&pool, p, "new-job", json!({}), 3)
        .await
        .unwrap();
    read_until(&mut body, &mut seen, "new-job").await;
    assert!(!seen.contains("old-job"));

    // Last-Event-ID resumes after that event, like a reconnecting browser.
    let first_id: i64 = sqlx::query_scalar("SELECT min(id) FROM job_events WHERE job_id = $1")
        .bind(old.id)
        .fetch_one(&pool)
        .await
        .unwrap();
    let res = app
        .clone()
        .oneshot(
            Request::get(&uri)
                .header("last-event-id", first_id.to_string())
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let mut body = res.into_body().into_data_stream();
    let mut seen = String::new();
    read_until(&mut body, &mut seen, "new-job").await;
    assert!(!seen.contains("old-job"));
}
